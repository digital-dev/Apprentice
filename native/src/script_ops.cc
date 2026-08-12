#include "script_ops.h"

// NOTE: the vendored Lua is compiled as C++ — its sources are shipped with
// a .cpp extension precisely so that every compiler does so; see
// third_party/lua/apprentice_lua_config.h for why that is required. Its
// symbols therefore carry C++ linkage, and these headers must NOT be
// wrapped in `extern "C"` —
// doing so would declare C-linkage symbols that never get defined and the
// link would fail with unresolved externals for every lua_* function.
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

#include "value_type.h"
#include "chain_walk.h"

#include <windows.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <map>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

// The `state` handoff table, in plain C++ terms. RunScriptImpl and its
// helpers run on RunScriptWorker's BACKGROUND thread, where no N-API
// handle may be touched — so `state` crosses that boundary as this map,
// and only RunScriptWorker's constructor and OnOK() (both JS-thread-only)
// ever convert to/from a Napi::Object.
using LuaValueVariant = std::variant<std::string, double, bool>;
using LuaState = std::map<std::string, LuaValueVariant>;

namespace {

// Fixed byte budget for a single script run — generous for a trainer
// script, far below what would pressure Apprentice's own main process.
// See this plan's Global Constraints: the timeout alone is not enough,
// since an allocation loop can exhaust memory in well under 5 seconds.
constexpr size_t kMaxScriptBytes = 8 * 1024 * 1024;
constexpr int kTimeoutMs = 5000;
constexpr size_t kMaxOutputLines = 1000;
// Sanity cap on the incoming `state` table, enforced on the JS thread before
// anything is flattened. See RunScriptWorker's constructor.
constexpr size_t kMaxStateInBytes = 256 * 1024;

struct AllocBudget {
  size_t used = 0;
};

void* BudgetAlloc(void* ud, void* ptr, size_t osize, size_t nsize) {
  AllocBudget* budget = static_cast<AllocBudget*>(ud);
  if (nsize == 0) {
    if (ptr) {
      budget->used -= osize;
      free(ptr);
    }
    return nullptr;
  }
  size_t delta = nsize > osize ? nsize - osize : 0;
  // `ptr == nullptr` means a fresh allocation, where Lua passes the type
  // tag of the object being created in `osize` rather than a real size, so
  // the whole of `nsize` is new.
  if (ptr == nullptr) delta = nsize;
  if (budget->used + delta > kMaxScriptBytes) return nullptr;  // OOM -> Lua raises a clean error
  void* result = realloc(ptr, nsize);
  if (!result) return nullptr;
  budget->used += delta;
  if (ptr != nullptr && nsize < osize) budget->used -= (osize - nsize);
  return result;
}

struct TimeoutState {
  std::chrono::steady_clock::time_point deadline;
  // Sticky: once the deadline has tripped even once, this run is a failure
  // no matter what the script does afterwards. The Lua error raised by
  // TimeoutHook is an ordinary Lua error, so a script can swallow it with
  // pcall and carry on; without this flag such a script would be reported
  // as `success: true`, which would be a lie. See RunScriptImpl.
  bool timedOut = false;
};

// The lua_State's extra space is only sizeof(void*) by default, so it holds
// a *pointer* to the run's TimeoutState (which lives on RunScriptImpl's
// stack) rather than the state itself. That keeps the arrangement working
// as more per-run state accumulates in Task 4.
static_assert(sizeof(TimeoutState*) <= LUA_EXTRASPACE,
              "a TimeoutState* must fit in the lua_State's extra space");

const char kTimeoutMessage[] = "script exceeded its 5-second execution limit";

// LUA_MASKCOUNT hook: checked every 1000 VM instructions rather than every
// single one, to keep the check's own overhead negligible. Re-arms itself
// implicitly (lua_sethook with LUA_MASKCOUNT re-fires every `count`
// instructions for the lifetime of the state) rather than assuming a
// one-shot install persists — this hook is installed once per run in
// RunScriptImpl and stays armed for that run's whole lifetime.
void TimeoutHook(lua_State* L, lua_Debug*) {
  TimeoutState* state = *static_cast<TimeoutState**>(lua_getextraspace(L));
  if (std::chrono::steady_clock::now() >= state->deadline) {
    // Record the trip BEFORE raising: luaL_error does not return, and the
    // error it raises is catchable by the script's own pcall.
    state->timedOut = true;
    luaL_error(L, "%s", kTimeoutMessage);
  }
}

// A hand-built 3-function os table — NOT the real os library (which
// includes os.execute/os.exit/os.remove/os.rename/io access). See this
// plan's Global Constraints: os.execute/os.exit/io/debug/package are never
// registered at all, not merely deleted after registration.
int LuaOsTime(lua_State* L) {
  lua_pushinteger(L, static_cast<lua_Integer>(time(nullptr)));
  return 1;
}
int LuaOsClock(lua_State* L) {
  lua_pushnumber(L, static_cast<lua_Number>(clock()) / CLOCKS_PER_SEC);
  return 1;
}
int LuaOsDate(lua_State* L) {
  time_t now = time(nullptr);
  char buf[64] = {0};
  struct tm parts;
#if defined(_WIN32)
  bool ok = localtime_s(&parts, &now) == 0;
#else
  bool ok = localtime_r(&now, &parts) != nullptr;
#endif
  if (ok) strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &parts);
  lua_pushstring(L, buf);
  return 1;
}

struct OutputCollector {
  std::vector<std::string> lines;
  bool truncated = false;
};

int LuaPrint(lua_State* L) {
  OutputCollector* out =
      static_cast<OutputCollector*>(lua_touserdata(L, lua_upvalueindex(1)));
  int n = lua_gettop(L);
  std::string line;
  for (int i = 1; i <= n; i++) {
    if (i > 1) line += "\t";
    size_t len;
    const char* s = luaL_tolstring(L, i, &len);
    line.append(s, len);
    lua_pop(L, 1);
  }
  if (out->lines.size() < kMaxOutputLines) {
    out->lines.push_back(line);
  } else if (!out->truncated) {
    out->lines.push_back("... output truncated at 1000 lines ...");
    out->truncated = true;
  }
  return 0;
}

// Every bound memory function reads its HANDLE from the Lua registry
// (set once per run in RunScriptImpl) rather than threading it through
// every call's arguments — Lua scripts only ever touch ONE process per
// run, so this keeps the exposed Lua signature to just (address, ...).
HANDLE HandleFromRegistry(lua_State* L) {
  lua_getfield(L, LUA_REGISTRYINDEX, "apprentice_handle");
  HANDLE h = reinterpret_cast<HANDLE>(lua_touserdata(L, -1));
  lua_pop(L, 1);
  return h;
}

int LuaReadValue(lua_State* L, ValueKind kind, size_t size) {
  uintptr_t address = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
  HANDLE h = HandleFromRegistry(L);
  uint8_t buf[8];
  SIZE_T read;
  if (!ReadProcessMemory(h, (LPCVOID)address, buf, size, &read) || read != size) {
    return luaL_error(L, "read failed at 0x%llx", (unsigned long long)address);
  }
  double value = InterpretAsDouble(buf, ValueSpec{size, kind});
  // Push whole-number kinds as Lua integers, not floats: Lua 5.4's tostring
  // (and print, which goes through it) renders a whole-number float as
  // "12345.0" to keep it visually distinct from an integer, which would
  // surprise a script author reading back an int8/16/32/64 value. Only the
  // genuinely fractional float/double kinds go through lua_pushnumber.
  if (!IsFloatKind(kind)) {
    int64_t raw;
    if (kind == ValueKind::Int64) {
      memcpy(&raw, buf, sizeof(raw));
    } else {
      raw = static_cast<int64_t>(value);
    }
    lua_pushinteger(L, raw);
  } else {
    lua_pushnumber(L, value);
  }
  return 1;
}

int LuaWriteValue(lua_State* L, ValueKind kind, size_t size) {
  uintptr_t address = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
  HANDLE h = HandleFromRegistry(L);
  uint8_t buf[8];
  // Int64 must never touch the `double` path: a double carries only 53 bits
  // of mantissa, so an int64 above 2^53 (a currency/XP counter, a packed
  // handle) would be silently rounded on its way to memory. Lua 5.4 has
  // native 64-bit integers, so luaL_checkinteger + a raw memcpy is exact.
  // This mirrors LuaReadValue, which already splits on IsFloatKind for the
  // same reason on the way back out.
  if (kind == ValueKind::Int64) {
    int64_t raw = static_cast<int64_t>(luaL_checkinteger(L, 2));
    memcpy(buf, &raw, sizeof(raw));
  } else {
    double value = luaL_checknumber(L, 2);
    EncodeFromDouble(value, ValueSpec{size, kind}, buf);
  }
  SIZE_T written;
  bool ok = WriteProcessMemory(h, (LPVOID)address, buf, size, &written) && written == size;
  lua_pushboolean(L, ok);
  return 1;
}

int LuaReadInt8(lua_State* L)   { return LuaReadValue(L, ValueKind::UInt8, 1); }
int LuaReadInt16(lua_State* L)  { return LuaReadValue(L, ValueKind::Int16, 2); }
int LuaReadInt32(lua_State* L)  { return LuaReadValue(L, ValueKind::Int32, 4); }
int LuaReadInt64(lua_State* L)  { return LuaReadValue(L, ValueKind::Int64, 8); }
int LuaReadFloat(lua_State* L)  { return LuaReadValue(L, ValueKind::Float, 4); }
int LuaReadDouble(lua_State* L) { return LuaReadValue(L, ValueKind::Double, 8); }
int LuaWriteInt8(lua_State* L)   { return LuaWriteValue(L, ValueKind::UInt8, 1); }
int LuaWriteInt16(lua_State* L)  { return LuaWriteValue(L, ValueKind::Int16, 2); }
int LuaWriteInt32(lua_State* L)  { return LuaWriteValue(L, ValueKind::Int32, 4); }
int LuaWriteInt64(lua_State* L)  { return LuaWriteValue(L, ValueKind::Int64, 8); }
int LuaWriteFloat(lua_State* L)  { return LuaWriteValue(L, ValueKind::Float, 4); }
int LuaWriteDouble(lua_State* L) { return LuaWriteValue(L, ValueKind::Double, 8); }

// Raw, binary-safe Lua strings — NOT hex, and NOT patch_ops.cc's
// ReadBytes/WriteBytes (see this plan's Global Constraints on why those
// aren't reused here).
int LuaReadBytes(lua_State* L) {
  uintptr_t address = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
  size_t length = static_cast<size_t>(luaL_checkinteger(L, 2));
  if (length == 0 || length > 4096) return luaL_error(L, "readBytes length must be 1..4096");
  HANDLE h = HandleFromRegistry(L);
  std::vector<uint8_t> buf(length);
  SIZE_T read;
  if (!ReadProcessMemory(h, (LPCVOID)address, buf.data(), length, &read) || read != length) {
    return luaL_error(L, "read failed at 0x%llx", (unsigned long long)address);
  }
  lua_pushlstring(L, reinterpret_cast<const char*>(buf.data()), length);
  return 1;
}

int LuaWriteBytes(lua_State* L) {
  uintptr_t address = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
  size_t length;
  const char* data = luaL_checklstring(L, 2, &length);
  HANDLE h = HandleFromRegistry(L);
  SIZE_T written;
  bool ok = WriteProcessMemory(h, (LPVOID)address, data, length, &written) && written == length;
  lua_pushboolean(L, ok);
  return 1;
}

// resolvePointer(moduleName, {offsets}) -> integer | nil. Uses the same
// forward walk (chain_walk.h's ResolveChain) memory_ops.cc uses, against
// the module base FindModuleBase looks up in the attached process.
int LuaResolvePointer(lua_State* L) {
  const char* moduleName = luaL_checkstring(L, 1);
  luaL_checktype(L, 2, LUA_TTABLE);
  std::vector<uintptr_t> offsets;
  lua_Integer n = luaL_len(L, 2);
  for (lua_Integer i = 1; i <= n; i++) {
    lua_geti(L, 2, i);
    offsets.push_back(static_cast<uintptr_t>(luaL_checkinteger(L, -1)));
    lua_pop(L, 1);
  }
  HANDLE h = HandleFromRegistry(L);
  auto base = FindModuleBase(h, moduleName);
  if (!base) { lua_pushnil(L); return 1; }
  auto resolved = ResolveChain(h, *base, offsets);
  if (!resolved) { lua_pushnil(L); return 1; }
  lua_pushinteger(L, static_cast<lua_Integer>(*resolved));
  return 1;
}

// Seeds the Lua global `state` table from a flat map (string/number/
// boolean values only), for the enable->disable value handoff the spec
// requires (e.g. `state.original = readInt32(addr)` in enableScript,
// read back in disableScript). Called once per run, before the loaded
// chunk executes.
void SeedStateTable(lua_State* L, const LuaState& stateIn) {
  lua_newtable(L);
  for (const auto& [key, value] : stateIn) {
    std::visit(
        [&](auto&& v) {
          using T = std::decay_t<decltype(v)>;
          if constexpr (std::is_same_v<T, std::string>) {
            lua_pushstring(L, v.c_str());
          } else if constexpr (std::is_same_v<T, double>) {
            // Push a whole number back as a Lua *integer*, not a float, for
            // the same reason LuaReadValue does: Lua 5.4's tostring renders
            // a whole-number float as "42.0", so `state.original = 42`
            // followed by `print(state.original)` on the next run would
            // otherwise come back as "42.0". A value only becomes a double
            // here because LuaState carries every number as one.
            // The range guard matters: casting an out-of-range double to an
            // integer type is undefined behaviour, not a wrap.
            constexpr double kIntMin = -9223372036854775808.0;
            constexpr double kIntMax = 9223372036854775808.0;  // 2^63, exclusive
            if (v >= kIntMin && v < kIntMax &&
                static_cast<double>(static_cast<lua_Integer>(v)) == v) {
              lua_pushinteger(L, static_cast<lua_Integer>(v));
            } else {
              lua_pushnumber(L, v);
            }
          } else {
            lua_pushboolean(L, v);
          }
        },
        value);
    lua_setfield(L, -2, key.c_str());
  }
  lua_setglobal(L, "state");
}

// Reads the `state` global back out after the run, for the caller's
// stateOut — only string/number/boolean values are collected; anything
// else the script stored in `state` (a nested table, a function) is
// silently dropped, per this plan's Global Constraints on `state`'s scope.
LuaState ReadStateTable(lua_State* L) {
  LuaState out;
  lua_getglobal(L, "state");
  if (lua_istable(L, -1)) {
    lua_pushnil(L);
    while (lua_next(L, -2) != 0) {
      if (lua_type(L, -2) == LUA_TSTRING) {
        std::string key = lua_tostring(L, -2);
        if (lua_isboolean(L, -1)) {
          out[key] = static_cast<bool>(lua_toboolean(L, -1));
        } else if (lua_isnumber(L, -1)) {
          out[key] = static_cast<double>(lua_tonumber(L, -1));
        } else if (lua_isstring(L, -1)) {
          out[key] = std::string(lua_tostring(L, -1));
        }
      }
      lua_pop(L, 1);
    }
  }
  lua_pop(L, 1);
  return out;
}

// WARNING: this is the ONLY function that may populate a script state's
// globals. Never call luaL_openlibs — it is linked into this binary (see
// third_party/lua/linit.cpp) and a single call to it would open io, os,
// package and debug and undo this entire allowlist.
//
// Opens exactly base (minus dofile/loadfile/load/collectgarbage) + string
// + table + math + the 3-function os table above. debug/io/package are
// never luaL_requiref'd, so their globals never exist in this state at
// all — see this plan's Global Constraints.
void OpenAllowlistedLibs(lua_State* L, OutputCollector* out) {
  luaL_requiref(L, LUA_GNAME, luaopen_base, 1);
  lua_pop(L, 1);
  lua_pushnil(L);
  lua_setglobal(L, "dofile");
  lua_pushnil(L);
  lua_setglobal(L, "loadfile");
  lua_pushnil(L);
  lua_setglobal(L, "load");
  lua_pushnil(L);
  lua_setglobal(L, "collectgarbage");

  luaL_requiref(L, LUA_STRLIBNAME, luaopen_string, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_TABLIBNAME, luaopen_table, 1);
  lua_pop(L, 1);
  luaL_requiref(L, LUA_MATHLIBNAME, luaopen_math, 1);
  lua_pop(L, 1);

  lua_newtable(L);
  lua_pushcfunction(L, LuaOsTime);
  lua_setfield(L, -2, "time");
  lua_pushcfunction(L, LuaOsClock);
  lua_setfield(L, -2, "clock");
  lua_pushcfunction(L, LuaOsDate);
  lua_setfield(L, -2, "date");
  lua_setglobal(L, "os");

  lua_pushlightuserdata(L, out);
  lua_pushcclosure(L, LuaPrint, 1);
  lua_setglobal(L, "print");

  const struct { const char* name; lua_CFunction fn; } memoryFns[] = {
    {"readInt8", LuaReadInt8}, {"readInt16", LuaReadInt16}, {"readInt32", LuaReadInt32},
    {"readInt64", LuaReadInt64}, {"readFloat", LuaReadFloat}, {"readDouble", LuaReadDouble},
    {"writeInt8", LuaWriteInt8}, {"writeInt16", LuaWriteInt16}, {"writeInt32", LuaWriteInt32},
    {"writeInt64", LuaWriteInt64}, {"writeFloat", LuaWriteFloat}, {"writeDouble", LuaWriteDouble},
    {"readBytes", LuaReadBytes}, {"writeBytes", LuaWriteBytes},
  };
  for (const auto& entry : memoryFns) {
    lua_pushcfunction(L, entry.fn);
    lua_setglobal(L, entry.name);
  }

  lua_pushcfunction(L, LuaResolvePointer);
  lua_setglobal(L, "resolvePointer");
}

struct ScriptResult {
  bool success = false;
  std::vector<std::string> output;
  std::string error;
  LuaState stateOut;
};

// The timeout error TimeoutHook raises is an ordinary Lua error, so a
// script can catch it: `while true do pcall(function() while true do end
// end) end` swallows it on every iteration and would otherwise be reported
// as a clean success. Once the deadline has tripped, the run is a failure —
// overwrite whatever the script's own error handling concluded.
//
// NOTE: this makes the *reported outcome* honest, it does not stop the
// spin. As of Task 5 the run happens on a libuv worker thread
// (RunScriptWorker), so a pcall-wrapped infinite loop no longer freezes
// the JS thread — but it does still occupy its worker thread until the
// process exits, because the Lua-level hook can only raise a catchable
// error. A hard wall-clock abort of the worker is still outstanding.
void ApplyStickyTimeout(const TimeoutState& timeout, ScriptResult& result) {
  if (!timeout.timedOut) return;
  result.success = false;
  result.error = kTimeoutMessage;
}

// Closes the lua_State on every exit path out of RunScriptImpl — the normal
// returns, the early load-failure return, AND the catch(...) below. Without
// this, the catch path would leak the whole state (and its allocator budget)
// on every escaped error. lua_close itself can run __gc metamethods and
// allocate, so it can in principle raise; a destructor is noexcept by
// default, and an exception escaping one is an immediate std::terminate —
// exactly the crash this guard exists to prevent — hence the inner catch.
struct LuaStateGuard {
  lua_State* L;
  ~LuaStateGuard() {
    if (!L) return;
    try {
      lua_close(L);
    } catch (...) {
      // Nothing safe left to do: the state is already being torn down.
    }
  }
};

// Runs entirely on RunScriptWorker's background thread: every type it
// touches is plain C++ (HANDLE/std::string/LuaState) — never a Napi value.
//
// CRASH SAFETY: the vendored Lua is compiled as C++, so a Lua error is a
// real C++ exception (LUAI_THROW). Everything below that runs OUTSIDE a
// lua_pcall — OpenAllowlistedLibs (luaL_requiref does an unprotected
// lua_call), SeedStateTable (which allocates, and so can hit the allocator
// budget on a large stateIn), ReadStateTable — can therefore throw. This
// function is called from RunScriptWorker::Execute(), and because
// NAPI_DISABLE_CPP_EXCEPTIONS is defined, node-addon-api does NOT wrap
// Execute() in a try/catch: an escaped exception would unwind straight out
// of the libuv worker thread into std::terminate and kill the whole Electron
// process. That is not merely an ugly crash — per ipc.ts's releaseTarget(),
// dying with a write-watch armed leaves the target game primed to raise a
// debug exception with no debugger attached, which takes the game down too.
// So: catch everything here, report it as an ordinary failed run.
ScriptResult RunScriptImpl(HANDLE handle, const std::string& source,
                           const LuaState& stateIn) {
  ScriptResult result;
  AllocBudget budget;
  lua_State* L = lua_newstate(BudgetAlloc, &budget);
  if (!L) {
    result.error = "could not allocate Lua state";
    return result;
  }
  LuaStateGuard guard{L};

  try {
    lua_pushlightuserdata(L, reinterpret_cast<void*>(handle));
    lua_setfield(L, LUA_REGISTRYINDEX, "apprentice_handle");

    TimeoutState timeout;
    timeout.deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(kTimeoutMs);
    *static_cast<TimeoutState**>(lua_getextraspace(L)) = &timeout;
    lua_sethook(L, TimeoutHook, LUA_MASKCOUNT, 1000);

    OutputCollector out;
    OpenAllowlistedLibs(L, &out);
    SeedStateTable(L, stateIn);

    int loadStatus = luaL_loadstring(L, source.c_str());
    if (loadStatus != LUA_OK) {
      const char* msg = lua_tostring(L, -1);
      result.error = msg ? msg : "could not compile script";
      result.output = out.lines;
      ApplyStickyTimeout(timeout, result);
      result.stateOut = ReadStateTable(L);
      return result;
    }

    int callStatus = lua_pcall(L, 0, 0, 0);
    result.success = callStatus == LUA_OK;
    if (!result.success) {
      const char* msg = lua_tostring(L, -1);
      result.error = msg ? msg : "unknown Lua error";
    }
    result.output = out.lines;
    ApplyStickyTimeout(timeout, result);
    result.stateOut = ReadStateTable(L);
    return result;
  } catch (...) {
    result.success = false;
    result.error = "script setup failed (out of memory or an internal Lua error)";
    // Whatever was half-collected is not trustworthy after an escaped error.
    result.stateOut.clear();
    return result;
  }
}

// Runs the script on a libuv worker thread, the same shape patch_ops.cc's
// ScanAobWorker uses. THREAD BOUNDARY: the constructor and OnOK()/OnError()
// run on the JS thread and are the only places that may touch a Napi value;
// Execute() runs on the worker thread and touches only the already-flattened
// plain-C++ members (handle_/source_/flatStateIn_/result_).
class RunScriptWorker : public Napi::AsyncWorker {
 public:
  RunScriptWorker(Napi::Env env, HANDLE handle, std::string source, const Napi::Object& stateIn)
      : Napi::AsyncWorker(env),
        handle_(handle),
        source_(std::move(source)),
        deferred_(Napi::Promise::Deferred::New(env)) {
    // JS thread, before Queue(): flatten stateIn out of N-API entirely, so
    // Execute() never needs the Env.
    Napi::Array keys = stateIn.GetPropertyNames();
    size_t total = 0;
    for (uint32_t i = 0; i < keys.Length(); i++) {
      std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
      Napi::Value value = stateIn.Get(key);
      total += key.size();
      if (value.IsString()) {
        std::string s = value.As<Napi::String>().Utf8Value();
        total += s.size();
        flatStateIn_[key] = std::move(s);
      } else if (value.IsNumber()) {
        total += sizeof(double);
        flatStateIn_[key] = value.As<Napi::Number>().DoubleValue();
      } else if (value.IsBoolean()) {
        total += sizeof(bool);
        flatStateIn_[key] = value.As<Napi::Boolean>().Value();
      }
      // else: skipped, per ReadStateTable's matching scope limit above.
      if (total > kMaxStateInBytes) {
        // Refuse here, on the JS thread, rather than letting a multi-megabyte
        // `state` reach SeedStateTable and exhaust kMaxScriptBytes mid-setup:
        // that failure happens OUTSIDE any lua_pcall and is far more
        // expensive to recover from (see RunScriptImpl's crash-safety note).
        // `state` is a handful of captured values — a few hundred KB is
        // already absurdly generous.
        flatStateIn_.clear();
        stateInTooLarge_ = true;
        return;
      }
    }
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    if (stateInTooLarge_) {
      result_.success = false;
      result_.error =
          "state is too large to hand to the script (limit 256 KB) — store "
          "only the few values the disable script needs";
      return;
    }
    result_ = RunScriptImpl(handle_, source_, flatStateIn_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object out = Napi::Object::New(env);
    out.Set("success", Napi::Boolean::New(env, result_.success));
    Napi::Array output = Napi::Array::New(env, result_.output.size());
    for (size_t i = 0; i < result_.output.size(); i++) {
      output.Set(static_cast<uint32_t>(i), Napi::String::New(env, result_.output[i]));
    }
    out.Set("output", output);
    out.Set("error", result_.success
                         ? env.Null()
                         : Napi::Value(Napi::String::New(env, result_.error)));
    Napi::Object stateOut = Napi::Object::New(env);
    // Deliberately not a structured binding: capturing one in the lambda
    // below is a C++20 extension this build warns about.
    for (const auto& entry : result_.stateOut) {
      const std::string& key = entry.first;
      std::visit([&](auto&& v) { stateOut.Set(key, Napi::Value::From(env, v)); }, entry.second);
    }
    out.Set("stateOut", stateOut);
    deferred_.Resolve(out);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  std::string source_;
  LuaState flatStateIn_;
  bool stateInTooLarge_ = false;
  ScriptResult result_;
  Napi::Promise::Deferred deferred_;
};

}  // namespace

// runScript(handle, source, stateIn) -> Promise<{success, output, error,
// stateOut}>. The handle is threaded through so the bound memory globals
// (readInt32/writeInt32/resolvePointer/etc., registered in
// OpenAllowlistedLibs) know which process to touch. The run itself happens
// on a background thread (RunScriptWorker), so a script that spins for its
// full 5-second cap — or blocks on an unresponsive target — no longer
// freezes Electron's main thread.
Napi::Value RunScript(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "runScript(handle: number, source: string, stateIn?: object) expects a number and a string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string source = info[1].As<Napi::String>().Utf8Value();
  Napi::Object stateIn = info.Length() > 2 && info[2].IsObject()
                             ? info[2].As<Napi::Object>()
                             : Napi::Object::New(env);

  auto* worker = new RunScriptWorker(env, h, std::move(source), stateIn);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

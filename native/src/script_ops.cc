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

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

namespace {

// Fixed byte budget for a single script run — generous for a trainer
// script, far below what would pressure Apprentice's own main process.
// See this plan's Global Constraints: the timeout alone is not enough,
// since an allocation loop can exhaust memory in well under 5 seconds.
constexpr size_t kMaxScriptBytes = 8 * 1024 * 1024;
constexpr int kTimeoutMs = 5000;
constexpr size_t kMaxOutputLines = 1000;

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
}

struct ScriptResult {
  bool success = false;
  std::vector<std::string> output;
  std::string error;
};

// The timeout error TimeoutHook raises is an ordinary Lua error, so a
// script can catch it: `while true do pcall(function() while true do end
// end) end` swallows it on every iteration and would otherwise be reported
// as a clean success. Once the deadline has tripped, the run is a failure —
// overwrite whatever the script's own error handling concluded.
//
// NOTE FOR TASK 4: this makes the *reported outcome* honest, it does not
// stop the spin. RunScript is still synchronous, so a pcall-wrapped
// infinite loop still blocks the calling thread indefinitely (measured at
// 45s+ before being killed manually). Task 4's move to an Napi::AsyncWorker
// is therefore not merely an optimisation — it is the load-bearing half of
// this fix, and must come with a hard wall-clock abort of the worker rather
// than relying on the Lua-level hook alone.
void ApplyStickyTimeout(const TimeoutState& timeout, ScriptResult& result) {
  if (!timeout.timedOut) return;
  result.success = false;
  result.error = kTimeoutMessage;
}

ScriptResult RunScriptImpl(const std::string& source) {
  ScriptResult result;
  AllocBudget budget;
  lua_State* L = lua_newstate(BudgetAlloc, &budget);
  if (!L) {
    result.error = "could not allocate Lua state";
    return result;
  }

  TimeoutState timeout;
  timeout.deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(kTimeoutMs);
  *static_cast<TimeoutState**>(lua_getextraspace(L)) = &timeout;
  lua_sethook(L, TimeoutHook, LUA_MASKCOUNT, 1000);

  OutputCollector out;
  OpenAllowlistedLibs(L, &out);

  int loadStatus = luaL_loadstring(L, source.c_str());
  if (loadStatus != LUA_OK) {
    const char* msg = lua_tostring(L, -1);
    result.error = msg ? msg : "could not compile script";
    result.output = out.lines;
    ApplyStickyTimeout(timeout, result);
    lua_close(L);
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
  lua_close(L);
  return result;
}

}  // namespace

// This task's RunScript takes only a source string and runs it — no
// memory bindings, no state handoff, no async worker yet. Those are added
// in Tasks 4-5. Synchronous for now; Task 4 wraps this in an
// Napi::AsyncWorker once there's real per-process work worth offloading.
Napi::Value RunScript(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "runScript(source: string) expects a string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string source = info[0].As<Napi::String>().Utf8Value();

  ScriptResult result = RunScriptImpl(source);

  Napi::Object out = Napi::Object::New(env);
  out.Set("success", Napi::Boolean::New(env, result.success));
  Napi::Array output = Napi::Array::New(env, result.output.size());
  for (size_t i = 0; i < result.output.size(); i++) {
    output.Set(static_cast<uint32_t>(i), Napi::String::New(env, result.output[i]));
  }
  out.Set("output", output);
  out.Set("error", result.success
                       ? env.Null()
                       : Napi::Value(Napi::String::New(env, result.error)));
  return out;
}

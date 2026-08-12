# Lua Scripting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third stored-cheat kind — `ScriptCheat` — whose enable/disable are one-shot Lua scripts run against the attached process, with a minimal, explicitly-allowlisted memory read/write API, an execution timeout, a memory cap, and an editor panel in the cheat list.

**Architecture:** Lua 5.4's C sources are vendored into the native addon and compiled as C++ (so `lua_error` unwinds as a C++ exception, not a `longjmp`, and can't skip destructors in bound functions). A new `script_ops.cc` binds a small, explicitly-allowlisted global environment (no `debug`/`io`/`os.execute`/`package`) and runs scripts on a background thread via `Napi::AsyncWorker`, the same pattern `scanAob`/`resolvePointerChain` already use. A new main-process `ScriptRuntime` (modeled on `FreezeLoop`'s shape, but async and fallible) owns the enabled-script set and per-cheat `state` handoff between enable/disable. `hotkeys.ts` gains a third fire branch; `CheatList.tsx` gains a `ScriptEditor` panel.

**Tech Stack:** TypeScript/React (renderer), TypeScript (main/IPC), C++ N-API (native addon), vendored Lua 5.4, Vitest.

## Global Constraints

- `ScriptCheat` has no `mode`/`dataType`/`targets` — its only state is which script last ran, tracked the way `FreezeLoop` tracks freeze state.
- The Lua environment is an explicit allowlist: `base` (minus `dofile`/`loadfile`/`load`/`collectgarbage`), `string`, `table`, `math`, and a hand-built 3-function `os` table (`time`, `clock`, `date`). `debug`, `io`, `package`, `os.execute`, `os.exit` are **never registered**, not merely deleted after the fact.
- A 5-second wall-clock execution cap (a re-arming `lua_sethook` count hook) and a fixed-byte memory cap (a custom Lua allocator) both apply to every run — the timeout alone is not sufficient (an allocation loop can OOM well before 5 seconds).
- Lua is compiled as C++ (not C) so `lua_error`/the timeout hook's error unwind as ordinary C++ exceptions through any `std::string`/`std::vector` locals in bound functions.
- Addresses passed to/from Lua globals (`readInt32`, `resolvePointer`, ...) are Lua integers, not hex strings — a deliberate divergence from `ChainTarget`'s string-serialized convention, since a script manipulates addresses arithmetically within one run.
- Lua's `readBytes`/`writeBytes` globals are raw binary-safe Lua strings, implemented independently in `script_ops.cc` — they do **not** reuse `patch_ops.cc`'s `ReadBytes`/`WriteBytes`, whose hex-encoding/64-byte-cap/page-straddle-refusal/`PAGE_EXECUTE_READWRITE`-flipping semantics are specific to code-patching.
- `resolvePointer` (not `resolveChain` — that name is already used, for a different operation, by the renderer's existing pointer-scan channel) wraps a **forward** base+offsets walk, hoisted out of `memory_ops.cc`'s anonymous namespace into a new shared `native/src/chain_walk.h` so `memory_ops.cc` and `script_ops.cc` share one implementation.
- `ScriptRuntime.enable`/`disable` are async and can fail (Lua error, timeout) — never treated as synchronous/infallible the way `FreezeLoop`'s are.
- The enabled-script set and every cheat's `state` table are in-memory only, never persisted to the profile, and are cleared (not run through `disableScript`) on detach/process-vanish/re-attach and on app quit.
- Every new IPC channel gets an entry in both `src/preload/index.ts` and `src/renderer/src/tamper.d.ts`.
- `isScriptCheat(cheat)` is used everywhere `isPatchCheat(cheat)` is already checked against `StoredCheat`, rather than assuming "not a patch means value cheat."

---

### Task 1: `ScriptCheat` data model

**Files:**
- Modify: `src/main/store.ts`
- Modify: `src/main/profile.ts:102-108` (`migrateByteDataType`)
- Test: `tests/main/store.test.ts`

**Interfaces:**
- Produces: `ScriptCheat` interface, `isScriptCheat(cheat: StoredCheat): cheat is ScriptCheat`, `StoredCheat = CheatDefinition | PatchCheat | ScriptCheat`. Every later task in this plan consumes these.

- [ ] **Step 1: Write the failing test**

Add to `tests/main/store.test.ts` (follow the file's existing style/imports — it already imports from `../../src/main/store`):

```ts
import { isScriptCheat } from '../../src/main/store'
import type { ScriptCheat } from '../../src/main/store'

describe('isScriptCheat', () => {
  it('is true for a script cheat', () => {
    const script: ScriptCheat = {
      kind: 'script',
      id: 's1',
      name: 'Double Health',
      enableScript: 'writeInt32(0x1000, readInt32(0x1000) * 2)',
      disableScript: ''
    }
    expect(isScriptCheat(script)).toBe(true)
  })

  it('is false for a value cheat', () => {
    expect(
      isScriptCheat({
        id: 'c1',
        name: 'C1',
        dataType: 'int32',
        mode: 'freeze',
        targets: [],
        value: 1
      })
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/store.test.ts`
Expected: FAIL — `isScriptCheat` is not exported.

- [ ] **Step 3: Implement**

In `src/main/store.ts`, add after the `PatchCheat` interface and its `isPatchCheat` guard:

```ts
// A cheat whose enable/disable are one-shot Lua scripts, instead of a
// value write or a code patch. No mode/dataType/targets — its only state
// is which script last ran, tracked the way FreezeLoop tracks freeze
// state (see ScriptRuntime, main/scriptRuntime.ts).
export interface ScriptCheat {
  kind: 'script'
  id: string
  name: string
  enableScript: string
  disableScript: string
  // Same meaning as CheatDefinition.hotkey / PatchCheat.hotkey above.
  hotkey?: string
}

export function isScriptCheat(cheat: StoredCheat): cheat is ScriptCheat {
  return (cheat as ScriptCheat).kind === 'script'
}
```

Change the `StoredCheat` union:

```ts
export type StoredCheat = CheatDefinition | PatchCheat | ScriptCheat
```

In `src/main/profile.ts`, `migrateByteDataType` (lines 102-108) iterates every cheat's `dataType` — a `ScriptCheat` has none, so guard it:

```ts
function migrateByteDataType(cheats: StoredCheat[]): StoredCheat[] {
  return cheats.map((cheat) => {
    const withDataType = cheat as { dataType?: string }
    if (withDataType.dataType !== 'byte') return cheat
    return { ...cheat, dataType: 'int8' } as StoredCheat
  })
}
```

already only rewrites when `dataType === 'byte'`, which is never true for a `ScriptCheat` (`undefined !== 'byte'`) — confirm this by reading the function again after the type change; no code change is needed here, only re-verify TypeScript still accepts `StoredCheat` at every existing call site (Step 4 catches any that don't).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: TypeScript will surface every place that assumed `StoredCheat` is exactly `CheatDefinition | PatchCheat` and needs an explicit `isScriptCheat` branch — these are fixed in Tasks 6-8 below, not here. If this task's own files (`store.ts`, `profile.ts`) don't typecheck on their own, fix those; errors elsewhere (`ipc.ts`, `hotkeys.ts`, `CheatList.tsx`) are expected at this point and are this plan's later tasks.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/main/store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/store.ts src/main/profile.ts tests/main/store.test.ts
git commit -m "Add ScriptCheat data model and isScriptCheat guard"
```

---

### Task 2: Hoist the forward pointer walk into `chain_walk.h`

**Files:**
- Create: `native/src/chain_walk.h`
- Modify: `native/src/memory_ops.cc` (remove the anonymous-namespace `ParseHex`/`ResolveChain`, include the new header instead)

**Interfaces:**
- Produces: `ResolveChain(HANDLE, uintptr_t base, const std::vector<uintptr_t>& offsets) -> std::optional<uintptr_t>` and `ParseHex(const std::string&) -> uintptr_t`, both `inline` in `chain_walk.h`. Consumed by `memory_ops.cc` (unchanged behavior) and by Task 6's `script_ops.cc`.

- [ ] **Step 1: Create `chain_walk.h`**

```cpp
#pragma once
#include <windows.h>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// The forward base+offsets pointer walk: dereference every offset except
// the last, add the last without dereferencing. Shared by memory_ops.cc
// (ReadValue/WriteValue) and script_ops.cc's resolvePointer Lua binding —
// hoisted out of memory_ops.cc's former anonymous namespace so both use
// exactly one implementation. This is the FORWARD walk (module base ->
// target address); it is unrelated to pointer.cc's ResolvePointerChain,
// which does the REVERSE search (target address -> a chain that reaches
// it) via a whole-process pointer scan.
inline uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

inline std::optional<uintptr_t> ResolveChain(
    HANDLE h, uintptr_t base, const std::vector<uintptr_t>& offsets) {
  uintptr_t addr = base;
  for (size_t i = 0; i < offsets.size(); i++) {
    addr += offsets[i];
    if (i + 1 < offsets.size()) {
      uintptr_t next;
      SIZE_T read;
      if (!ReadProcessMemory(h, (LPCVOID)addr, &next, sizeof(next), &read) || read != sizeof(next))
        return std::nullopt;
      addr = next;
    }
  }
  return addr;
}
```

- [ ] **Step 2: Update `memory_ops.cc` to use it**

Replace `native/src/memory_ops.cc`'s current lines 1-38 (the includes and the anonymous namespace containing `ParseHex`/`ResolveChain`/`ParseOffsets`) with:

```cpp
#include "memory_ops.h"
#include "value_type.h"
#include "chain_walk.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <optional>

namespace {

std::vector<uintptr_t> ParseOffsets(const Napi::Array& arr) {
  std::vector<uintptr_t> out;
  for (uint32_t i = 0; i < arr.Length(); i++) {
    out.push_back(ParseHex(arr.Get(i).As<Napi::String>().Utf8Value()));
  }
  return out;
}

} // namespace
```

(`ParseHex`/`ResolveChain` are now `inline` free functions from `chain_walk.h`, not members of this file's anonymous namespace — the rest of `ReadValue`/`WriteValue` below is unchanged and still calls them by the same names.)

- [ ] **Step 3: Rebuild and run the existing native test suite**

Run: `cd native && node-gyp build && cd ..`
Run: `npx vitest run tests/native/memory_ops.test.ts tests/native/scanner.test.ts tests/native/pointer.test.ts`
Expected: PASS — this task is a pure refactor, no behavior change.

- [ ] **Step 4: Commit**

```bash
git add native/src/chain_walk.h native/src/memory_ops.cc
git commit -m "Hoist forward pointer walk into shared chain_walk.h"
```

---

### Task 3: Vendor Lua 5.4 and get a trivial script running with the safety allowlist

**Files:**
- Create: `native/third_party/lua/` (Lua 5.4's release source, minus `lua.c`/`luac.c`)
- Modify: `native/binding.gyp`
- Create: `native/src/script_ops.h`, `native/src/script_ops.cc`
- Modify: `native/src/addon.cc` (register `runScript`)
- Modify: `src/main/nativeAddon.ts` (thin wrapper)
- Test: `tests/native/script_ops.test.ts`

**Interfaces:**
- Produces: native `RunScript(handle, source, phase, stateIn) -> Promise<{ success, output, error, stateOut }>` — **this task implements only `print`/`state`, no memory bindings yet** (Task 4 adds those); this task's job is getting the vendored Lua building, sandboxed, and callable from JS at all. `nativeAddon.runScript(handle, source, phase, stateIn)`.

- [ ] **Step 1: Vendor Lua**

Download Lua 5.4's release tarball (lua.org) and copy its `src/*.c` and `src/*.h` into `native/third_party/lua/`, **excluding** `lua.c` and `luac.c` (both define `main()` and are not part of the embeddable library). This is roughly 30 files (`lapi.c`, `lauxlib.c`, `lbaselib.c`, `lcode.c`, `lcorolib.c`, `lctype.c`, `ldblib.c`, `ldebug.c`, `ldo.c`, `ldump.c`, `lfunc.c`, `lgc.c`, `linit.c`, `liolib.c`, `llex.c`, `lmathlib.c`, `lmem.c`, `loadlib.c`, `lobject.c`, `lopcodes.c`, `loslib.c`, `lparser.c`, `lstate.c`, `lstring.c`, `lstrlib.c`, `ltable.c`, `ltablib.c`, `ltm.c`, `lundump.c`, `lutf8lib.c`, `lvm.c`, `lzio.c`, and their headers). `linit.c`, `liolib.c`, `loslib.c`, `ldblib.c`, `loadlib.c` are kept in the vendored source (deleting them would break the build, since other files reference their headers) but their `luaopen_*` entry points are simply never called from `script_ops.cc` (Step 4) — this is what "never registered" means in practice: the code exists in the binary but nothing ever invokes it to populate the global table.

In `native/third_party/lua/`, add a small `apprentice_lua_config.h` and make every vendored `.c` file's build see it force `LUAI_THROW`/`LUAI_TRY`/`LUAI_JMPBUF` onto C++ exceptions instead of `longjmp`/`setjmp` — do this by adding, to `native/third_party/lua/luaconf.h`, right after its include guard opens:

```c
#if defined(__cplusplus)
#include <exception>
struct LuaCppError { struct lua_longjmp* jmp; int status; };
#define LUAI_THROW(L,c)  throw LuaCppError{(c)->jmp, 0}
#define LUAI_TRY(L,c,a) \
  try { a } catch (LuaCppError& le) { if ((c) != (struct lua_longjmp*)0) {} (void)le; }
#endif
```

(This is Lua's own documented `LUAI_THROW`/`LUAI_TRY`/`LUAI_JMPBUF` override mechanism, described in `luaconf.h`'s own comments in the vendored source — follow the exact macro shapes `luaconf.h` und `ldo.c` expect for `struct lua_longjmp`'s fields; adjust the snippet above to match the vendored version's exact `ldo.c` if the macro signature differs slightly between point releases. The goal, verified in Step 6, is that a `lua_error` thrown from deep inside a bound C function unwinds through that function's C++ destructors correctly instead of skipping them via `longjmp`.)

- [ ] **Step 2: Update `binding.gyp`**

Replace `native/binding.gyp`'s `sources`/`include_dirs`/`msvs_settings` with:

```json
{
  "targets": [
    {
      "target_name": "memory_addon",
      "sources": [
        "src/addon.cc",
        "src/process_utils.cc",
        "src/scanner.cc",
        "src/pointer.cc",
        "src/memory_ops.cc",
        "src/write_watch.cc",
        "src/patch_ops.cc",
        "src/cave_ops.cc",
        "src/module_info.cc",
        "src/mono_call.cc",
        "src/mono_bridge.cc",
        "src/script_ops.cc",
        "third_party/zydis/Zydis.c",
        "third_party/lua/lapi.c",
        "third_party/lua/lauxlib.c",
        "third_party/lua/lbaselib.c",
        "third_party/lua/lcode.c",
        "third_party/lua/lcorolib.c",
        "third_party/lua/lctype.c",
        "third_party/lua/ldblib.c",
        "third_party/lua/ldebug.c",
        "third_party/lua/ldo.c",
        "third_party/lua/ldump.c",
        "third_party/lua/lfunc.c",
        "third_party/lua/lgc.c",
        "third_party/lua/linit.c",
        "third_party/lua/liolib.c",
        "third_party/lua/llex.c",
        "third_party/lua/lmathlib.c",
        "third_party/lua/lmem.c",
        "third_party/lua/loadlib.c",
        "third_party/lua/lobject.c",
        "third_party/lua/lopcodes.c",
        "third_party/lua/loslib.c",
        "third_party/lua/lparser.c",
        "third_party/lua/lstate.c",
        "third_party/lua/lstring.c",
        "third_party/lua/lstrlib.c",
        "third_party/lua/ltable.c",
        "third_party/lua/ltablib.c",
        "third_party/lua/ltm.c",
        "third_party/lua/lundump.c",
        "third_party/lua/lutf8lib.c",
        "third_party/lua/lvm.c",
        "third_party/lua/lzio.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/zydis",
        "third_party/lua",
        "src/platform"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "ZYDIS_STATIC_BUILD"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17", "/TP"] }
      },
      "cflags_cc": ["-x", "c++"],
      "conditions": [
        ["OS=='win'", { "sources": [ "src/platform/platform_win32.cc" ], "libraries": ["-lpsapi.lib", "-lversion.lib"] }],
        ["OS=='linux'", { "sources": [ "src/platform/platform_linux.cc" ], "defines": ["LUA_USE_LINUX"], "libraries": ["-ldl", "-lm"] }]
      ]
    }
  ]
}
```

`/TP` (MSVC) and `-x c++` (clang-cl/gcc-style) force every source file in this target — including the vendored `.c` files — to compile as C++, per this plan's Global Constraints on `lua_error`/exception unwinding. This applies to the whole target rather than a per-file override, which is simpler and has no downside here: `patch_ops.cc`/`memory_ops.cc`/etc. are already compiled as C++ (they're `.cc` files using N-API's C++ API), so forcing the `.c` files to match doesn't change anything for the rest of the addon.

- [ ] **Step 3: `script_ops.h`**

Create `native/src/script_ops.h`:

```cpp
#pragma once
#include <napi.h>

Napi::Value RunScript(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: `script_ops.cc` — allowlisted environment, no memory bindings yet**

Create `native/src/script_ops.cc`:

```cpp
#include "script_ops.h"
extern "C" {
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
}
#include <windows.h>
#include <chrono>
#include <string>
#include <vector>
#include <cstring>

namespace {

// Fixed byte budget for a single script run — generous for a trainer
// script, far below what would pressure Apprentice's own main process.
// See this plan's Global Constraints: the timeout alone is not enough,
// since an allocation loop can exhaust memory in well under 5 seconds.
constexpr size_t kMaxScriptBytes = 8 * 1024 * 1024;
constexpr int kTimeoutMs = 5000;
constexpr int kMaxOutputLines = 1000;

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
  if (budget->used + delta > kMaxScriptBytes) return nullptr; // OOM -> Lua raises a clean error
  void* result = realloc(ptr, nsize);
  if (!result) return nullptr;
  budget->used += delta;
  if (nsize < osize) budget->used -= (osize - nsize);
  return result;
}

struct TimeoutState {
  std::chrono::steady_clock::time_point deadline;
};

// LUA_MASKCOUNT hook: checked every 1000 VM instructions rather than every
// single one, to keep the check's own overhead negligible. Re-arms itself
// implicitly (lua_sethook with LUA_MASKCOUNT re-fires every `count`
// instructions for the lifetime of the state) rather than assuming a
// one-shot install persists — this hook is installed once per run in
// RunScriptImpl and stays armed for that run's whole lifetime.
void TimeoutHook(lua_State* L, lua_Debug*) {
  TimeoutState* state = static_cast<TimeoutState*>(lua_getextraspace(L));
  if (std::chrono::steady_clock::now() >= state->deadline) {
    luaL_error(L, "script exceeded its 5-second execution limit");
  }
}

// A hand-built 3-function os table — NOT the real os library (which
// includes os.execute/os.exit/io access). See this plan's Global
// Constraints: os.execute/os.exit/io/debug/package are never registered
// at all, not merely deleted after registration.
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
  char buf[64];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", localtime(&now));
  lua_pushstring(L, buf);
  return 1;
}

struct OutputCollector {
  std::vector<std::string> lines;
  bool truncated = false;
};

int LuaPrint(lua_State* L) {
  OutputCollector* out = static_cast<OutputCollector*>(lua_touserdata(L, lua_upvalueindex(1)));
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

ScriptResult RunScriptImpl(const std::string& source) {
  ScriptResult result;
  AllocBudget budget;
  lua_State* L = lua_newstate(BudgetAlloc, &budget);
  if (!L) {
    result.error = "could not allocate Lua state";
    return result;
  }

  TimeoutState* timeoutState = static_cast<TimeoutState*>(lua_getextraspace(L));
  timeoutState->deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kTimeoutMs);
  lua_sethook(L, TimeoutHook, LUA_MASKCOUNT, 1000);

  OutputCollector out;
  OpenAllowlistedLibs(L, &out);

  int loadStatus = luaL_loadstring(L, source.c_str());
  if (loadStatus != LUA_OK) {
    result.error = lua_tostring(L, -1);
    result.output = out.lines;
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
  lua_close(L);
  return result;
}

} // namespace

// This task's RunScript takes only a source string and runs it — no
// memory bindings, no state handoff, no async worker yet. Those are added
// in Tasks 4-5. Synchronous for now; Task 4 wraps this in an
// Napi::AsyncWorker once there's real per-process work worth offloading.
Napi::Value RunScript(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string source = info[0].As<Napi::String>().Utf8Value();

  ScriptResult result = RunScriptImpl(source);

  Napi::Object out = Napi::Object::New(env);
  out.Set("success", Napi::Boolean::New(env, result.success));
  Napi::Array output = Napi::Array::New(env, result.output.size());
  for (size_t i = 0; i < result.output.size(); i++) {
    output.Set((uint32_t)i, Napi::String::New(env, result.output[i]));
  }
  out.Set("output", output);
  out.Set("error", result.success ? env.Null() : Napi::Value::From(env, result.error));
  return out;
}
```

- [ ] **Step 5: Register in `addon.cc`**

Add `#include "script_ops.h"` to the includes, and inside `Init`:

```cpp
exports.Set("runScript", Napi::Function::New(env, RunScript));
```

- [ ] **Step 6: Rebuild**

Run: `cd native && node-gyp configure && node-gyp build && cd ..`

This is a from-scratch source-list change (new vendored files), so `configure` (not just `build`) must run first — `node-gyp build` alone does not pick up added `sources` entries.

Expected: builds clean. If the `LUAI_THROW`/`LUAI_TRY` macro override in Step 1 doesn't match the vendored point release's exact `ldo.c` internals, the build error will point at `ldo.c`'s `luaD_throw`/`luaD_rawrunprotected` — adjust the macro to match that file's actual usage before proceeding; do not fall back to `longjmp` (see this plan's Global Constraints on why).

- [ ] **Step 7: Write and run the failing test**

Create `tests/native/script_ops.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'

describe('runScript — sandbox', () => {
  it('runs a trivial script and captures print output', () => {
    const result = (addon as any).runScript('print("hello", 1, 2)')
    expect(result.success).toBe(true)
    expect(result.output).toEqual(['hello\t1\t2'])
  })

  it('reports a syntax error without throwing', () => {
    const result = (addon as any).runScript('this is not lua')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('reports a runtime error without throwing', () => {
    const result = (addon as any).runScript('error("boom")')
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('does not expose os.execute, os.exit, io, package, or debug', () => {
    const result = (addon as any).runScript(`
      local blocked = {
        pcall(function() return os.execute end),
        pcall(function() return os.exit end),
        pcall(function() return io end),
        pcall(function() return package end),
        pcall(function() return debug end),
      }
      for _, ok in ipairs(blocked) do
        -- each entry is (ok, value) from pcall; a nil global is not an
        -- error in Lua (indexing a nonexistent global just yields nil),
        -- so check the VALUE is nil, not that pcall failed.
      end
      print(os.execute == nil, os.exit == nil, io == nil, package == nil, debug == nil)
    `)
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('true\ttrue\ttrue\ttrue\ttrue')
  })

  it('does not expose dofile, loadfile, load, or collectgarbage', () => {
    const result = (addon as any).runScript(
      'print(dofile == nil, loadfile == nil, load == nil, collectgarbage == nil)'
    )
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('true\ttrue\ttrue\ttrue')
  })

  it('times out an infinite loop within roughly the 5-second cap', () => {
    const start = Date.now()
    const result = (addon as any).runScript('while true do end')
    const elapsed = Date.now() - start
    expect(result.success).toBe(false)
    expect(result.error).toContain('execution limit')
    expect(elapsed).toBeLessThan(7000)
  }, 10000)

  it('raises a clean error instead of exhausting memory on an allocation loop', () => {
    const result = (addon as any).runScript(
      'local s = "" while true do s = s .. string.rep("x", 1024) end'
    )
    expect(result.success).toBe(false)
  }, 10000)
})
```

- [ ] **Step 8: Run the test**

Run: `npx vitest run tests/native/script_ops.test.ts`
Expected: PASS (7 tests). This is the highest-value test in this whole plan — it proves the allowlist and both safety caps actually hold, not merely that the C++ compiles.

- [ ] **Step 9: Commit**

```bash
git add native/third_party/lua native/binding.gyp native/src/script_ops.h native/src/script_ops.cc native/src/addon.cc tests/native/script_ops.test.ts
git commit -m "Vendor Lua 5.4, add allowlisted sandbox with timeout and memory cap"
```

---

### Task 4: Bind memory read/write globals

**Files:**
- Modify: `native/src/script_ops.cc`

**Interfaces:**
- Produces: Lua globals `readInt8/16/32/64`, `readFloat`, `readDouble`, `writeInt8/16/32/64`, `writeFloat`, `writeDouble`, `readBytes`, `writeBytes` — each bound against the `HANDLE` passed into `RunScript`. `RunScript`'s JS-visible signature becomes `runScript(handle, source)`.

- [ ] **Step 1: Extend `RunScriptImpl` and the bound functions**

In `native/src/script_ops.cc`, add (near the other Lua C functions, before `OpenAllowlistedLibs`):

```cpp
#include "value_type.h"

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
  if (kind == ValueKind::Int64) {
    int64_t raw;
    memcpy(&raw, buf, sizeof(raw));
    lua_pushinteger(L, raw);
  } else {
    lua_pushnumber(L, value);
  }
  return 1;
}

int LuaWriteValue(lua_State* L, ValueKind kind, size_t size) {
  uintptr_t address = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
  double value = luaL_checknumber(L, 2);
  HANDLE h = HandleFromRegistry(L);
  uint8_t buf[8];
  EncodeFromDouble(value, ValueSpec{size, kind}, buf);
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
```

Register these globals inside `OpenAllowlistedLibs` (add before `lua_setglobal(L, "print")`'s closing, or anywhere after the base library is opened):

```cpp
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
```

Update `RunScriptImpl` and `RunScript` to accept and store the handle:

```cpp
ScriptResult RunScriptImpl(HANDLE handle, const std::string& source) {
  ScriptResult result;
  AllocBudget budget;
  lua_State* L = lua_newstate(BudgetAlloc, &budget);
  if (!L) {
    result.error = "could not allocate Lua state";
    return result;
  }

  lua_pushlightuserdata(L, reinterpret_cast<void*>(handle));
  lua_setfield(L, LUA_REGISTRYINDEX, "apprentice_handle");

  TimeoutState* timeoutState = static_cast<TimeoutState*>(lua_getextraspace(L));
  timeoutState->deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kTimeoutMs);
  lua_sethook(L, TimeoutHook, LUA_MASKCOUNT, 1000);

  OutputCollector out;
  OpenAllowlistedLibs(L, &out);
  // ... unchanged from here (luaL_loadstring / lua_pcall / lua_close)
```

```cpp
Napi::Value RunScript(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string source = info[1].As<Napi::String>().Utf8Value();

  ScriptResult result = RunScriptImpl(h, source);
  // ... rest unchanged
```

- [ ] **Step 2: Rebuild**

Run: `cd native && node-gyp build && cd ..`

- [ ] **Step 3: Write and run the failing test**

Add to `tests/native/script_ops.test.ts`, spawning `test-harness/harness.exe` the same way `tests/native/memory_ops.test.ts` does (`beforeAll`/`afterAll` spawning, `attach`, `send`):

```ts
describe('runScript — memory bindings', () => {
  let harness: ChildProcessWithoutNullStreams
  let handle: number

  beforeAll(async () => {
    harness = spawn(path.resolve('test-harness/harness.exe'))
    await new Promise((r) => harness.stdout.once('data', r))
    handle = (addon as any).attach(harness.pid).handle
  })

  afterAll(() => {
    harness.stdin.write('q\n')
    harness.kill()
  })

  it('writes an int32 via Lua and the harness confirms it', async () => {
    let candidates = await (addon as any).scanFirst(handle, 'int32', 100)
    await send('set 55')
    candidates = (addon as any).scanNext(handle, candidates, 'int32', { mode: 'exact', value: 55 })
    expect(candidates.length).toBe(1)
    const address = parseInt(candidates[0].address, 16)

    const result = (addon as any).runScript(handle, `writeInt32(${address}, 999)`)
    expect(result.success).toBe(true)

    const reply = await send('get')
    expect(reply).toBe('OK 999')
  })

  it('reads a value via Lua matching a direct native readValue', async () => {
    let candidates = await (addon as any).scanFirst(handle, 'int16', 12345)
    expect(candidates.length).toBeGreaterThan(0)
    const address = parseInt(candidates[0].address, 16)

    const result = (addon as any).runScript(handle, `print(readInt16(${address}))`)
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('12345')
  })
})
```

(Reuse this file's own `send`/`spawn` helper pattern — copy the exact `send` function `tests/native/memory_ops.test.ts` defines, or import shared spawn/`send` helpers if this codebase already factors them out; check before duplicating.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/native/script_ops.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add native/src/script_ops.cc tests/native/script_ops.test.ts
git commit -m "Bind memory read/write globals into the Lua sandbox"
```

---

### Task 5: `resolvePointer` binding and `AsyncWorker`

**Files:**
- Modify: `native/src/script_ops.cc`
- Modify: `src/main/nativeAddon.ts`

**Interfaces:**
- Produces: Lua global `resolvePointer(moduleName, offsets) -> integer | nil`, and the `state` global table (see Step 3 below — this is the enable/disable value handoff the spec requires, e.g. an enable script recording `state.original = readInt32(addr)` for its disable script to read back). `RunScript`'s JS signature becomes async and gains `stateIn`/returns `stateOut`: `runScript(handle, source, stateIn) -> Promise<{success, output, error, stateOut}>`. `nativeAddon.runScript(handle, source, stateIn): Promise<{success, output, error, stateOut}>`.
- `LuaValue = string | number | boolean` — `state` only round-trips flat key→primitive entries (no nested tables/functions); this is a deliberate scope limit, not an oversight, since the only described need is "an enable script hands its disable script a handful of captured values."

- [ ] **Step 1: Add the `resolvePointer` binding**

`chain_walk.h`'s `ResolveChain` needs a module base, which `pointer.cc`'s `GetModuleBase` native export already resolves — but that's a `Napi::CallbackInfo`-shaped function, not reusable from inside a `lua_CFunction`. Add a small internal-only base lookup to `chain_walk.h` instead (a trimmed copy of the module enumeration `pointer.cc`'s own `ListModules` already does, kept minimal since script_ops only needs a base address, not full module ranges):

Add to `native/src/chain_walk.h`:

```cpp
#include <psapi.h>

// Minimal module-base lookup — script_ops.cc's resolvePointer binding
// only needs the base address, not pointer.cc's full ModuleRange/
// FindContainingModule machinery (that supports the REVERSE pointer scan;
// this supports the forward walk above).
inline std::optional<uintptr_t> FindModuleBase(HANDLE h, const std::string& moduleName) {
  HMODULE mods[1024];
  DWORD needed;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) return std::nullopt;
  DWORD count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;
  for (DWORD i = 0; i < count; i++) {
    char nameBuf[MAX_PATH];
    if (GetModuleBaseNameA(h, mods[i], nameBuf, sizeof(nameBuf)) &&
        _stricmp(nameBuf, moduleName.c_str()) == 0) {
      return reinterpret_cast<uintptr_t>(mods[i]);
    }
  }
  return std::nullopt;
}
```

Add to `script_ops.cc`:

```cpp
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
```

Add `#include "chain_walk.h"` to `script_ops.cc`'s includes, and register the global next to the memory functions in `OpenAllowlistedLibs`:

```cpp
  lua_pushcfunction(L, LuaResolvePointer);
  lua_setglobal(L, "resolvePointer");
```

- [ ] **Step 2: Bind the `state` handoff table**

**`RunScriptImpl` must never touch a `Napi::Value`/`Napi::Object`** — Task 5 Step 3 (below) runs it on `RunScriptWorker`'s background thread, and every N-API handle is bound to the JS thread's `Napi::Env`. So the `state` handoff is a plain C++ type at the `RunScriptImpl`/`SeedStateTable`/`ReadStateTable` level; only `RunScriptWorker`'s constructor and `OnOK()` (both JS-thread-only) ever convert to/from `Napi::Object`. Add near the top of `script_ops.cc`, after the includes:

```cpp
#include <variant>
#include <map>

using LuaValueVariant = std::variant<std::string, double, bool>;
using LuaState = std::map<std::string, LuaValueVariant>;
```

Add to `script_ops.cc`, near `OpenAllowlistedLibs`:

```cpp
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
          if constexpr (std::is_same_v<T, std::string>) lua_pushstring(L, v.c_str());
          else if constexpr (std::is_same_v<T, double>) lua_pushnumber(L, v);
          else lua_pushboolean(L, v);
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
```

Thread `stateIn`/`stateOut` through `RunScriptImpl` and `ScriptResult`:

```cpp
struct ScriptResult {
  bool success = false;
  std::vector<std::string> output;
  std::string error;
  LuaState stateOut;
};

ScriptResult RunScriptImpl(HANDLE handle, const std::string& source, const LuaState& stateIn) {
  // ... unchanged setup through OpenAllowlistedLibs(L, &out); then:
  SeedStateTable(L, stateIn);

  int loadStatus = luaL_loadstring(L, source.c_str());
  // ... unchanged luaL_loadstring/lua_pcall handling; before lua_close(L):
  result.stateOut = ReadStateTable(L);
  lua_close(L);
  return result;
}
```

(This supersedes Task 4 Step 1's `RunScriptImpl(HANDLE, const std::string&)` signature — it now also takes `const LuaState& stateIn`, consistently from here through the rest of this plan.)

- [ ] **Step 3: Wrap `RunScript` in an `AsyncWorker`**

Replace `RunScript`'s body in `script_ops.cc` with an async version, following the exact `Napi::AsyncWorker` shape `patch_ops.cc`'s `ScanAobWorker` already uses (deferred promise, `Execute()` on the background thread, `OnOK()`/`OnError()` back on the JS thread). `stateIn` is flattened from `Napi::Object` to `LuaState` in the constructor (JS thread, before `Queue()`); `Execute()` only ever touches the already-flattened `LuaState`, never a `Napi::Value`:

```cpp
class RunScriptWorker : public Napi::AsyncWorker {
 public:
  RunScriptWorker(Napi::Env env, HANDLE handle, std::string source, const Napi::Object& stateIn)
      : Napi::AsyncWorker(env), handle_(handle), source_(std::move(source)),
        deferred_(Napi::Promise::Deferred::New(env)) {
    Napi::Array keys = stateIn.GetPropertyNames();
    for (uint32_t i = 0; i < keys.Length(); i++) {
      std::string key = keys.Get(i).As<Napi::String>().Utf8Value();
      Napi::Value value = stateIn.Get(key);
      if (value.IsString()) flatStateIn_[key] = value.As<Napi::String>().Utf8Value();
      else if (value.IsNumber()) flatStateIn_[key] = value.As<Napi::Number>().DoubleValue();
      else if (value.IsBoolean()) flatStateIn_[key] = value.As<Napi::Boolean>().Value();
      // else: skipped, per ReadStateTable's matching scope limit above.
    }
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override { result_ = RunScriptImpl(handle_, source_, flatStateIn_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object out = Napi::Object::New(env);
    out.Set("success", Napi::Boolean::New(env, result_.success));
    Napi::Array output = Napi::Array::New(env, result_.output.size());
    for (size_t i = 0; i < result_.output.size(); i++) {
      output.Set((uint32_t)i, Napi::String::New(env, result_.output[i]));
    }
    out.Set("output", output);
    out.Set("error", result_.success ? env.Null() : Napi::Value::From(env, result_.error));
    Napi::Object stateOut = Napi::Object::New(env);
    for (const auto& [key, value] : result_.stateOut) {
      std::visit([&](auto&& v) { stateOut.Set(key, Napi::Value::From(env, v)); }, value);
    }
    out.Set("stateOut", stateOut);
    deferred_.Resolve(out);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  std::string source_;
  LuaState flatStateIn_;
  ScriptResult result_;
  Napi::Promise::Deferred deferred_;
};

} // namespace

Napi::Value RunScript(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string source = info[1].As<Napi::String>().Utf8Value();
  Napi::Object stateIn = info.Length() > 2 && info[2].IsObject()
      ? info[2].As<Napi::Object>()
      : Napi::Object::New(env);
  auto* worker = new RunScriptWorker(env, h, source, stateIn);
  worker->Queue();
  return worker->GetPromise();
}
```

(Move the `namespace { ... }` closing brace up to just before `RunScriptWorker`, so it and the free functions above it are all inside the anonymous namespace together, matching this file's existing structure.)

- [ ] **Step 4: Update `nativeAddon.ts`**

Add near `scanAob`/`resolvePointerChain` in `src/main/nativeAddon.ts`:

```ts
export type LuaValue = string | number | boolean

  // Runs on a background thread (Napi::AsyncWorker), same as scanAob/
  // resolvePointerChain — a script can legitimately run for up to its
  // 5-second cap, and must not block the Electron main thread for that
  // whole time. stateIn seeds the script's `state` global (for the
  // enable/disable value handoff — see ScriptRuntime, main/scriptRuntime.ts);
  // stateOut is `state`'s contents after the run.
  runScript: (
    handle: number,
    source: string,
    stateIn: Record<string, LuaValue>
  ): Promise<{
    success: boolean
    output: string[]
    error: string | null
    stateOut: Record<string, LuaValue>
  }> => addon.runScript(handle, source, stateIn),
```

- [ ] **Step 5: Update the existing tests for the now-async, state-carrying signature**

`tests/native/script_ops.test.ts`'s Task 3 tests called `addon.runScript(source)` synchronously with no handle/state. Update every call in that file to `await (addon as any).runScript(handle, source, {})` — this requires those tests to also spawn/attach a harness process the way Task 4's tests already do; consolidate all of `script_ops.test.ts` under one `beforeAll`/`afterAll` harness spawn (matching `memory_ops.test.ts`'s single top-level `beforeAll` for its whole file) rather than the two separate `describe` blocks Tasks 3-4 introduced.

Add one more test for the state handoff itself:

```ts
it('round-trips a value through state between two separate runScript calls', async () => {
  const first = await (addon as any).runScript(handle, 'state.original = 42', {})
  expect(first.stateOut.original).toBe(42)

  const second = await (addon as any).runScript(
    handle,
    'print(state.original)',
    first.stateOut
  )
  expect(second.output[0]).toBe('42')
})
```

- [ ] **Step 6: Rebuild and run**

Run: `cd native && node-gyp build && cd ..`
Run: `npx vitest run tests/native/script_ops.test.ts`
Expected: PASS

Add one more test for `resolvePointer` alongside the Task 4 memory-binding tests:

```ts
it('resolvePointer matches getModuleBase + arithmetic for a zero-offset chain', async () => {
  const moduleName = 'harness.exe'
  const base = (addon as any).getModuleBase(handle, moduleName)
  const result = await (addon as any).runScript(
    handle,
    `print(resolvePointer("${moduleName}", {0x10}))`,
    {}
  )
  expect(result.success).toBe(true)
  expect(BigInt(result.output[0])).toBe(BigInt(base) + 0x10n)
})
```

- [ ] **Step 7: Commit**

```bash
git add native/src/chain_walk.h native/src/script_ops.cc src/main/nativeAddon.ts tests/native/script_ops.test.ts
git commit -m "Add resolvePointer binding, run scripts on a background AsyncWorker"
```

---

### Task 6: `ScriptRuntime` (main process)

**Files:**
- Create: `src/main/scriptRuntime.ts`
- Test: `tests/main/scriptRuntime.test.ts`

**Interfaces:**
- Consumes: nothing from the native layer directly — takes a `RunScript` function as an injected dependency (DI-fake pattern, exactly like `FreezeLoop`'s `WriteFn`), so this is testable without Electron or a real Lua VM.
- Produces:
```ts
export type LuaValue = string | number | boolean
export type RunScriptFn = (
  source: string,
  stateIn: Record<string, LuaValue>
) => Promise<{
  success: boolean
  output: string[]
  error: string | null
  stateOut: Record<string, LuaValue>
}>

export class ScriptRuntime {
  constructor(runScript: RunScriptFn)
  enable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
  disable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
  isEnabled(cheatId: string): boolean
  clear(cheatId: string): void // for lifecycle cleanup (Task 7)
}
```
Consumed by Task 7's `ipc.ts`/`hotkeys.ts` wiring. `RunScriptFn` matches Task 5's `nativeAddon.runScript` signature exactly — `ScriptRuntime` holds one `Map<string, Record<string, LuaValue>>` internally (per-cheat `state`), passes the current entry as `stateIn` on every `enable`/`disable` call, and overwrites that entry with `stateOut` on success. This is the enable→disable value handoff the spec requires (e.g. `state.original = readInt32(addr)` in `enableScript`, read back in `disableScript`) — implemented in full here, not deferred.

- [ ] **Step 1: Write the failing test**

Create `tests/main/scriptRuntime.test.ts`, modeled directly on `tests/main/freezeLoop.test.ts`'s fake-dependency style:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ScriptRuntime } from '../../src/main/scriptRuntime'
import type { ScriptCheat } from '../../src/main/store'

const cheat: ScriptCheat = {
  kind: 'script',
  id: 'double-health',
  name: 'Double Health',
  enableScript: 'writeInt32(0x1000, readInt32(0x1000) * 2)',
  disableScript: ''
}

describe('ScriptRuntime', () => {
  it('runs enableScript and marks the cheat enabled on success', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    expect(runtime.isEnabled(cheat.id)).toBe(false)

    const result = await runtime.enable(cheat)

    expect(result.ok).toBe(true)
    expect(runtime.isEnabled(cheat.id)).toBe(true)
    expect(runScript).toHaveBeenCalledWith(cheat.enableScript, {})
  })

  it('does not mark the cheat enabled when the script fails', async () => {
    const runScript = vi.fn().mockResolvedValue({
      success: false,
      output: [],
      error: 'boom',
      stateOut: {}
    })
    const runtime = new ScriptRuntime(runScript)

    const result = await runtime.enable(cheat)

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    expect(runtime.isEnabled(cheat.id)).toBe(false)
  })

  it('disable runs disableScript and clears the enabled flag on success', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    await runtime.enable(cheat)

    const result = await runtime.disable(cheat)

    expect(result.ok).toBe(true)
    expect(runtime.isEnabled(cheat.id)).toBe(false)
    expect(runScript).toHaveBeenLastCalledWith(cheat.disableScript, {})
  })

  it('a failed disable leaves the cheat enabled, not optimistically cleared', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    await runtime.enable(cheat)

    runScript.mockResolvedValueOnce({ success: false, output: [], error: 'disable failed', stateOut: {} })
    const result = await runtime.disable(cheat)

    expect(result.ok).toBe(false)
    expect(runtime.isEnabled(cheat.id)).toBe(true)
  })

  it('ignores a second concurrent toggle while one is still in flight', async () => {
    let resolveFirst: (v: {
      success: boolean
      output: string[]
      error: string | null
      stateOut: Record<string, string | number | boolean>
    }) => void
    const runScript = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )
    const runtime = new ScriptRuntime(runScript)

    const first = runtime.enable(cheat)
    const second = runtime.enable(cheat) // should be a no-op, not a second run

    resolveFirst!({ success: true, output: [], error: null, stateOut: {} })
    await Promise.all([first, second])

    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('clear() resets the enabled flag without running disableScript', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    await runtime.enable(cheat)

    runtime.clear(cheat.id)

    expect(runtime.isEnabled(cheat.id)).toBe(false)
    expect(runScript).toHaveBeenCalledTimes(1) // only the original enable call
  })

  it('passes enableScript\'s stateOut as disableScript\'s stateIn', async () => {
    const runScript = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: { original: 42 } })
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)

    await runtime.enable(cheat)
    await runtime.disable(cheat)

    expect(runScript).toHaveBeenNthCalledWith(1, cheat.enableScript, {})
    expect(runScript).toHaveBeenNthCalledWith(2, cheat.disableScript, { original: 42 })
  })

  it('clear() also discards the cheat\'s stored state', async () => {
    const runScript = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: { original: 42 } })
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)

    await runtime.enable(cheat)
    runtime.clear(cheat.id)
    await runtime.disable(cheat)

    expect(runScript).toHaveBeenNthCalledWith(2, cheat.disableScript, {})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/scriptRuntime.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/main/scriptRuntime.ts`:

```ts
import type { ScriptCheat } from './store'

export type LuaValue = string | number | boolean
export type RunScriptFn = (
  source: string,
  stateIn: Record<string, LuaValue>
) => Promise<{
  success: boolean
  output: string[]
  error: string | null
  stateOut: Record<string, LuaValue>
}>

// Mirrors FreezeLoop's shape (an enabled-set, isEnabled), but unlike
// FreezeLoop.enable/disable — synchronous and cannot fail — a script run
// is async and can fail (a Lua runtime error or the native timeout). The
// enabled set is updated only on success, never optimistically, and a
// per-cheat in-flight guard makes a second toggle while one is still
// running a no-op rather than launching an overlapping run. `state` is
// the enable->disable value handoff the spec requires (e.g.
// `state.original = readInt32(addr)` in enableScript, read back in
// disableScript) — held per-cheat in-memory only, never persisted.
export class ScriptRuntime {
  private runScript: RunScriptFn
  private enabled = new Set<string>()
  private inFlight = new Set<string>()
  private state = new Map<string, Record<string, LuaValue>>()

  constructor(runScript: RunScriptFn) {
    this.runScript = runScript
  }

  isEnabled(cheatId: string): boolean {
    return this.enabled.has(cheatId)
  }

  async enable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }> {
    return this.run(cheat, cheat.enableScript, true)
  }

  async disable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }> {
    return this.run(cheat, cheat.disableScript, false)
  }

  // Detach/vanish/quit: the process handle is dead, so running
  // disableScript is pointless — just forget this cheat was enabled AND
  // discard its state (a fresh attach's enable script should not see a
  // stale value captured from a previous, now-dead process instance).
  clear(cheatId: string): void {
    this.enabled.delete(cheatId)
    this.inFlight.delete(cheatId)
    this.state.delete(cheatId)
  }

  private async run(
    cheat: ScriptCheat,
    source: string,
    markEnabledOnSuccess: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.inFlight.has(cheat.id)) {
      return { ok: false, error: 'A run is already in progress for this cheat.' }
    }
    this.inFlight.add(cheat.id)
    try {
      const stateIn = this.state.get(cheat.id) ?? {}
      const result = await this.runScript(source, stateIn)
      if (result.success) {
        this.state.set(cheat.id, result.stateOut)
        if (markEnabledOnSuccess) this.enabled.add(cheat.id)
        else this.enabled.delete(cheat.id)
        return { ok: true }
      }
      return { ok: false, error: result.error ?? 'Script failed.' }
    } finally {
      this.inFlight.delete(cheat.id)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/scriptRuntime.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/scriptRuntime.ts tests/main/scriptRuntime.test.ts
git commit -m "Add ScriptRuntime: async enable/disable with in-flight guard and state handoff"
```

---

### Task 7: Wire scripting into `ipc.ts`, `hotkeys.ts`, lifecycle, and CT export

**Files:**
- Modify: `src/main/hotkeys.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/tamper.d.ts`
- Test: `tests/main/hotkeys.test.ts` (extend)

**Interfaces:**
- Consumes: `ScriptRuntime` (Task 6), `isScriptCheat`/`ScriptCheat` (Task 1), `nativeAddon.runScript` (Task 5).
- Produces: `scripts:run` IPC channel; `HotkeyDeps` gains `isScriptEnabled`/`enableScript`/`disableScript`; `hotkeys.ts`'s `fire()` gains a script branch.

- [ ] **Step 1: Extend `HotkeyDeps` and `hotkeys.ts`'s fire dispatch**

In `src/main/hotkeys.ts`, add to the `HotkeyDeps` interface (after `disarmPatch`):

```ts
  isScriptEnabled(cheatId: string): boolean
  // Both resolve even on failure — HotkeyOutcome 'error' is used in that
  // case, mirroring fireValueCheat's existing one-shot path, since a
  // script run is async and fallible the same way a one-shot write is
  // (unlike freeze/patch toggling, which cannot fail).
  runScriptEnable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
  runScriptDisable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
```

Update the import line and `fire()`/add a `fireScript`:

```ts
import {
  isPatchCheat,
  isScriptCheat,
  type CheatDefinition,
  type PatchCheat,
  type ScriptCheat,
  type StoredCheat
} from './store'
```

```ts
  private fire(cheat: StoredCheat): void {
    if (isPatchCheat(cheat)) {
      this.firePatch(cheat)
    } else if (isScriptCheat(cheat)) {
      this.fireScript(cheat)
    } else {
      this.fireValueCheat(cheat)
    }
  }

  // Modeled on fireValueCheat's ONE-SHOT branch (async, can fail), not its
  // freeze branch (sync, infallible) — a script run is always fallible.
  private fireScript(cheat: ScriptCheat): void {
    const wasEnabled = this.deps.isScriptEnabled(cheat.id)
    const action = wasEnabled ? this.deps.runScriptDisable(cheat) : this.deps.runScriptEnable(cheat)
    void action
      .then((result) => {
        if (result.ok) {
          this.firedCb?.(cheat.id, wasEnabled ? 'off' : 'on')
        } else {
          this.firedCb?.(cheat.id, 'error', result.error ?? 'Script failed.')
        }
      })
      .catch((err) =>
        this.firedCb?.(cheat.id, 'error', err instanceof Error ? err.message : 'Script failed.')
      )
  }
```

- [ ] **Step 2: Extend `tests/main/hotkeys.test.ts`**

Read the existing file first to match its fake-`HotkeyDeps` construction pattern exactly (it already builds a full fake `HotkeyDeps` object per test). Add `isScriptEnabled`/`runScriptEnable`/`runScriptDisable` fakes to that shared fake object (returning `false`/resolved `{ok: true}` by default, consistent with the file's existing defaults for the patch/freeze fakes), then add:

```ts
it('fires a script cheat: runs enableScript when currently off, reports on', async () => {
  const script: ScriptCheat = {
    kind: 'script',
    id: 's1',
    name: 'S1',
    enableScript: 'writeInt32(0, 1)',
    disableScript: '',
    hotkey: 'F5'
  }
  const deps = makeFakeDeps({ loadCheats: () => [script] }) // use this file's existing fake-builder helper
  const runScriptEnable = vi.fn().mockResolvedValue({ ok: true })
  deps.runScriptEnable = runScriptEnable
  deps.isScriptEnabled = () => false
  const manager = new HotkeyManager(deps)
  const fired = vi.fn()
  manager.onFired(fired)
  manager.registerAll('game')

  const registered = deps.registerShortcut as unknown as ReturnType<typeof vi.fn>
  const callback = registered.mock.calls[0][1]
  callback()
  await new Promise((r) => setTimeout(r, 0))

  expect(runScriptEnable).toHaveBeenCalledWith(script)
  expect(fired).toHaveBeenCalledWith('s1', 'on')
})

it('reports outcome "error" when a script run fails', async () => {
  const script: ScriptCheat = {
    kind: 'script',
    id: 's1',
    name: 'S1',
    enableScript: 'error("boom")',
    disableScript: '',
    hotkey: 'F5'
  }
  const deps = makeFakeDeps({ loadCheats: () => [script] })
  deps.isScriptEnabled = () => false
  deps.runScriptEnable = vi.fn().mockResolvedValue({ ok: false, error: 'boom' })
  const manager = new HotkeyManager(deps)
  const fired = vi.fn()
  manager.onFired(fired)
  manager.registerAll('game')

  const registered = deps.registerShortcut as unknown as ReturnType<typeof vi.fn>
  const callback = registered.mock.calls[0][1]
  callback()
  await new Promise((r) => setTimeout(r, 0))

  expect(fired).toHaveBeenCalledWith('s1', 'error', 'boom')
})
```

(Adjust `makeFakeDeps`/fake-construction calls to whatever this file's actual existing helper is named — read the file before writing these, per this task's Step 2 instruction above; do not invent a helper name that doesn't already exist there.)

- [ ] **Step 3: Wire `ipc.ts`**

Add the import, `scriptRuntime` construction, `scripts:run` handler, `cheats:save` guard fix, CT-export bucket fix, and lifecycle clearing:

```ts
import { ScriptRuntime } from './scriptRuntime'
import { isScriptCheat, type ScriptCheat } from './store' // add isScriptCheat/ScriptCheat to the existing store import
```

Near `hotkeyDeps`'s construction (`src/main/ipc.ts:461`), add above it:

```ts
const scriptRuntime = new ScriptRuntime(async (source, stateIn) => {
  if (attachedHandle === null) {
    return { success: false, output: [], error: 'not attached', stateOut: stateIn }
  }
  return nativeAddon.runScript(attachedHandle, source, stateIn)
})
```

Add to `hotkeyDeps`'s object literal (alongside `armPatch`/`disarmPatch`):

```ts
  isScriptEnabled: (cheatId) => scriptRuntime.isEnabled(cheatId),
  runScriptEnable: (cheat) => scriptRuntime.enable(cheat),
  runScriptDisable: (cheat) => scriptRuntime.disable(cheat),
```

Fix the `cheats:save` guard (`src/main/ipc.ts:658`) — a `ScriptCheat` has no `targets`, so `!isPatchCheat(cheat)` wrongly includes it today:

```ts
    if (
      cheat.hotkey &&
      !isPatchCheat(cheat) &&
      !isScriptCheat(cheat) &&
      cheat.targets.some(isAnchorTarget)
    ) {
```

Fix the CT-export bucket (`src/main/ipc.ts:966-974`) — a script cheat has no CT equivalent and must be reported skipped, not silently mis-bucketed into "value cheats":

```ts
      const patches = allCheats.filter(isPatchCheat).filter((p) => !p.internal)
      const scripts = allCheats.filter(isScriptCheat)
      const valueCheats = allCheats.filter((c) => !isPatchCheat(c) && !isScriptCheat(c))
      const { xml, exported, skipped: patchSkipped } = buildCheatTable(patches)
      const skipped = [
        ...patchSkipped,
        ...valueCheats.map((cheat) => ({
          name: cheat.name,
          reason: "Value cheats have no equivalent Auto Assembler script shape and can't be exported to .CT."
        })),
        ...scripts.map((cheat) => ({
          name: cheat.name,
          reason: "Lua-scripted cheats have no equivalent Auto Assembler script shape and can't be exported to .CT."
        }))
      ]
```

Add a `scripts:toggle` handler, alongside `cheats:toggleFreeze` (`src/main/ipc.ts:687-690`) — **the checkbox-driven UI toggle goes through `ScriptRuntime`, exactly like the hotkey path does, not a raw `scripts:run` call**, so the enable→disable `state` handoff and the enabled-set stay correct regardless of which path toggled a script last:

```ts
  ipcMain.handle(
    'scripts:toggle',
    async (_e, cheat: ScriptCheat, enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      return enabled ? scriptRuntime.enable(cheat) : scriptRuntime.disable(cheat)
    }
  )

  ipcMain.handle('scripts:isEnabled', (_e, cheatId: string): boolean => scriptRuntime.isEnabled(cheatId))
```

Add the `scripts:run` handler (for `ScriptEditor`'s ad-hoc "Run enable/disable now" test buttons, which deliberately do NOT go through `ScriptRuntime` — they run against a throwaway state, per this plan's Task 8, since the script may not even be saved yet), near `cheats:oneShot` (`src/main/ipc.ts:692-695`):

```ts
  ipcMain.handle(
    'scripts:run',
    async (
      _e,
      source: string,
      stateIn: Record<string, LuaValue>
    ): Promise<{
      success: boolean
      output: string[]
      error: string | null
      stateOut: Record<string, LuaValue>
    }> => {
      if (attachedHandle === null) throw new Error('not attached')
      return nativeAddon.runScript(attachedHandle, source, stateIn)
    }
  )
```

(`LuaValue` is imported from `./scriptRuntime` alongside `ScriptRuntime` at the top of the file — extend the Step 3 import line above to `import { ScriptRuntime, type LuaValue } from './scriptRuntime'`.)

Add lifecycle clearing. In `attachTo`'s process-switch guard (`src/main/ipc.ts:402-418`), alongside the existing `hotkeyManager.unregisterAll()`:

```ts
    for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
      scriptRuntime.clear(cheat.id)
    }
```

In `watcher.onVanish` (`src/main/ipc.ts:560-576`), alongside `hotkeyManager.unregisterAll()`:

```ts
    for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
      scriptRuntime.clear(cheat.id)
    }
```

In `releaseTarget` (`src/main/ipc.ts:597-605`), alongside `hotkeyManager.unregisterAll()`:

```ts
  for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
    scriptRuntime.clear(cheat.id)
  }
```

(All three sites need `attachedExe` read BEFORE it's reset to `null` later in the same function, where applicable — `watcher.onVanish` resets `attachedExe = null` partway through its body; place the clearing loop before that reset, using the same ordering the existing `hotkeyManager.unregisterAll()` call already respects in each of these three functions.)

- [ ] **Step 4: Bridge `scripts:run` in preload/tamper.d.ts**

`src/preload/index.ts`, alongside `oneShot`:

```ts
  runScript: (source: string, stateIn: Record<string, string | number | boolean>) =>
    ipcRenderer.invoke('scripts:run', source, stateIn),
  toggleScript: (cheat: ScriptCheat, enabled: boolean) =>
    ipcRenderer.invoke('scripts:toggle', cheat, enabled),
  isScriptEnabled: (cheatId: string) => ipcRenderer.invoke('scripts:isEnabled', cheatId),
```

(`ScriptCheat` needs adding to this file's existing type-only import from `'../main/store'`.)

`src/renderer/src/tamper.d.ts`, alongside `oneShot`:

```ts
      // Runs `source` as a one-shot Lua chunk against the attached
      // process — used only by ScriptEditor's ad-hoc "Run enable/disable
      // now" test buttons, against a throwaway state (the script may not
      // even be saved yet). A saved script cheat's real enable/disable
      // goes through toggleScript below instead, so its `state` handoff
      // and enabled-flag stay correct regardless of whether it was last
      // toggled by a click or a hotkey. Throws 'not attached'.
      runScript: (
        source: string,
        stateIn: Record<string, string | number | boolean>
      ) => Promise<{
        success: boolean
        output: string[]
        error: string | null
        stateOut: Record<string, string | number | boolean>
      }>
      // The real, state-tracked toggle for a saved script cheat — routes
      // through ScriptRuntime (main/scriptRuntime.ts) exactly like a
      // hotkey firing this same cheat does.
      toggleScript: (cheat: ScriptCheat, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
      // Current ScriptRuntime-tracked enabled state for a script cheat —
      // pulled on CheatList mount to initialize each checkbox correctly
      // (mirrors getHotkeyConflicts' pull-based pattern above, for the
      // same reason: ScriptRuntime's state can already reflect a hotkey
      // fire that happened before this screen mounted).
      isScriptEnabled: (cheatId: string) => Promise<boolean>
```

- [ ] **Step 5: Typecheck and run tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/main/hotkeys.test.ts tests/main/ipc.test.ts`
Expected: both clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/hotkeys.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts tests/main/hotkeys.test.ts
git commit -m "Wire ScriptRuntime into ipc.ts/hotkeys.ts: scripts:run, hotkey firing, lifecycle, CT export"
```

---

### Task 8: `ScriptEditor` panel in `CheatList.tsx`

**Files:**
- Modify: `src/renderer/src/screens/CheatList.tsx`

**Interfaces:**
- Consumes: `window.tamper.runScript`/`saveCheat` (Task 7), `isScriptCheat`-equivalent local guard (this task adds `isScript`, mirroring the file's existing local `isPatch` at `src/renderer/src/screens/CheatList.tsx:14`).

- [ ] **Step 1: Add the local `isScript` guard and script state**

Near the existing `isPatch` guard (`src/renderer/src/screens/CheatList.tsx:14-18`, which is deliberately local rather than imported from `main`, per that function's existing comment):

```tsx
function isScript(cheat: StoredCheat): cheat is ScriptCheat {
  return (cheat as ScriptCheat).kind === 'script'
}
```

Add `ScriptCheat` to this file's existing type-only import from `../../../main/store`.

Add state near the file's other panel-open state (follow whatever pattern the existing patch-capture panel already uses for its own open/closed state):

```tsx
const [scripts, setScripts] = useState<ScriptCheat[]>([])
const [scriptEnabled, setScriptEnabled] = useState<Record<string, boolean>>({})
const [editingScript, setEditingScript] = useState<ScriptCheat | null>(null)
const [scriptOutput, setScriptOutput] = useState<string[] | null>(null)
const [scriptError, setScriptError] = useState<string | null>(null)
```

Update the existing cheat-load split (`src/renderer/src/screens/CheatList.tsx:264-265` and `:429-430`) to also bucket scripts, and pull each one's current `ScriptRuntime`-tracked enabled state (mirroring how `getHotkeyConflicts` is pulled once on mount elsewhere in this file, for the identical reason: `ScriptRuntime`'s state can already reflect a hotkey fire that happened before this screen mounted):

```tsx
setCheats(all.filter((c): c is CheatDefinition => !isPatch(c) && !isScript(c)))
setPatches(all.filter(isPatch))
const loadedScripts = all.filter(isScript)
setScripts(loadedScripts)
const enabledEntries = await Promise.all(
  loadedScripts.map(async (s) => [s.id, await window.tamper.isScriptEnabled(s.id)] as const)
)
setScriptEnabled(Object.fromEntries(enabledEntries))
```

- [ ] **Step 2: Add the panel and list rows**

Add a new section rendering `scripts`, following the existing patch-list `<li>` structure (`src/renderer/src/screens/CheatList.tsx:1445` onward) for visual consistency — enable/disable checkbox wired to a new `toggleScript` function, plus an "Edit script" button opening the editor:

```tsx
async function toggleScript(script: ScriptCheat, enabled: boolean) {
  setScriptError(null)
  // Routed through ScriptRuntime (scripts:toggle), not a raw scripts:run
  // call — this keeps the enable->disable `state` handoff and the
  // enabled-flag correct regardless of whether this cheat was last
  // toggled by a click or a hotkey (see this plan's Task 7).
  const result = await window.tamper.toggleScript(script, enabled)
  if (!result.ok) {
    setScriptError(result.error ?? 'Script failed.')
    return
  }
  setScriptEnabled((prev) => ({ ...prev, [script.id]: enabled }))
}

async function saveScript(script: ScriptCheat) {
  await window.tamper.saveCheat(exeName, script)
  setEditingScript(null)
  const all = await window.tamper.loadCheats(exeName)
  setScripts(all.filter(isScript))
}

async function testScript(source: string) {
  setScriptError(null)
  // Deliberately the raw scripts:run call (not toggleScript) — this is
  // ScriptEditor's ad-hoc test button, running against a throwaway state,
  // possibly against a script that hasn't been saved yet at all.
  const result = await window.tamper.runScript(source, {})
  if (!result.success) setScriptError(result.error ?? 'Script failed.')
  setScriptOutput(result.output)
}
```

```tsx
<ul>
  {scripts.map((script) => (
    <li key={script.id} style={{ flexWrap: 'wrap' }}>
      <input
        type="checkbox"
        checked={scriptEnabled[script.id] ?? false}
        onChange={(e) => void toggleScript(script, e.target.checked)}
      />
      <span>{script.name}</span>
      <button onClick={() => setEditingScript(script)}>Edit script</button>
    </li>
  ))}
  <li>
    <button
      onClick={() =>
        setEditingScript({
          kind: 'script',
          id: `script-${Date.now()}`,
          name: 'New Script',
          enableScript: '',
          disableScript: ''
        })
      }
    >
      + New Script
    </button>
  </li>
</ul>

{scriptError && (
  <div className="banner banner-error">
    {scriptError}
    <button onClick={() => setScriptError(null)}>Dismiss</button>
  </div>
)}
{scriptOutput && scriptOutput.length > 0 && (
  <div className="banner">
    <pre>{scriptOutput.join('\n')}</pre>
    <button onClick={() => setScriptOutput(null)}>Dismiss</button>
  </div>
)}

{editingScript && (
  <div className="script-editor">
    <input
      value={editingScript.name}
      onChange={(e) => setEditingScript({ ...editingScript, name: e.target.value })}
    />
    <label>Enable script</label>
    <textarea
      value={editingScript.enableScript}
      onChange={(e) => setEditingScript({ ...editingScript, enableScript: e.target.value })}
    />
    <button onClick={() => void testScript(editingScript.enableScript)}>Run enable now</button>
    <label>Disable script</label>
    <textarea
      value={editingScript.disableScript}
      onChange={(e) => setEditingScript({ ...editingScript, disableScript: e.target.value })}
    />
    <button onClick={() => void testScript(editingScript.disableScript)}>Run disable now</button>
    <div>
      <button onClick={() => void saveScript(editingScript)}>Save</button>
      <button onClick={() => setEditingScript(null)}>Cancel</button>
    </div>
  </div>
)}
```

Place this JSX in the same region of the render tree as the existing patch list section, following that section's existing surrounding structure/headings.

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: both clean.

- [ ] **Step 4: Manual verification**

Create a new script cheat with `enableScript: 'print("hi", readInt32(0x0))'`, click "Run enable now" with nothing meaningful at `0x0` — confirm the error banner shows a read failure rather than crashing the renderer. Save a script with valid enable/disable bodies against a real attached target, toggle its checkbox on and off, confirm the game memory actually changes (verify via the harness or Memory Viewer from the other plan). Set a hotkey on a script cheat and confirm pressing it fires the same way a value cheat's hotkey does (on/off sound, `hotkey:fired` banner on error).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/CheatList.tsx
git commit -m "Add ScriptEditor panel: create, edit, test, and toggle script cheats"
```

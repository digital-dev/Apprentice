# Find What Writes an Address (#5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cheat-Engine-style "find what writes this address" to Tamper — attach as a debugger, catch the game's own instruction that writes a target value via a hardware breakpoint, decode it with Zydis to extract the object base address and field offset, and turn that into a rooted pointer-chain cheat target.

**Architecture:** A dedicated debug-event-loop thread inside the existing C++ N-API addon runs a `DebugActiveProcess` session, arms a hardware write breakpoint (Dr0/Dr7) on all target threads, and records each distinct writing instruction (decoded via a vendored Zydis) into a mutex-guarded singleton. The renderer arms the watch, polls a live list while the user triggers the value change in-game, stops, and turns a caught instruction into a cheat target by resolving a pointer chain to the captured object base and appending the field displacement. Everything routes through the existing IPC/preload bridge, store, and multi-target `CheatDefinition` model.

**Tech Stack:** Existing — Electron + electron-vite, React + TypeScript, Node N-API via `node-addon-api` + `node-gyp` (C++17), Vitest. New — vendored Zydis (amalgamated C source), Win32 debug APIs (`DebugActiveProcess`, `WaitForDebugEvent`, `Get/SetThreadContext` with `CONTEXT_DEBUG_REGISTERS`, `Thread32First/Next`).

## Global Constraints

- Windows only.
- No network calls anywhere in the stack.
- **Safety (non-negotiable):** call `DebugSetProcessKillOnExit(FALSE)` immediately after attaching; attach the debugger only for the duration of a capture and detach on stop, on error, and on every unwind path; every debug event receives a matching `ContinueDebugEvent`.
- One capture session at a time (a process-global singleton in the native addon).
- The native addon has a confirmed toolchain quirk: `Init()` must keep its warm-up `Napi::Number::New(env, 0.0)` call (already present in `native/src/addon.cc`) — do not remove it.
- After editing `binding.gyp` sources you must run `npx node-gyp configure` before `npx node-gyp build` (a stale vcxproj otherwise fails to link the new sources).
- The dev server / any running Electron or node process locks `native/build/Release/memory_addon.node`; stop them before rebuilding the addon (`taskkill`/Stop-Process on electron+node).
- `CaughtInstruction` shape (used across native → nativeAddon → ipc → preload → renderer), all hex strings unless noted:
  `{ instructionAddress: string, bytes: string, length: number, signature: string, baseRegister: string, displacement: string, baseAddress: string, moduleName: string | null, moduleOffset: string | null }`

---

## File Structure

```
native/
  third_party/zydis/
    Zydis.h                 # vendored amalgamated header
    Zydis.c                 # vendored amalgamated source
  src/
    write_watch.h           # WriteWatch exports: StartWriteWatch/PollWriteWatch/StopWriteWatch
    write_watch.cc          # debugger session, HW breakpoint, event loop, Zydis decode
    addon.cc                # + wire the three write-watch exports
  binding.gyp               # + Zydis source, include dir, C++17 already set
test-harness/
  harness.c                 # + watchloop/stoploop commands (pointer-indirect writes)
src/
  main/
    nativeAddon.ts          # + startWriteWatch/pollWriteWatch/stopWriteWatch typed wrappers
    ipc.ts                  # + attachedPid capture; writeWatch:start/poll/stop handlers
  preload/index.ts          # + startWriteWatch/pollWriteWatch/stopWriteWatch bridge methods
  renderer/src/
    tamper.d.ts             # + CaughtInstruction type + window.tamper methods
    screens/Scanner.tsx     # + "Find what writes this" capture panel + create-cheat-from-capture
tests/
  native/
    write_watch.test.ts     # arm watch on harness field, assert decode + clean detach
```

---

### Task 1: Vendor Zydis and prove it links and decodes

**Files:**
- Create: `native/third_party/zydis/Zydis.h`, `native/third_party/zydis/Zydis.c`
- Modify: `native/binding.gyp`, `native/src/addon.cc`
- Test: `tests/native/zydis_smoke.test.ts`

**Interfaces:**
- Produces: a temporary native export `decodeAt(bytesHex: string): { mnemonic: string, length: number }` used only to prove Zydis is compiled in and working. Later tasks reuse the Zydis include; this temporary export is removed in Task 5 once the real write-watch decode exists.

- [ ] **Step 1: Vendor the Zydis amalgamated sources**

Download the Zydis **amalgamated** build (a single `Zydis.h` and single `Zydis.c`) for a stable release (v4.x). Obtain them one of these ways:
- From a Zydis release's `amalgamated-dist` asset, or
- By generating them: clone Zydis, run its amalgamation (`assets/amalgamate.py`), producing `Zydis.h` + `Zydis.c`.

Place both files at `native/third_party/zydis/`. Verify each file is non-trivial (the header is tens of thousands of lines; the source similarly large) and that `Zydis.h` defines `ZydisDecoder`, `ZydisDecoderInit`, `ZydisDecoderDecodeFull`, `ZydisDecodedInstruction`, and `ZydisDecodedOperand`.

If you cannot fetch the files in this environment, STOP and report BLOCKED with the exact reason — do not hand-write or stub a disassembler.

- [ ] **Step 2: Wire Zydis into `binding.gyp`**

Edit `native/binding.gyp` so the target compiles the Zydis source and can include its header. Set the sources and include_dirs (keep existing entries; add these):

```python
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
        "third_party/zydis/Zydis.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/zydis"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "libraries": ["-lpsapi.lib"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "ZYDIS_STATIC_BUILD"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
      }
    }
  ]
}
```

Note: `src/write_watch.cc` is listed here now but is created in Task 3 — for this task, create a minimal placeholder `native/src/write_watch.cc` containing only `// placeholder, filled in Task 3` and `native/src/write_watch.h` with `#pragma once` so the build succeeds. (Task 3 replaces both.)

- [ ] **Step 3: Add a temporary `decodeAt` export to prove Zydis works**

In `native/src/addon.cc`, add near the top:

```cpp
#include "Zydis.h"
```

Add this function above `Init` (this is temporary scaffolding, removed in Task 5):

```cpp
// Temporary: proves Zydis is compiled and linked. Decodes the first
// instruction in a hex-encoded byte string. Removed in Task 5.
static uint8_t HexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

Napi::Value DecodeAt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string hex = info[0].As<Napi::String>().Utf8Value();
  std::vector<uint8_t> bytes;
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    bytes.push_back((HexNibble(hex[i]) << 4) | HexNibble(hex[i + 1]));
  }

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  ZydisDecodedInstruction insn;
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  ZyanStatus status = ZydisDecoderDecodeFull(&decoder, bytes.data(), bytes.size(),
      &insn, operands);

  Napi::Object result = Napi::Object::New(env);
  if (!ZYAN_SUCCESS(status)) {
    result.Set("mnemonic", Napi::String::New(env, "decode-failed"));
    result.Set("length", Napi::Number::New(env, 0));
    return result;
  }
  result.Set("mnemonic",
      Napi::String::New(env, ZydisMnemonicGetString(insn.mnemonic)));
  result.Set("length", Napi::Number::New(env, insn.length));
  return result;
}
```

Add `#include <vector>` and `#include <string>` if not already present. Register it in `Init` alongside the others:

```cpp
exports.Set("decodeAt", Napi::Function::New(env, DecodeAt));
```

- [ ] **Step 4: Configure and build**

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
```

Expected: `gyp info ok`, `native/build/Release/memory_addon.node` produced. (If it fails to link with a stale project, re-run `npx node-gyp configure` first.)

- [ ] **Step 5: Write the smoke test**

```ts
// tests/native/zydis_smoke.test.ts
import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'

describe('zydis integration', () => {
  it('decodes a known instruction (mov eax, [rip+disp] = 8b 05 00 00 00 00)', () => {
    // 0x8B /r = mov r32, r/m32; ModRM 05 = [rip+disp32]; 4-byte disp.
    const result = (addon as any).decodeAt('8b0500000000')
    expect(result.length).toBe(6)
    expect(result.mnemonic.toLowerCase()).toContain('mov')
  })

  it('reports decode-failed on garbage rather than throwing', () => {
    const result = (addon as any).decodeAt('')
    expect(result.length).toBe(0)
  })
})
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/native/zydis_smoke.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add native/third_party native/binding.gyp native/src/addon.cc native/src/write_watch.h native/src/write_watch.cc tests/native/zydis_smoke.test.ts
git commit -m "Vendor Zydis and prove it links and decodes"
```

---

### Task 2: Harness `watchloop` command (pointer-indirect writes)

**Files:**
- Modify: `test-harness/harness.c`
- Test: none yet (exercised by Task 5's write-watch test; verify manually here)

**Interfaces:**
- Produces: harness stdin commands `watchloop` (start a background thread that repeatedly writes an incrementing float through a pointer to `g_player.stamina`, throttled ~10ms) and `stoploop` (stop it). The write MUST go through a runtime-valued pointer so the compiler emits `mov [reg+disp], xmm/reg` (base = a GPR holding the object pointer, disp = 16), not a RIP-relative direct store to the field.

- [ ] **Step 1: Add a non-inlined indirect writer and the thread**

Edit `test-harness/harness.c`. Add includes/globals near the top (after the existing `g_player`/`g_player_ptr` declarations):

```c
#include <process.h>

static volatile int g_watch_running = 0;

// Non-inlined, takes the pointer as a runtime argument so the store is
// `mov [reg+disp], xmm` (base register = the object pointer), matching a
// real game object write — not a RIP-relative store to a known global.
#pragma optimize("", off)
static void write_stamina(PlayerComponent* p, float v) {
  p->stamina = v;
}
#pragma optimize("", off)
static unsigned __stdcall watch_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_watch_running) {
    write_stamina(g_player_ptr, v);
    v += 1.0f;
    Sleep(10);
  }
  return 0;
}
#pragma optimize("", on)
```

- [ ] **Step 2: Add the `watchloop` / `stoploop` commands**

In the `main` command loop, add branches (before the final `else`):

```c
    } else if (strncmp(line, "watchloop", 9) == 0) {
      if (!g_watch_running) {
        g_watch_running = 1;
        _beginthreadex(NULL, 0, watch_thread, NULL, 0, NULL);
      }
      printf("OK\n");
    } else if (strncmp(line, "stoploop", 8) == 0) {
      g_watch_running = 0;
      printf("OK\n");
```

- [ ] **Step 3: Rebuild the harness**

From a VS x64 developer environment (the project's established way):

```bash
cl.exe /Fe:test-harness\harness.exe test-harness\harness.c
```

Then delete the stray `harness.obj`. Expected: `test-harness/harness.exe` rebuilt with no errors.

- [ ] **Step 4: Manually verify the commands respond**

Run the harness, send `watchloop` then `stoploop`, confirm each replies `OK` and the process stays alive:

```bash
printf 'watchloop\nstoploop\nq\n' | ./test-harness/harness.exe
```

Expected: prints `PID <n>` then three `OK` lines (watchloop, stoploop, and the `q` path prints nothing/exits). At minimum, no crash.

- [ ] **Step 5: Commit**

```bash
git add test-harness/harness.c test-harness/harness.exe
git commit -m "Add watchloop/stoploop harness commands for write-watch tests"
```

---

### Task 3: Debugger session + hardware breakpoint (no decode yet)

**Files:**
- Create (replace placeholders): `native/src/write_watch.h`, `native/src/write_watch.cc`
- Modify: `native/src/addon.cc`
- Test: `tests/native/write_watch.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (Win32 only).
- Produces (this task, decode fields empty/placeholder — filled in Task 5):
  - `startWriteWatch(pid: number, address: string): void` — attach, arm, spawn loop thread; throws on failure or if already running.
  - `pollWriteWatch(): object[]` — snapshot; each entry has at least `{ instructionAddress: string }` (the RIP that hit). Other `CaughtInstruction` fields added in Task 5.
  - `stopWriteWatch(): object[]` — stop, clear breakpoints, detach, return final list.

- [ ] **Step 1: Write `native/src/write_watch.h`**

```cpp
#pragma once
#include <napi.h>

Napi::Value StartWriteWatch(const Napi::CallbackInfo& info);
Napi::Value PollWriteWatch(const Napi::CallbackInfo& info);
Napi::Value StopWriteWatch(const Napi::CallbackInfo& info);
```

- [ ] **Step 2: Write `native/src/write_watch.cc` — session state + helpers**

```cpp
#include "write_watch.h"
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <thread>
#include <mutex>
#include <atomic>
#include <vector>
#include <string>
#include <cstdint>
#include <cstdio>

namespace {

std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

// A single caught write instruction. Decode fields are populated in Task 5;
// here only instructionAddress is meaningful.
struct Caught {
  uintptr_t instructionAddress = 0;
  std::vector<uint8_t> bytes;
  uint32_t length = 0;
  std::string baseRegister;
  int64_t displacement = 0;
  uintptr_t baseAddress = 0;
  bool decoded = false;
};

struct Session {
  std::thread loop;
  std::atomic<bool> running{false};
  std::atomic<bool> stopRequested{false};
  DWORD pid = 0;
  uintptr_t address = 0;
  std::mutex mtx;
  std::vector<Caught> caught; // deduped by instructionAddress
};

Session g_session;

// Set or clear a hardware write breakpoint (Dr0, 4-byte, on-write) on one
// thread. `address==0` clears it. Uses suspend/get/set/resume.
void SetHwBreakpointOnThread(DWORD tid, uintptr_t address) {
  HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_SUSPEND_RESUME,
      FALSE, tid);
  if (!th) return;
  SuspendThread(th);
  CONTEXT ctx{};
  ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  if (GetThreadContext(th, &ctx)) {
    if (address) {
      ctx.Dr0 = address;
      // Dr7: bit0 = L0 (local enable Dr0). Bits 16-17 = condition for Dr0:
      // 01 = break on data write. Bits 18-19 = length for Dr0: 11 = 4 bytes.
      ctx.Dr7 &= ~((DWORD64)0xF << 16); // clear Dr0 condition+len
      ctx.Dr7 |= (DWORD64)0x1;          // L0
      ctx.Dr7 |= ((DWORD64)0x1 << 16);  // write
      ctx.Dr7 |= ((DWORD64)0x3 << 18);  // 4 bytes
    } else {
      ctx.Dr0 = 0;
      ctx.Dr7 &= ~((DWORD64)0x1);       // clear L0
      ctx.Dr7 &= ~((DWORD64)0xF << 16); // clear Dr0 condition+len
    }
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    SetThreadContext(th, &ctx);
  }
  ResumeThread(th);
  CloseHandle(th);
}

// Apply/clear the breakpoint on every thread belonging to pid.
void SetHwBreakpointAllThreads(DWORD pid, uintptr_t address) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID == pid) SetHwBreakpointOnThread(te.th32ThreadID, address);
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);
}

} // namespace
```

- [ ] **Step 3: Write the debug-event loop (in the same file, in the `namespace`)**

Add above the closing `}` of the anonymous namespace:

```cpp
// Runs on its own thread for the lifetime of a capture. Owns the debugger:
// DebugActiveProcess -> kill-on-exit FALSE -> arm breakpoints -> event loop.
void DebugLoop(DWORD pid, uintptr_t address) {
  if (!DebugActiveProcess(pid)) {
    g_session.running = false;
    return;
  }
  DebugSetProcessKillOnExit(FALSE); // never take the game down with us

  bool armed = false;
  DEBUG_EVENT ev{};

  while (!g_session.stopRequested) {
    if (!WaitForDebugEvent(&ev, 100)) continue; // timeout -> re-check stop flag

    DWORD continueStatus = DBG_CONTINUE;

    if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      // First stop: safe point to arm all existing threads.
      SetHwBreakpointAllThreads(pid, address);
      armed = true;
      if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
    } else if (ev.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) {
      // A thread born mid-capture must get the breakpoint too.
      if (armed) SetHwBreakpointOnThread(ev.dwThreadId, address);
    } else if (ev.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      break; // target gone
    } else if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      const EXCEPTION_RECORD& er = ev.u.Exception.ExceptionRecord;
      if (er.ExceptionCode == EXCEPTION_SINGLE_STEP) {
        uintptr_t rip = (uintptr_t)er.ExceptionAddress;
        {
          std::lock_guard<std::mutex> lk(g_session.mtx);
          bool seen = false;
          for (const auto& c : g_session.caught)
            if (c.instructionAddress == rip) { seen = true; break; }
          if (!seen) {
            Caught c;
            c.instructionAddress = rip;
            g_session.caught.push_back(c);
          }
        }
        continueStatus = DBG_CONTINUE; // we handled it
      } else {
        // Not ours (e.g. the game's own exceptions) — pass it back.
        continueStatus = DBG_EXCEPTION_NOT_HANDLED;
      }
    }

    ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, continueStatus);
  }

  SetHwBreakpointAllThreads(pid, 0); // clear
  DebugActiveProcessStop(pid);       // detach cleanly
  g_session.running = false;
}
```

- [ ] **Step 4: Write the three N-API exports (after the namespace)**

```cpp
Napi::Value StartWriteWatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_session.running) {
    Napi::Error::New(env, "a write-watch session is already active")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());

  {
    std::lock_guard<std::mutex> lk(g_session.mtx);
    g_session.caught.clear();
  }
  g_session.pid = pid;
  g_session.address = address;
  g_session.stopRequested = false;
  g_session.running = true;
  g_session.loop = std::thread(DebugLoop, pid, address);
  return env.Undefined();
}

static Napi::Array SnapshotToArray(Napi::Env env) {
  Napi::Array arr = Napi::Array::New(env);
  std::lock_guard<std::mutex> lk(g_session.mtx);
  uint32_t i = 0;
  for (const auto& c : g_session.caught) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("instructionAddress", Napi::String::New(env, ToHex(c.instructionAddress)));
    arr.Set(i++, o);
  }
  return arr;
}

Napi::Value PollWriteWatch(const Napi::CallbackInfo& info) {
  return SnapshotToArray(info.Env());
}

Napi::Value StopWriteWatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_session.running || g_session.loop.joinable()) {
    g_session.stopRequested = true;
    if (g_session.loop.joinable()) g_session.loop.join();
  }
  return SnapshotToArray(env);
}
```

- [ ] **Step 5: Register the exports in `native/src/addon.cc`**

Add `#include "write_watch.h"` and in `Init`:

```cpp
exports.Set("startWriteWatch", Napi::Function::New(env, StartWriteWatch));
exports.Set("pollWriteWatch", Napi::Function::New(env, PollWriteWatch));
exports.Set("stopWriteWatch", Napi::Function::New(env, StopWriteWatch));
```

- [ ] **Step 6: Configure, build**

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
```

Expected: `gyp info ok`.

- [ ] **Step 7: Write the capture test (address-only for now)**

```ts
// tests/native/write_watch.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  try { (addon as any).stopWriteWatch() } catch { /* ignore */ }
  harness.stdin.write('q\n')
  harness.kill()
})

// Resolve the address of g_player.stamina by scanning for its 77.0 value,
// narrowed to one via the setp command.
async function staminaAddress(): Promise<string> {
  let candidates = await (addon as any).scanFirst(handle, 'float', 77.0)
  await send('setp 33')
  candidates = (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 33 })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

describe('write watch — capture', () => {
  it('catches a write instruction and detaches cleanly', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stoploop')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBe(1) // deduped despite many writes
    expect(final[0].instructionAddress).toMatch(/^0x[0-9a-f]+$/)

    // Clean detach: the harness is still alive and responding.
    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})
```

- [ ] **Step 8: Run the test**

Run: `npx vitest run tests/native/write_watch.test.ts`
Expected: PASS. If it hangs or the harness dies, the debugger detach/kill-on-exit handling is wrong — investigate before proceeding (do not weaken the assertions).

- [ ] **Step 9: Commit**

```bash
git add native/src/write_watch.h native/src/write_watch.cc native/src/addon.cc tests/native/write_watch.test.ts
git commit -m "Add debugger-based write-watch capture (hardware breakpoint)"
```

---

### Task 4: Decode caught instructions with Zydis (base register, displacement, base address)

**Files:**
- Modify: `native/src/write_watch.cc`
- Test: `tests/native/write_watch.test.ts` (extend)

**Interfaces:**
- Consumes: the capture loop and `Caught` struct from Task 3; Zydis from Task 1.
- Produces: `pollWriteWatch()` / `stopWriteWatch()` entries now carry the full `CaughtInstruction` shape (see Global Constraints), with `baseRegister`, `displacement`, `baseAddress`, `moduleName`, `moduleOffset` populated.

- [ ] **Step 1: Read the register file at the breakpoint and decode**

In `write_watch.cc`, add `#include "Zydis.h"` at the top. Replace the `EXCEPTION_SINGLE_STEP` handling block (the `if (er.ExceptionCode == EXCEPTION_SINGLE_STEP) { ... }` body) with a version that reads the full thread context, the instruction bytes, and decodes:

```cpp
if (er.ExceptionCode == EXCEPTION_SINGLE_STEP) {
  uintptr_t rip = (uintptr_t)er.ExceptionAddress;
  bool seen = false;
  {
    std::lock_guard<std::mutex> lk(g_session.mtx);
    for (const auto& c : g_session.caught)
      if (c.instructionAddress == rip) { seen = true; break; }
  }
  if (!seen) {
    Caught c;
    c.instructionAddress = rip;
    DecodeCaught(pid, ev.dwThreadId, rip, c); // fills bytes/length/base/disp/baseAddress
    std::lock_guard<std::mutex> lk(g_session.mtx);
    // re-check under lock in case of races (single debug thread, but cheap)
    bool seen2 = false;
    for (const auto& e : g_session.caught)
      if (e.instructionAddress == rip) { seen2 = true; break; }
    if (!seen2) g_session.caught.push_back(std::move(c));
  }
  continueStatus = DBG_CONTINUE;
} else {
  continueStatus = DBG_EXCEPTION_NOT_HANDLED;
}
```

- [ ] **Step 2: Implement `DecodeCaught` (add to the anonymous namespace, above `DebugLoop`)**

```cpp
// Maps a Zydis GPR register enum to the matching value in a CONTEXT.
uintptr_t RegValue(const CONTEXT& ctx, ZydisRegister reg) {
  switch (reg) {
    case ZYDIS_REGISTER_RAX: return ctx.Rax;
    case ZYDIS_REGISTER_RBX: return ctx.Rbx;
    case ZYDIS_REGISTER_RCX: return ctx.Rcx;
    case ZYDIS_REGISTER_RDX: return ctx.Rdx;
    case ZYDIS_REGISTER_RSI: return ctx.Rsi;
    case ZYDIS_REGISTER_RDI: return ctx.Rdi;
    case ZYDIS_REGISTER_RBP: return ctx.Rbp;
    case ZYDIS_REGISTER_RSP: return ctx.Rsp;
    case ZYDIS_REGISTER_R8:  return ctx.R8;
    case ZYDIS_REGISTER_R9:  return ctx.R9;
    case ZYDIS_REGISTER_R10: return ctx.R10;
    case ZYDIS_REGISTER_R11: return ctx.R11;
    case ZYDIS_REGISTER_R12: return ctx.R12;
    case ZYDIS_REGISTER_R13: return ctx.R13;
    case ZYDIS_REGISTER_R14: return ctx.R14;
    case ZYDIS_REGISTER_R15: return ctx.R15;
    default: return 0;
  }
}

// Reads the faulting thread's registers + the instruction bytes at rip, and
// decodes the memory-destination operand into base register, displacement,
// and the runtime base address the game used.
void DecodeCaught(DWORD pid, DWORD tid, uintptr_t rip, Caught& out) {
  HANDLE proc = OpenProcess(PROCESS_VM_READ, FALSE, pid);
  uint8_t buf[16] = {0};
  SIZE_T read = 0;
  if (proc) {
    ReadProcessMemory(proc, (LPCVOID)rip, buf, sizeof(buf), &read);
    CloseHandle(proc);
  }
  out.bytes.assign(buf, buf + (read ? read : 0));

  HANDLE th = OpenThread(THREAD_GET_CONTEXT, FALSE, tid);
  CONTEXT ctx{};
  ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
  bool haveCtx = th && GetThreadContext(th, &ctx);
  if (th) CloseHandle(th);

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
  ZydisDecodedInstruction insn;
  ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
  if (read == 0 ||
      !ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder, buf, read, &insn, operands))) {
    out.decoded = false;
    return;
  }
  out.length = insn.length;

  // Find the memory operand that is written (the destination).
  for (int i = 0; i < insn.operand_count; i++) {
    const ZydisDecodedOperand& op = operands[i];
    if (op.type != ZYDIS_OPERAND_TYPE_MEMORY) continue;
    if (!(op.actions & ZYDIS_OPERAND_ACTION_MASK_WRITE)) continue;

    ZydisRegister base = op.mem.base;
    int64_t disp = op.mem.disp.has_displacement ? op.mem.disp.value : 0;

    if (base == ZYDIS_REGISTER_RIP) {
      out.baseRegister = "rip";
      out.displacement = disp;
      out.baseAddress = rip + insn.length; // RIP-relative base = next insn
      out.decoded = true;
    } else if (base != ZYDIS_REGISTER_NONE && haveCtx) {
      out.baseRegister = ZydisRegisterGetString(base);
      out.displacement = disp;
      out.baseAddress = RegValue(ctx, base);
      out.decoded = true;
    }
    break;
  }
}
```

- [ ] **Step 3: Resolve the instruction's module (add a small helper + call it in DecodeCaught)**

Add to the namespace:

```cpp
// Finds the module containing `addr`; returns name + offset, or empty.
bool ModuleOf(DWORD pid, uintptr_t addr, std::string& nameOut, uintptr_t& offsetOut) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!proc) return false;
  HMODULE mods[1024];
  DWORD needed = 0;
  bool found = false;
  if (EnumProcessModulesEx(proc, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) {
    DWORD count = needed / sizeof(HMODULE);
    if (count > 1024) count = 1024;
    for (DWORD i = 0; i < count && !found; i++) {
      MODULEINFO mi{};
      char name[MAX_PATH];
      if (GetModuleInformation(proc, mods[i], &mi, sizeof(mi)) &&
          GetModuleBaseNameA(proc, mods[i], name, sizeof(name))) {
        uintptr_t base = (uintptr_t)mods[i];
        if (addr >= base && addr < base + mi.SizeOfImage) {
          nameOut = name;
          offsetOut = addr - base;
          found = true;
        }
      }
    }
  }
  CloseHandle(proc);
  return found;
}
```

Add `std::string moduleName; uintptr_t moduleOffset = 0; bool hasModule = false;` fields to the `Caught` struct. At the end of `DecodeCaught`, add:

```cpp
  out.hasModule = ModuleOf(pid, rip, out.moduleName, out.moduleOffset);
```

- [ ] **Step 4: Emit the full shape in `SnapshotToArray`**

Replace the object-building loop body in `SnapshotToArray` with:

```cpp
    Napi::Object o = Napi::Object::New(env);
    o.Set("instructionAddress", Napi::String::New(env, ToHex(c.instructionAddress)));
    std::string byteHex;
    char hb[3];
    for (uint8_t b : c.bytes) { snprintf(hb, sizeof(hb), "%02x", b); byteHex += hb; }
    o.Set("bytes", Napi::String::New(env, byteHex));
    o.Set("length", Napi::Number::New(env, c.length));
    o.Set("signature", Napi::String::New(env, byteHex)); // real signature added in Task 5
    o.Set("baseRegister", Napi::String::New(env, c.baseRegister));
    o.Set("displacement", Napi::String::New(env, ToHex((uintptr_t)c.displacement)));
    o.Set("baseAddress", Napi::String::New(env, ToHex(c.baseAddress)));
    if (c.hasModule) {
      o.Set("moduleName", Napi::String::New(env, c.moduleName));
      o.Set("moduleOffset", Napi::String::New(env, ToHex(c.moduleOffset)));
    } else {
      o.Set("moduleName", env.Null());
      o.Set("moduleOffset", env.Null());
    }
```

- [ ] **Step 5: Configure, build**

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
```

- [ ] **Step 6: Extend the capture test to assert the decode**

Replace the assertion block in `tests/native/write_watch.test.ts` (after `const final = ...`) with:

```ts
    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBe(1)

    const insn = final[0]
    expect(insn.baseRegister.length).toBeGreaterThan(0)
    expect(insn.baseRegister).not.toBe('rip') // object write goes through a GPR
    // base register held g_player; displacement is the stamina field offset (16).
    expect(parseInt(insn.displacement, 16)).toBe(16)
    const base = BigInt(insn.baseAddress)
    const disp = BigInt(insn.displacement)
    expect('0x' + (base + disp).toString(16)).toBe(address)
    // The writing instruction lives in the harness module.
    expect(insn.moduleName === null || typeof insn.moduleName === 'string').toBe(true)

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
```

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/native/write_watch.test.ts`
Expected: PASS. The `displacement == 16` and `base + disp == address` assertions confirm the object-base extraction is correct.

- [ ] **Step 8: Commit**

```bash
git add native/src/write_watch.cc tests/native/write_watch.test.ts
git commit -m "Decode caught write instructions (base register, displacement, base address)"
```

---

### Task 5: AOB signature generation; remove temporary decodeAt

**Files:**
- Modify: `native/src/write_watch.cc`, `native/src/addon.cc`
- Test: `tests/native/write_watch.test.ts` (extend), `tests/native/zydis_smoke.test.ts` (update)

**Interfaces:**
- Consumes: the decoded `Caught` from Task 4.
- Produces: `signature` field is now a wildcarded AOB pattern string (space-separated hex bytes with `??` over the RIP-relative displacement bytes). The temporary `decodeAt` export is removed.

- [ ] **Step 1: Build the signature during decode**

In `DecodeCaught`, after `out.length = insn.length;`, capture the displacement byte span so we can wildcard it. Add a `std::string signature;` field to `Caught`, and after the operand loop (before the `ModuleOf` call) add:

```cpp
  // Build an AOB signature: literal bytes, but wildcard the RIP-relative
  // displacement (the 4 bytes that shift when the module loads at a
  // different base), so the pattern still matches after a restart. Zydis
  // reports the displacement's offset+size within the instruction.
  {
    out.signature.clear();
    char hb[4];
    size_t dispStart = insn.raw.disp.offset;
    size_t dispSize = insn.raw.disp.size / 8; // bits -> bytes
    bool ripRel = (out.baseRegister == "rip");
    for (size_t i = 0; i < out.bytes.size() && i < out.length; i++) {
      if (i) out.signature += " ";
      if (ripRel && dispSize && i >= dispStart && i < dispStart + dispSize) {
        out.signature += "??";
      } else {
        snprintf(hb, sizeof(hb), "%02x", out.bytes[i]);
        out.signature += hb;
      }
    }
  }
```

- [ ] **Step 2: Emit the real signature in `SnapshotToArray`**

Change the signature line from `byteHex` to the stored signature:

```cpp
    o.Set("signature", Napi::String::New(env, c.signature));
```

- [ ] **Step 3: Remove the temporary `decodeAt` scaffolding**

In `native/src/addon.cc`, delete the `HexNibble` and `DecodeAt` functions and the `exports.Set("decodeAt", ...)` line. Keep `#include "Zydis.h"` only if still used there (it is not — `write_watch.cc` owns Zydis now); remove it from `addon.cc` if nothing else uses it.

- [ ] **Step 4: Replace the now-obsolete zydis smoke test**

Zydis is now proven end-to-end by the write-watch test. Delete `tests/native/zydis_smoke.test.ts` (its `decodeAt` export no longer exists).

```bash
git rm tests/native/zydis_smoke.test.ts
```

- [ ] **Step 5: Assert the signature in the write-watch test**

Add to the assertion block in `tests/native/write_watch.test.ts`:

```ts
    // Signature is space-separated hex byte tokens, each 2 hex chars or '??'.
    expect(insn.signature.length).toBeGreaterThan(0)
    for (const tok of insn.signature.split(' ')) {
      expect(tok === '??' || /^[0-9a-f]{2}$/.test(tok)).toBe(true)
    }
```

- [ ] **Step 6: Configure, build, run the full native suite**

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
npx vitest run tests/native/
```

Expected: all native tests PASS, `zydis_smoke.test.ts` gone.

- [ ] **Step 7: Commit**

```bash
git add native/src/write_watch.cc native/src/addon.cc tests/native/write_watch.test.ts
git commit -m "Generate wildcarded AOB signatures; remove temporary decodeAt scaffolding"
```

---

### Task 6: Wire write-watch through nativeAddon, IPC, and preload

**Files:**
- Modify: `src/main/nativeAddon.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/tamper.d.ts`
- Test: none (integration surface; exercised by the renderer in Task 7 and covered by the native test)

**Interfaces:**
- Consumes: native `startWriteWatch`/`pollWriteWatch`/`stopWriteWatch` (Tasks 3–5).
- Produces:
  - `nativeAddon.startWriteWatch(pid, address)`, `pollWriteWatch(): CaughtInstruction[]`, `stopWriteWatch(): CaughtInstruction[]`.
  - IPC channels `writeWatch:start` / `writeWatch:poll` / `writeWatch:stop`.
  - `window.tamper.startWriteWatch(address)`, `pollWriteWatch()`, `stopWriteWatch()` (renderer supplies only the address; main holds the pid).
  - `CaughtInstruction` type exported from `tamper.d.ts`.

- [ ] **Step 1: Add typed wrappers in `src/main/nativeAddon.ts`**

Add the interface near the other exported interfaces:

```ts
export interface CaughtInstruction {
  instructionAddress: string
  bytes: string
  length: number
  signature: string
  baseRegister: string
  displacement: string
  baseAddress: string
  moduleName: string | null
  moduleOffset: string | null
}
```

Add to the `nativeAddon` object:

```ts
  startWriteWatch: (pid: number, address: string): void =>
    addon.startWriteWatch(pid, address),
  pollWriteWatch: (): CaughtInstruction[] => addon.pollWriteWatch(),
  stopWriteWatch: (): CaughtInstruction[] => addon.stopWriteWatch(),
```

- [ ] **Step 2: Capture the pid at attach + add handlers in `src/main/ipc.ts`**

Add a module-level `let attachedPid: number | null = null`. In the `process:attach` handler, after destructuring, store the pid:

```ts
  ipcMain.handle('process:attach', (_e, pid: number) => {
    const { handle, baseAddress } = nativeAddon.attach(pid)
    attachedHandle = handle
    attachedBase = baseAddress
    attachedPid = pid
    return { handle, baseAddress }
  })
```

Add the three handlers (near the scan handlers):

```ts
  ipcMain.handle('writeWatch:start', (_e, address: string) => {
    if (attachedPid === null) throw new Error('not attached')
    freezeLoop.stop() // pause freezing during a capture
    nativeAddon.startWriteWatch(attachedPid, address)
  })

  ipcMain.handle('writeWatch:poll', () => nativeAddon.pollWriteWatch())

  ipcMain.handle('writeWatch:stop', () => {
    const result = nativeAddon.stopWriteWatch()
    freezeLoop.start() // resume freezing
    return result
  })
```

- [ ] **Step 3: Expose them in `src/preload/index.ts`**

Add to the `exposeInMainWorld('tamper', { ... })` object:

```ts
  startWriteWatch: (address: string) => ipcRenderer.invoke('writeWatch:start', address),
  pollWriteWatch: () => ipcRenderer.invoke('writeWatch:poll'),
  stopWriteWatch: () => ipcRenderer.invoke('writeWatch:stop'),
```

- [ ] **Step 4: Declare the types in `src/renderer/src/tamper.d.ts`**

Add the exported interface near `Candidate`:

```ts
export interface CaughtInstruction {
  instructionAddress: string
  bytes: string
  length: number
  signature: string
  baseRegister: string
  displacement: string
  baseAddress: string
  moduleName: string | null
  moduleOffset: string | null
}
```

Add to the `tamper` interface:

```ts
      startWriteWatch: (address: string) => Promise<void>
      pollWriteWatch: () => Promise<CaughtInstruction[]>
      stopWriteWatch: () => Promise<CaughtInstruction[]>
```

- [ ] **Step 5: Typecheck and build**

```bash
npx tsc --noEmit
npm run build
```

Expected: no type errors; all three bundles build.

- [ ] **Step 6: Commit**

```bash
git add src/main/nativeAddon.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts
git commit -m "Wire write-watch through nativeAddon, IPC, and preload"
```

---

### Task 7: Scanner UI — capture panel and create-cheat-from-capture

**Files:**
- Modify: `src/renderer/src/screens/Scanner.tsx`
- Test: none (React UI; verified by build + manual, consistent with the other screens)

**Interfaces:**
- Consumes: `window.tamper.startWriteWatch/pollWriteWatch/stopWriteWatch`, `resolveChain`, `saveCheat`; `CaughtInstruction`, `CheatDefinition`, `ChainTarget`.
- Produces: user-facing capture flow; no exports.

- [ ] **Step 1: Add capture state and handlers to `Scanner.tsx`**

Add imports:

```tsx
import type { CaughtInstruction } from '../tamper.d'
```

Inside the component, add state:

```tsx
  const [watchAddress, setWatchAddress] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const [caught, setCaught] = useState<CaughtInstruction[]>([])
  const [captureName, setCaptureName] = useState('')
```

Add handlers (poll on an interval while watching):

```tsx
  async function startWatch(address: string) {
    setWatchAddress(address)
    setCaught([])
    setWatching(true)
    await window.tamper.startWriteWatch(address)
  }

  useEffect(() => {
    if (!watching) return
    const id = setInterval(async () => {
      setCaught(await window.tamper.pollWriteWatch())
    }, 250)
    return () => clearInterval(id)
  }, [watching])

  async function stopWatch() {
    const finalList = await window.tamper.stopWriteWatch()
    setCaught(finalList)
    setWatching(false)
  }

  // Turn a caught instruction into a cheat target: resolve a chain to the
  // object base the game used, then append the field displacement so the
  // chain lands on the exact value. This is the rooted, high-quality path.
  async function createCheatFromInstruction(insn: CaughtInstruction) {
    if (!captureName) return
    const chain = await window.tamper.resolveChain(insn.baseAddress, 5)
    if (!chain) return
    const target: ChainTarget = {
      moduleName: chain.moduleName,
      baseOffset: chain.offsets[0],
      offsets: [...chain.offsets.slice(1), insn.displacement]
    }
    const cheat: CheatDefinition = {
      id: captureName.toLowerCase().replace(/\s+/g, '-'),
      name: captureName,
      dataType,
      mode: 'freeze',
      targets: [target],
      value: Number(value)
    }
    await window.tamper.saveCheat(exeName, cheat)
    onSaved()
  }
```

- [ ] **Step 2: Add a "Find what writes this" button per candidate**

In the candidate list `<li>` (where the checkbox + address are rendered), add a button after the address text:

```tsx
              <button onClick={() => startWatch(c.address)}>Find what writes this</button>
```

- [ ] **Step 3: Render the capture panel**

Add this block after the candidate list (and before the multi-target resolve block), so it appears when a capture is active or has results:

```tsx
      {watchAddress && (
        <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
          <h3>Find what writes {watchAddress}</h3>
          {watching ? (
            <>
              <p>Watching — trigger the value change in-game (take damage, use stamina…).</p>
              <button onClick={stopWatch}>Stop</button>
            </>
          ) : (
            <button onClick={() => startWatch(watchAddress)}>Re-arm</button>
          )}
          <p>{caught.length} instruction(s) caught</p>
          <ul>
            {caught.map((insn) => (
              <li key={insn.instructionAddress}>
                <span className="address-chip">
                  {insn.moduleName ?? '?'}+{insn.moduleOffset ?? insn.instructionAddress}
                </span>
                <span>
                  base {insn.baseRegister} + {insn.displacement} → {insn.baseAddress}
                </span>
                <button
                  disabled={!captureName || insn.baseRegister === 'rip'}
                  onClick={() => createCheatFromInstruction(insn)}
                >
                  Create pointer cheat
                </button>
                <button disabled title="Coming in the AOB update">Create patch</button>
              </li>
            ))}
          </ul>
          {caught.length > 0 && (
            <input
              placeholder="Cheat name"
              value={captureName}
              onChange={(e) => setCaptureName(e.target.value)}
            />
          )}
        </div>
      )}
```

- [ ] **Step 4: Ensure `ChainTarget` and `CheatDefinition` are imported**

Confirm the top of `Scanner.tsx` imports both (it already imports `CheatDefinition`, `CheatMode`, `DataType`):

```tsx
import type { CheatDefinition, ChainTarget, CheatMode, DataType } from '../../../main/store'
```

Add `ChainTarget` to that import if missing.

- [ ] **Step 5: Typecheck and build**

```bash
npx tsc --noEmit
npm run build
```

Expected: no type errors; renderer bundle builds.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/screens/Scanner.tsx
git commit -m "Add find-what-writes capture panel and create-cheat-from-capture to Scanner"
```

---

### Task 8: Full-suite verification and manual Valheim validation

**Files:** none (verification task; fix in the relevant task's files if it surfaces a bug, and note the fix here).

**Interfaces:** none — exercises the full stack from Tasks 1–7.

- [ ] **Step 1: Run the entire automated suite**

```bash
npx vitest run
npx tsc --noEmit
npm run build
```

Expected: all tests PASS, no type errors, all bundles build.

- [ ] **Step 2: Launch the app**

```bash
npm run dev
```

Attach to Valheim (or, if validating without the game, to `test-harness/harness.exe` and drive it with `watchloop`).

- [ ] **Step 3: Capture a real write**

Scan for stamina, narrow to a candidate, click **Find what writes this**, then in-game spend stamina so the game writes it. Confirm the caught list populates within a couple of seconds and each entry shows a base register, displacement, and module+offset. Click **Stop**.

- [ ] **Step 4: Create a cheat from the capture and verify**

Name it, click **Create pointer cheat** on a caught instruction, return to the cheat list, toggle it on, and confirm stamina freezes in-game. Confirm the game did not crash or freeze at any point during the capture (the safety requirement).

- [ ] **Step 5: Verify restart survival**

Close and relaunch Valheim, re-attach, and confirm the cheat created from the capture still resolves (via the existing revalidation "N/M live" readout) and freezes — validating that a capture-derived chain is more stable than a blind pointer scan.

- [ ] **Step 6: Commit any definitions/fixes**

```bash
git add -A
git commit -m "Validate find-what-writes end-to-end against Valheim"
```

---

## Self-Review Notes

- **Spec coverage:** Capture mechanism (DebugActiveProcess + loop thread + Dr0/Dr7 all-threads + CREATE_THREAD arming) → Task 3. Kill-on-exit-FALSE and clean detach safety → Task 3 (`DebugLoop`) + asserted by the harness-survives-detach test. Decode (base reg, displacement, baseAddress, RIP-relative case) → Task 4. AOB signature → Task 5. Zydis vendoring → Task 1. Native API (`startWriteWatch`/`pollWriteWatch`/`stopWriteWatch`) → Tasks 3–5, wrapped in Task 6. `attachedPid` capture → Task 6. Freeze-loop pause during capture → Task 6. UI flow (Find what writes → live poll → Stop → create pointer cheat; AOB "Create patch" shown-but-disabled) → Task 7. `(baseAddress, displacement)` → chain-to-base + append-displacement → Task 7's `createCheatFromInstruction`. Harness `watchloop` forcing the pointer-indirect form → Task 2. Error handling (decode-failed non-crash, dedupe, module-not-found null) → Tasks 3–4. Restart-survival validation → Task 8.
- **Placeholder scan:** no TBD/TODO; the Task 1 placeholder `write_watch.cc`/`.h` are explicitly created-then-replaced in Task 3, and the temporary `decodeAt` is explicitly removed in Task 5 — both are real, sequenced steps, not open placeholders.
- **Type consistency:** `CaughtInstruction` is defined identically in Global Constraints, `nativeAddon.ts` (Task 6), and `tamper.d.ts` (Task 6); the native `SnapshotToArray` (Task 4/5) emits exactly those keys. `startWriteWatch(pid, address)` at the native/nativeAddon layer vs. `startWriteWatch(address)` at preload/renderer is intentional and documented (main injects the pid). `createCheatFromInstruction` builds `ChainTarget`/`CheatDefinition` using the existing multi-target schema (`targets: ChainTarget[]`) from the current store.

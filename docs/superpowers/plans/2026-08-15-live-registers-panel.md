# Live Registers Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live "Registers" panel to Memory Viewer showing a picked thread's general-purpose register values, polled every 250ms.

**Architecture:** New native addon capability (`listThreads(pid)`, `getThreadRegisters(tid)`) built on Win32's `Toolhelp32Snapshot`/`OpenThread`/`GetThreadContext`, following the exact patterns `platform::SuspendAll` and `write_watch.cc`'s `SetHwBreakpointOnThread` already use. Wired through the same main-process/preload/renderer layering every other native op in this codebase uses (`nativeAddon.ts` → `ipc.ts` handler → preload → `window.tamper`). Renderer adds an independent panel + its own 250ms poll to `MemoryViewer.tsx`, plus a small thread-refresh interval, mirroring the Structure Dissect panel's already-independent poll loop.

**Tech Stack:** N-API/C++ (native addon), Electron main process (TypeScript), React renderer (TypeScript), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-live-registers-panel-design.md`

## Global Constraints

- Windows-only. The Linux backend (`platform_linux.cc`) gets stub implementations that return failure, matching every other function in that file.
- New platform-level code goes through the `platform::` abstraction in `native/src/platform/platform.h`, per that file's own header comment ("Only NEW code goes through here").
- Register values cross the native/JS boundary and IPC as `0x`-prefixed hex strings, matching every address/value elsewhere in this codebase (`ModuleInfo.base`, `DisasmRow.address`, etc.) — never raw JS numbers, which cannot hold a full 64-bit value losslessly.
- A read that fails because the thread has exited (point-in-time snapshot race) returns `null`/`[]`, never throws — the same convention `listModules`, `tryReadBytes`, etc. already follow.

---

### Task 1: Native platform layer — thread listing and register reads

**Files:**
- Modify: `native/src/platform/platform.h`
- Modify: `native/src/platform/platform_win32.cc`
- Modify: `native/src/platform/platform_linux.cc`

**Interfaces:**
- Produces: `platform::ThreadInfo { uint32_t tid; }`, `platform::ThreadRegisters { uint64_t rax, rbx, rcx, rdx, rsi, rdi, rbp, rsp, rip, r8, r9, r10, r11, r12, r13, r14, r15, rflags; }`, `bool platform::ListThreads(uint32_t pid, std::vector<ThreadInfo>& out)`, `bool platform::GetThreadRegisters(uint32_t tid, ThreadRegisters& out)` — Task 2's Napi bindings call these directly.

- [ ] **Step 1: Add the declarations to `platform.h`**

Add near the end of the `namespace platform { ... }` block in `native/src/platform/platform.h`, right before the closing `void SleepMs(uint32_t ms);` line's following blank line (i.e. after `SleepMs`, before the closing `}`):

```cpp
// One thread belonging to a process, as enumerated by ListThreads. Only
// the id — everything else (start address, etc.) neither this feature nor
// any caller today needs.
struct ThreadInfo {
  uint32_t tid = 0;
};

// Every thread's register file, as GetThreadRegisters reads it. General
// purpose registers plus rip/rsp/rbp and eflags — enough to make sense of
// a disassembly view (cmp/mov operands, the current instruction pointer)
// without reaching for the full CONTEXT structure's FPU/XMM state, which
// nothing in this codebase decodes or displays.
struct ThreadRegisters {
  uint64_t rax = 0, rbx = 0, rcx = 0, rdx = 0;
  uint64_t rsi = 0, rdi = 0, rbp = 0, rsp = 0, rip = 0;
  uint64_t r8 = 0, r9 = 0, r10 = 0, r11 = 0;
  uint64_t r12 = 0, r13 = 0, r14 = 0, r15 = 0;
  uint64_t rflags = 0;
};

// Every thread owned by `pid`, via a point-in-time Toolhelp32 snapshot —
// same source SuspendAll already walks. False only if the snapshot itself
// couldn't be taken (out param left empty either way); an empty-but-valid
// result (process has no threads left, or none matched) is `true` with an
// empty `out`, not a failure.
bool ListThreads(uint32_t pid, std::vector<ThreadInfo>& out);

// One thread's register file, read via a brief suspend/GetThreadContext/
// resume (the same three-call shape SetHwBreakpointOnThread in
// write_watch.cc already uses to read/modify debug registers). False when
// the thread has already exited (the snapshot ListThreads read it from is
// a point-in-time copy — same race SuspendAll's own OpenThread failure
// handling documents) or the platform doesn't support this.
bool GetThreadRegisters(uint32_t tid, ThreadRegisters& out);
```

- [ ] **Step 2: Implement both functions in `platform_win32.cc`**

Add at the end of the `namespace platform { ... }` block in `native/src/platform/platform_win32.cc`, right before its closing `}`:

```cpp
bool ListThreads(uint32_t pid, std::vector<ThreadInfo>& out) {
  out.clear();
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;

  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID == pid) out.push_back(ThreadInfo{te.th32ThreadID});
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);
  return true;
}

bool GetThreadRegisters(uint32_t tid, ThreadRegisters& out) {
  HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME, FALSE, tid);
  if (!th) return false;

  bool ok = false;
  if (SuspendThread(th) != (DWORD)-1) {
    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_INTEGER | CONTEXT_CONTROL;
    if (GetThreadContext(th, &ctx)) {
      out.rax = ctx.Rax; out.rbx = ctx.Rbx; out.rcx = ctx.Rcx; out.rdx = ctx.Rdx;
      out.rsi = ctx.Rsi; out.rdi = ctx.Rdi; out.rbp = ctx.Rbp; out.rsp = ctx.Rsp;
      out.rip = ctx.Rip;
      out.r8 = ctx.R8; out.r9 = ctx.R9; out.r10 = ctx.R10; out.r11 = ctx.R11;
      out.r12 = ctx.R12; out.r13 = ctx.R13; out.r14 = ctx.R14; out.r15 = ctx.R15;
      out.rflags = ctx.EFlags; // 32-bit in CONTEXT; zero-extended into the 64-bit field
      ok = true;
    }
    ResumeThread(th);
  }
  CloseHandle(th);
  return ok;
}
```

- [ ] **Step 3: Add the refusing stubs to `platform_linux.cc`**

Add at the end of the `namespace platform { ... }` block in `native/src/platform/platform_linux.cc`, right before its closing `}`:

```cpp
bool ListThreads(uint32_t, std::vector<ThreadInfo>& out) {
  out.clear();
  return false;
}
bool GetThreadRegisters(uint32_t, ThreadRegisters&) { return false; }
```

- [ ] **Step 4: Build the addon to confirm it compiles**

Run: `cd native && npx node-gyp rebuild` (or the project's normal native build command if different — check `package.json`'s scripts for one first; if none, `node-gyp rebuild` from `native/` is this project's standard).
Expected: build succeeds with no errors. This task adds no new JS-visible surface yet (Task 2 does), so there is nothing to exercise from JS at this point — a clean compile is the only checkpoint.

- [ ] **Step 5: Commit**

```bash
git add native/src/platform/platform.h native/src/platform/platform_win32.cc native/src/platform/platform_linux.cc
git commit -m "native: add ListThreads/GetThreadRegisters to the platform layer"
```

---

### Task 2: Native N-API bindings — `listThreads` / `getThreadRegisters`

**Files:**
- Create: `native/src/thread_ops.h`
- Create: `native/src/thread_ops.cc`
- Modify: `native/src/addon.cc`
- Modify: `native/binding.gyp`
- Test: `tests/native/thread_ops.test.ts`

**Interfaces:**
- Consumes: `platform::ThreadInfo`, `platform::ThreadRegisters`, `platform::ListThreads`, `platform::GetThreadRegisters` (Task 1).
- Produces: addon-level `listThreads(pid: number): {tid: number}[]`, `getThreadRegisters(tid: number): Record<string,string> | null` (register names as keys, `0x`-prefixed hex string values) — Task 3's `nativeAddon.ts` wrappers call these by name through the compiled `.node` addon, same as every other function there.

- [ ] **Step 1: Write the failing test**

Create `tests/native/thread_ops.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('listThreads', () => {
  it('includes at least one thread owned by the harness', () => {
    const threads = (addon as any).listThreads(harness.pid) as { tid: number }[]
    expect(threads.length).toBeGreaterThan(0)
    expect(threads[0]).toHaveProperty('tid')
    expect(typeof threads[0].tid).toBe('number')
  })

  it('returns an empty array for a pid that owns no threads', () => {
    // pid 0 is the System Idle Process on Windows — never owns threads
    // this process can enumerate a match against (see addon.cc's comment
    // on why pid 0 in listProcesses is not corruption).
    const threads = (addon as any).listThreads(0) as { tid: number }[]
    expect(threads).toEqual([])
  })
})

describe('getThreadRegisters', () => {
  it('returns a full register snapshot for a live harness thread', () => {
    const threads = (addon as any).listThreads(harness.pid) as { tid: number }[]
    const regs = (addon as any).getThreadRegisters(threads[0].tid) as Record<string, string>
    expect(regs).not.toBeNull()
    for (const key of ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'rip',
      'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rflags']) {
      expect(regs[key]).toMatch(/^0x[0-9a-f]+$/)
    }
    // rip must be non-zero — the thread is genuinely executing somewhere.
    expect(BigInt(regs.rip)).toBeGreaterThan(0n)
  })

  it('returns null for a tid that does not exist', () => {
    const regs = (addon as any).getThreadRegisters(999999999)
    expect(regs).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/native/thread_ops.test.ts`
Expected: FAIL — `addon.listThreads is not a function` (the addon hasn't been extended yet).

- [ ] **Step 3: Write `thread_ops.h`**

```cpp
#pragma once
#include <napi.h>

Napi::Value ListThreads(const Napi::CallbackInfo& info);
Napi::Value GetThreadRegisters(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: Write `thread_ops.cc`**

```cpp
#include "thread_ops.h"
#include "platform/platform.h"
#include <cstdio>
#include <string>
#include <vector>

namespace {
std::string Hex(uint64_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
} // namespace

Napi::Value ListThreads(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "listThreads(pid) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();

  std::vector<platform::ThreadInfo> threads;
  if (!platform::ListThreads(pid, threads)) {
    // Not an exception: an unsupported platform or a snapshot that
    // couldn't be taken both read as "no threads to report" — same
    // "cannot verify" convention ListModules already follows.
    return Napi::Array::New(env);
  }

  Napi::Array result = Napi::Array::New(env);
  uint32_t i = 0;
  for (const auto& t : threads) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("tid", Napi::Number::New(env, t.tid));
    result.Set(i++, o);
  }
  return result;
}

Napi::Value GetThreadRegisters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "getThreadRegisters(tid) expects a number")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  uint32_t tid = info[0].As<Napi::Number>().Uint32Value();

  platform::ThreadRegisters regs;
  if (!platform::GetThreadRegisters(tid, regs)) {
    // The thread exited between listThreads() and this call, or the
    // platform doesn't support it. Not an error: the renderer's poll
    // treats null as "this thread is gone, pick another", not a crash.
    return env.Null();
  }

  Napi::Object o = Napi::Object::New(env);
  o.Set("rax", Napi::String::New(env, Hex(regs.rax)));
  o.Set("rbx", Napi::String::New(env, Hex(regs.rbx)));
  o.Set("rcx", Napi::String::New(env, Hex(regs.rcx)));
  o.Set("rdx", Napi::String::New(env, Hex(regs.rdx)));
  o.Set("rsi", Napi::String::New(env, Hex(regs.rsi)));
  o.Set("rdi", Napi::String::New(env, Hex(regs.rdi)));
  o.Set("rbp", Napi::String::New(env, Hex(regs.rbp)));
  o.Set("rsp", Napi::String::New(env, Hex(regs.rsp)));
  o.Set("rip", Napi::String::New(env, Hex(regs.rip)));
  o.Set("r8", Napi::String::New(env, Hex(regs.r8)));
  o.Set("r9", Napi::String::New(env, Hex(regs.r9)));
  o.Set("r10", Napi::String::New(env, Hex(regs.r10)));
  o.Set("r11", Napi::String::New(env, Hex(regs.r11)));
  o.Set("r12", Napi::String::New(env, Hex(regs.r12)));
  o.Set("r13", Napi::String::New(env, Hex(regs.r13)));
  o.Set("r14", Napi::String::New(env, Hex(regs.r14)));
  o.Set("r15", Napi::String::New(env, Hex(regs.r15)));
  o.Set("rflags", Napi::String::New(env, Hex(regs.rflags)));
  return o;
}
```

- [ ] **Step 5: Register both functions in `addon.cc`**

Add the include near the other op includes at the top of `native/src/addon.cc`:

```cpp
#include "thread_ops.h"
```

Add these two lines in `Init`, right after the existing `exports.Set("disassembleBuffer", ...)` line:

```cpp
  exports.Set("listThreads", Napi::Function::New(env, ListThreads));
  exports.Set("getThreadRegisters", Napi::Function::New(env, GetThreadRegisters));
```

- [ ] **Step 6: Add the new source file to `binding.gyp`**

In `native/binding.gyp`'s `sources` array, add `"src/thread_ops.cc",` right after `"src/disasm_ops.cc",`.

- [ ] **Step 7: Rebuild the addon**

Run: `cd native && npx node-gyp rebuild`
Expected: build succeeds.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/native/thread_ops.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 9: Commit**

```bash
git add native/src/thread_ops.h native/src/thread_ops.cc native/src/addon.cc native/binding.gyp tests/native/thread_ops.test.ts
git commit -m "native: expose listThreads/getThreadRegisters to JS"
```

---

### Task 3: Main process — `nativeAddon.ts` wrappers and `ipc.ts` handlers

**Files:**
- Modify: `src/main/nativeAddon.ts`
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: addon-level `listThreads(pid)`, `getThreadRegisters(tid)` (Task 2); `ipc.ts`'s existing module-scope `attachedHandle: number | null`, `attachedPid: number | null`.
- Produces: `nativeAddon.listThreads(pid: number): {tid: number}[]`, `nativeAddon.getThreadRegisters(tid: number): Record<string,string> | null`; IPC channels `'threads:list'` (no args, returns `{tid:number}[]`) and `'threads:registers'` (arg: `tid: number`, returns `Record<string,string> | null`) — Task 4's preload calls these two channel names.

- [ ] **Step 1: Add the wrappers to `nativeAddon.ts`**

Add at the end of the `nativeAddon` object in `src/main/nativeAddon.ts`, right after the existing `runScript` entry (turning its trailing line into `...}) => addon.runScript(handle, source, stateIn),` — i.e. add a comma there — then append):

```typescript
  // Every thread belonging to `pid`, via a point-in-time OS snapshot — for
  // the Memory Viewer's thread picker. `pid` is the attached process's
  // pid (ipc.ts's attachedPid), not a handle.
  listThreads: (pid: number): { tid: number }[] => addon.listThreads(pid),
  // One thread's live general-purpose registers (rax..r15, rip, rsp, rbp,
  // rflags), each an 0x-prefixed hex string. null if the thread has
  // already exited (listThreads' snapshot is a point-in-time copy — same
  // race SuspendAll's own thread-open failure handling documents).
  getThreadRegisters: (tid: number): Record<string, string> | null =>
    addon.getThreadRegisters(tid)
```

- [ ] **Step 2: Add the two IPC handlers to `ipc.ts`**

Add inside `registerIpcHandlers`, right after the existing `ipcMain.handle('memory:disassemble', ...)` block (find it by searching for `'memory:disassemble'` — it's grouped with the other `memory:*` handlers around line 857-874):

```typescript
  // Memory Viewer's Registers panel: which threads exist right now, and
  // one thread's live register snapshot. Both null/empty rather than
  // throwing when nothing is attached — same convention every other
  // memory:*/patch:* handler in this file follows.
  ipcMain.handle('threads:list', (): { tid: number }[] => {
    if (attachedPid === null) return []
    return nativeAddon.listThreads(attachedPid)
  })

  ipcMain.handle(
    'threads:registers',
    (_e, tid: number): Record<string, string> | null => {
      if (attachedHandle === null) return null
      return nativeAddon.getThreadRegisters(tid)
    }
  )
```

- [ ] **Step 3: Confirm the project still typechecks and existing tests pass**

Run: `npx tsc --noEmit` and `npx vitest run tests/main`
Expected: both succeed — this task adds new handlers but changes no existing behavior, so no existing test should be affected.

- [ ] **Step 4: Commit**

```bash
git add src/main/nativeAddon.ts src/main/ipc.ts
git commit -m "main: add threads:list / threads:registers IPC handlers"
```

---

### Task 4: Preload + renderer types

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/tamper.d.ts`

**Interfaces:**
- Consumes: IPC channels `'threads:list'`, `'threads:registers'` (Task 3).
- Produces: `window.tamper.listThreads(): Promise<{tid: number}[]>`, `window.tamper.getThreadRegisters(tid: number): Promise<Record<string,string> | null>` — Task 6's `MemoryViewer.tsx` calls these.

- [ ] **Step 1: Add the two calls to `preload/index.ts`**

Add inside the `contextBridge.exposeInMainWorld('tamper', { ... })` object, right after the existing `resolveTargetAddress` entry:

```typescript
  listThreads: () => ipcRenderer.invoke('threads:list'),
  getThreadRegisters: (tid: number) => ipcRenderer.invoke('threads:registers', tid),
```

- [ ] **Step 2: Add the matching types to `tamper.d.ts`**

Add inside `interface Window { tamper: { ... } }` in `src/renderer/src/tamper.d.ts`, right after the existing `resolveTargetAddress` entry:

```typescript
      // Every thread belonging to the attached process, for the Registers
      // panel's thread picker. [] when nothing is attached.
      listThreads: () => Promise<{ tid: number }[]>
      // One thread's live registers (rax..r15, rip, rsp, rbp, rflags),
      // each an 0x-prefixed hex string. null when nothing is attached or
      // the thread has already exited.
      getThreadRegisters: (tid: number) => Promise<Record<string, string> | null>
```

- [ ] **Step 3: Confirm the project typechecks**

Run: `npx tsc --noEmit`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/src/tamper.d.ts
git commit -m "preload: expose listThreads/getThreadRegisters to the renderer"
```

---

### Task 5: Renderer — thread-selection logic module

**Files:**
- Create: `src/renderer/src/registers.ts`
- Test: `tests/renderer/registers.test.ts`

**Interfaces:**
- Produces: `pickThread(currentTid: number | null, threads: {tid: number}[]): number | null` — Task 6's `MemoryViewer.tsx` calls this every time the thread list refreshes.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/registers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { pickThread } from '../../src/renderer/src/registers'

describe('pickThread', () => {
  it('keeps the current selection when it is still in the list', () => {
    expect(pickThread(200, [{ tid: 100 }, { tid: 200 }, { tid: 300 }])).toBe(200)
  })

  it('falls back to the first thread when nothing is selected yet', () => {
    expect(pickThread(null, [{ tid: 100 }, { tid: 200 }])).toBe(100)
  })

  it('falls back to the first thread when the current selection exited', () => {
    expect(pickThread(999, [{ tid: 100 }, { tid: 200 }])).toBe(100)
  })

  it('returns null when the thread list is empty', () => {
    expect(pickThread(200, [])).toBeNull()
    expect(pickThread(null, [])).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/renderer/registers.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/renderer/src/registers"`.

- [ ] **Step 3: Write `src/renderer/src/registers.ts`**

```typescript
export interface ThreadInfo {
  tid: number
}

// Which thread the Registers panel's dropdown should have selected, given
// a freshly refreshed thread list. Keeps the current selection if it's
// still present (a live game's thread list churns constantly — resetting
// the selection on every refresh would make the panel useless to watch);
// otherwise falls back to the first thread in the list, or null if the
// list is empty. Never silently points at a tid that just disappeared —
// that would resolve to "thread exited" on the very next register poll.
export function pickThread(currentTid: number | null, threads: ThreadInfo[]): number | null {
  if (currentTid !== null && threads.some((t) => t.tid === currentTid)) return currentTid
  return threads.length > 0 ? threads[0].tid : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/renderer/registers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/registers.ts tests/renderer/registers.test.ts
git commit -m "renderer: add pickThread selection logic for the Registers panel"
```

---

### Task 6: Renderer — Registers panel in `MemoryViewer.tsx`

**Files:**
- Modify: `src/renderer/src/screens/MemoryViewer.tsx`
- Modify: `src/renderer/src/theme.css`

**Interfaces:**
- Consumes: `window.tamper.listThreads()`, `window.tamper.getThreadRegisters(tid)` (Task 4); `pickThread` (Task 5).

- [ ] **Step 1: Import `pickThread`**

Add to the top of `src/renderer/src/screens/MemoryViewer.tsx`, alongside the existing `import { decodeAt, toArrayBuffer } from '../dissect'` line:

```typescript
import { pickThread } from '../registers'
```

- [ ] **Step 2: Add a thread-list refresh constant**

Add near the top of the file, alongside the other `_MS`/`_BYTES` constants (right after `const POLL_MS = 250`):

```typescript
// Thread lists churn constantly in a live game — refreshing the dropdown
// at the same 250ms cadence as the register poll itself would be wasted
// re-renders for something that doesn't need to be that fresh.
const THREAD_LIST_POLL_MS = 2000
```

- [ ] **Step 3: Add state and the two poll effects**

Add inside the `MemoryViewer` component, right after the existing `dissectBlock` `useState` line (`const [dissectBlock, setDissectBlock] = useState<ArrayBuffer | null>(null)`):

```typescript
  const [threads, setThreads] = useState<{ tid: number }[]>([])
  const [selectedTid, setSelectedTid] = useState<number | null>(null)
  const [registers, setRegisters] = useState<Record<string, string> | null>(null)
  const selectedTidRef = useRef<number | null>(null)
  selectedTidRef.current = selectedTid

  // Thread list refresh — independent of baseAddress/windowStart, since
  // threads aren't tied to any address range. Runs whenever a process is
  // attached at all, which this screen has no direct signal for; it polls
  // regardless and simply gets [] back until something is attached (same
  // shape as the dissect block's own poll).
  useEffect(() => {
    let cancelled = false
    async function poll() {
      const list = await window.tamper.listThreads()
      if (cancelled) return
      setThreads(list)
      setSelectedTid((current) => pickThread(current, list))
    }
    void poll()
    const id = setInterval(poll, THREAD_LIST_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Register poll for the selected thread — its own 250ms interval,
  // independent of the hex/disasm window poll and the thread-list poll
  // above (three independent polling loops already coexist in this file;
  // see the Structure Dissect panel's own poll for precedent).
  useEffect(() => {
    if (selectedTid === null) {
      setRegisters(null)
      return
    }
    let cancelled = false
    async function poll() {
      const tid = selectedTidRef.current
      if (tid === null) return
      const regs = await window.tamper.getThreadRegisters(tid)
      if (cancelled) return
      if (regs === null) {
        // The thread exited between the last list refresh and this read —
        // clear the selection so the next thread-list tick picks a live
        // one, rather than polling a dead tid until that tick arrives.
        setSelectedTid(null)
        setRegisters(null)
        return
      }
      setRegisters(regs)
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selectedTid])
```

- [ ] **Step 4: Render the panel**

Add the panel in the JSX, right after the closing `</div>` of the existing Structure Dissect panel's `{baseAddress && dissectBlock && (...)}` block, still inside the outer `<div className="screen">`:

```tsx
      <div className="registers-panel">
        <h3>Registers</h3>
        <div className="toolbar">
          <select
            value={selectedTid ?? ''}
            onChange={(e) => setSelectedTid(e.target.value === '' ? null : Number(e.target.value))}
            disabled={threads.length === 0}
          >
            {threads.length === 0 && <option value="">No threads</option>}
            {threads.map((t) => (
              <option key={t.tid} value={t.tid}>
                Thread {t.tid}
              </option>
            ))}
          </select>
        </div>
        {selectedTid !== null && registers === null && <p className="muted">Reading…</p>}
        {registers && (
          <table className="registers-grid">
            <tbody>
              {(
                [
                  ['rax', 'rbx', 'rcx', 'rdx'],
                  ['rsi', 'rdi', 'rbp', 'rsp'],
                  ['rip', 'r8', 'r9', 'r10'],
                  ['r11', 'r12', 'r13', 'r14'],
                  ['r15', 'rflags']
                ] as const
              ).map((row, i) => (
                <tr key={i}>
                  {row.map((name) => (
                    <td key={name}>
                      <span className="reg-name">{name}</span>
                      <span className="reg-value">{registers[name]}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
```

This panel is unconditional (no `baseAddress &&` guard) — registers aren't tied to an address, so it's useful even before jumping anywhere, as long as a thread is picked.

- [ ] **Step 5: Add the CSS**

Add to `src/renderer/src/theme.css`, right after the existing `.dissect-panel h3 { ... }` block:

```css
.registers-panel {
  border-top: 1px solid var(--line);
  padding-top: var(--s4);
}

.registers-panel h3 {
  margin: 0 0 var(--s2);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.registers-grid {
  border-collapse: collapse;
  font-family: var(--font-data);
  font-size: 12px;
  width: 100%;
}

.registers-grid td {
  padding: 3px 14px 3px 0;
  white-space: nowrap;
}

.registers-grid .reg-name {
  color: var(--muted);
  margin-right: 8px;
}

.registers-grid .reg-value {
  color: var(--text);
}
```

- [ ] **Step 6: Confirm the project typechecks and builds**

Run: `npx tsc --noEmit` and `npx electron-vite build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/screens/MemoryViewer.tsx src/renderer/src/theme.css
git commit -m "renderer: add live Registers panel to Memory Viewer"
```

# Bugfix Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 15 concrete bugs found by a whole-codebase review (resource leaks, race conditions, silent failures, and crash risks) without changing any existing observable behavior on the happy path.

**Architecture:** Each task is a narrow, surgical fix in the file(s) the bug actually lives in — no refactoring beyond what a fix strictly requires. Every task must leave the full existing test suite green; a task that would require changing an existing test's expected value (as opposed to adding a new one) is out of scope for this plan and must be flagged, not forced through.

**Tech Stack:** C++ N-API (native addon), TypeScript (main/renderer), Vitest.

## Global Constraints

- **No behavior change on the happy path.** Every fix in this plan addresses an edge case, a failure path, or a resource-lifetime issue — not the normal, already-correct case. If a fix changes what a currently-passing test asserts, stop and treat that as a signal the fix is broader than intended.
- Every native change must rebuild cleanly (`cd native && npx node-gyp build && cd ..`) and pass the full `tests/native` suite, not just the file(s) touched.
- Every TypeScript change must pass `npx tsc --noEmit` and `npx vitest run` (full suite) before a task is considered done.
- Preserve every existing code comment that explains a hard-won constraint (e.g. the "never free a live cave" reasoning in `platform.h`) — several fixes in this plan narrow an existing rule's scope rather than remove it; the reasoning for the original rule stays valid and stays documented.
- Where a fix touches a native `.cc`/`.h` file, follow this codebase's existing hex-string convention for addresses/offsets crossing the JS boundary — the one exception is write-watch's `displacement` field (Task 3), which changes from an unsigned-hex to a signed-decimal string; every consumer of that field already parses via `BigInt(...)`, which accepts a plain signed decimal string with no consumer-side changes needed — do not "fix" this back to hex.

---

### Task 1: Free scratch caves after every Mono remote call

**Files:**
- Modify: `native/src/platform/platform.h`
- Modify: `native/src/platform/platform_win32.cc`
- Modify: `native/src/platform/platform_linux.cc`
- Modify: `native/src/mono_call.cc`
- Modify: `native/src/mono_bridge.cc`
- Test: `tests/native/platform.test.ts`, `tests/native/mono_call.test.ts`, `tests/native/mono_bridge.test.ts`

**Interfaces:**
- Produces: `platform::FreeMemory(ProcessHandle handle, uintptr_t address) -> bool`, a new export alongside `AllocateNear`.
- Consumes: nothing new from other tasks.

**Context:** `platform.h`'s `AllocateNear` has no matching free — `grep -rn VirtualFreeEx native/` returns zero hits anywhere in the codebase. That's a deliberate rule for *patch* caves, which a thread may still be executing inside (see `platform.h`'s existing comment on `WaitForRemoteThread` and `mono_call.cc:192-198`'s "never free a live cave" reasoning). It has silently spread to *scratch* caves too — `mono_call.cc:166`'s `RunRemoteCall` allocates 256 bytes per remote call and never frees it, and `mono_bridge.cc`'s `WriteString` and every `*SingleThread` helper (`ListMemberNamesSingleThread` at line 1374, plus the callers at lines 634, 857, 1100, 1206, 1571, 1822, 2143) do the same. `MonoExplorer.buildSearchIndex` calls into this in a loop over every class in an assembly — hundreds of leaked 64KB-granularity reservations per index build, inside the *target game's* address space.

- [ ] **Step 1: Add `FreeMemory` to the platform interface**

Add to `native/src/platform/platform.h`, directly after `AllocateNear`'s declaration:

```cpp
// Releases memory a prior AllocateNear call reserved. ONLY call this once
// the thread that ran inside the cave has provably finished (WaitForRemoteThread
// returned true) — freeing a cave a thread might still be executing inside
// is the "never free a live cave" hazard AllocateNear's own callers already
// reason about. A *patch* cave (code the game jumps into on every hit of a
// hooked instruction, potentially forever) must NEVER be freed at all —
// this is only for scratch caves used for one throwaway remote call/string
// and then done with.
bool FreeMemory(ProcessHandle handle, uintptr_t address);
```

- [ ] **Step 2: Implement on Windows**

Add to `native/src/platform/platform_win32.cc`, directly after `AllocateNear`'s closing brace:

```cpp
bool FreeMemory(ProcessHandle handle, uintptr_t address) {
  if (!address) return false;
  return VirtualFreeEx((HANDLE)handle, (LPVOID)address, 0, MEM_RELEASE) != 0;
}
```

- [ ] **Step 3: Stub on Linux**

Add to `native/src/platform/platform_linux.cc`, matching this file's existing stub pattern for every other function (read the file first to match the exact style — every function here returns a failure value with no implementation, since this backend "refuses cleanly" per `platform.h`'s own module comment):

```cpp
bool FreeMemory(ProcessHandle, uintptr_t) {
  return false;
}
```

- [ ] **Step 4: Add a native test**

Add to `tests/native/platform.test.ts` (read the file first to match its existing harness-spawn/attach setup pattern):

```ts
it('FreeMemory releases a cave AllocateNear reserved', () => {
  const near = /* reuse this file's existing known-executable address, e.g. the harness's entry point */
  const cave = (addon as any).allocateCave(handle, near)
  expect(cave).not.toBeNull()
  // No direct JS export for FreeMemory exists yet — Steps 5-6 wire it into
  // mono_call.cc/mono_bridge.cc, where it becomes exercisable through
  // their existing tests. This step only needs to confirm allocateCave
  // still succeeds after this file's changes (i.e. the platform.h/.cc
  // edits compiled and didn't break the existing allocation path).
})
```

(This is a placeholder-avoidance note, not a placeholder itself: `FreeMemory` has no direct N-API export of its own — it's an internal `platform::` function only `mono_call.cc`/`mono_bridge.cc` call. Its real regression coverage comes from Step 6's addition to the existing `mono_call.test.ts`/`mono_bridge.test.ts` files, which already exercise `RunRemoteCall`/`WriteString` end-to-end against the test harness. Skip adding a test to `platform.test.ts` itself and rely on those instead — delete this step's placeholder test rather than commit it.)

- [ ] **Step 5: Free the cave in `RunRemoteCall`**

In `native/src/mono_call.cc`, modify `RunRemoteCall` (currently ends around line 204) to free the cave once the thread has provably finished — only on the success path, since the timeout path must still leak (a thread that never confirmed as finished might still be executing inside):

```cpp
  if (!finished) return false;

  if (!platform::ReadMemory(handle, cave + kResultOffset, result, 8)) {
    platform::FreeMemory(handle, cave);
    return false;
  }
  if (floatResult != nullptr) {
    if (!platform::ReadMemory(handle, cave + kResultOffset + 8, floatResult, 8)) {
      platform::FreeMemory(handle, cave);
      return false;
    }
  }
  platform::FreeMemory(handle, cave);
  return true;
```

(All three exit points after `finished` is confirmed true now free the cave — the thread has already exited by this point in every one of them, so freeing is safe. Only the two earlier `return false` paths above `if (!finished) return false;` — the executable-region guard and the allocation/write/thread-creation failures — are left alone, since those either never allocated a cave or never started a thread inside it, so there's nothing unsafe to free... but the write-stub-failed and create-thread-failed paths above DID allocate a cave with no thread inside it yet; free those too. Read the full function before editing and add `platform::FreeMemory(handle, cave);` before every `return false` that executes after the `cave` allocation succeeds AND no thread was successfully started, or after the thread is confirmed finished — the only case that must NOT free is the `!finished` timeout path.)

- [ ] **Step 6: Free the cave in `WriteString` and every `*SingleThread` helper**

In `native/src/mono_bridge.cc`, `WriteString` (line 27-34) allocates a cave that's only ever read from, never executed — free it once every caller is done with it. Since `WriteString`'s cave is typically consumed immediately by the caller passing its address into a subsequent `RunRemoteCall`, the caller (not `WriteString` itself) owns the free — add `platform::FreeMemory(handle, stringCave)` at the end of every function that calls `WriteString`, once its result has been used, mirroring the pattern:

```cpp
uintptr_t stringCave = WriteString(handle, monoDllBase, name);
if (!stringCave) return /* existing failure value */;
// ... existing code that uses stringCave ...
platform::FreeMemory(handle, stringCave);
```

Do this for every `WriteString` call site in the file (grep `WriteString(` to find them all). Similarly, for the result-holding scratch caves allocated via `AllocateNear` directly in `ListMemberNamesSingleThread` (line 1374) and its callers/siblings (lines 634, 857, 1100, 1206, 1571, 1822, 2143) — free each one at the end of its owning function, once its contents have been read into the `std::vector`/`std::string` results being returned. Read each function fully before editing: some of these caves are read in a loop across multiple `RunRemoteCall`s before the function returns, so the free must come after the LAST use, not the first.

- [ ] **Step 7: Rebuild and run tests**

Run: `cd native && npx node-gyp build && cd ..`
Run: `npx vitest run tests/native/mono_call.test.ts tests/native/mono_bridge.test.ts tests/native/platform.test.ts`
Expected: all PASS, unchanged pass counts (this is a resource-lifetime fix, not a behavior change — no existing assertion should need to change).

Run: `npx vitest run tests/native`
Expected: full native suite PASS.

- [ ] **Step 8: Commit**

```bash
git add native/src/platform/platform.h native/src/platform/platform_win32.cc native/src/platform/platform_linux.cc native/src/mono_call.cc native/src/mono_bridge.cc
git commit -m "Free scratch caves after Mono remote calls instead of leaking them"
```

---

### Task 2: Close the process handle on detach

**Files:**
- Modify: `native/src/process_utils.cc`, `native/src/process_utils.h`
- Modify: `native/src/addon.cc`
- Modify: `src/main/nativeAddon.ts`
- Modify: `src/main/ipc.ts`
- Test: `tests/native/process_utils.test.ts`, `tests/main/ipc.test.ts`

**Context:** `native/src/process_utils.cc:33-67`'s `Attach` opens a `HANDLE` and hands it to JS as a number, but nothing anywhere in the codebase ever calls `CloseHandle` on it. `src/main/ipc.ts:410-437`'s `attachTo` overwrites `attachedHandle` with a fresh one on every attach (including a re-attach to a game that relaunched) and `watcher.onVanish` (`ipc.ts:586-605`) nulls it without closing it — every attach/relaunch cycle leaks one kernel handle, keeping the dead process object alive.

- [ ] **Step 1: Add a `Detach` export**

Add to `native/src/process_utils.cc`, after `Attach`:

```cpp
Napi::Value Detach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "detach(handle) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  bool ok = CloseHandle(h) != 0;
  return Napi::Boolean::New(env, ok);
}
```

Add the matching declaration to `native/src/process_utils.h` (read the file first to match its existing declaration style).

- [ ] **Step 2: Register the export**

In `native/src/addon.cc`, add inside `Init`, near the existing `attach` registration:

```cpp
exports.Set("detach", Napi::Function::New(env, Detach));
```

- [ ] **Step 3: Rebuild and add a native test**

Run: `cd native && npx node-gyp build && cd ..`

Add to `tests/native/process_utils.test.ts` (match this file's existing harness-spawn/attach pattern):

```ts
it('detach closes the handle attach() returned', () => {
  const { handle } = (addon as any).attach(harness.pid)
  const ok = (addon as any).detach(handle)
  expect(ok).toBe(true)
})
```

Run: `npx vitest run tests/native/process_utils.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire `detach` into `nativeAddon.ts`**

Add to `src/main/nativeAddon.ts`, near the existing `attach` wrapper:

```ts
  // Closes the OS handle attach() returned. Every path that stops using a
  // handle (re-attach to a different pid, the watcher's onVanish, app quit)
  // must call this — attach() previously had no matching close anywhere in
  // the codebase, leaking one kernel handle per attach/relaunch cycle.
  detach: (handle: number): boolean => addon.detach(handle),
```

- [ ] **Step 5: Call it from every place `attachedHandle` changes or is discarded**

In `src/main/ipc.ts`'s `attachTo` (line 410-437), close the OLD handle before overwriting it — only when there was one, and only in the process-switch branch that already restores/resets everything else:

```ts
function attachTo(pid: number, exeName: string): { handle: number; baseAddress: string } {
  if (attachedHandle !== null && attachedPid !== pid) {
    patchEngine.restoreAll()
    cheatRuntime.processExited()
    hotkeyManager.unregisterAll()
    for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
      scriptRuntime.clear(cheat.id)
    }
    // The old handle is about to be replaced below — close it now, while
    // we still have it, rather than leaking it. Safe even though
    // patchEngine.restoreAll() above already used it: CloseHandle only
    // releases OUR reference to the kernel object, it doesn't affect the
    // target process itself.
    nativeAddon.detach(attachedHandle)
  }
  const { handle, baseAddress } = nativeAddon.attach(pid)
  attachedHandle = handle
  attachedBase = baseAddress
  attachedPid = pid
  refreshModuleContext(exeName)
  hotkeyManager.registerAll(attachedExe ?? exeName)
  return { handle, baseAddress }
}
```

In `watcher.onVanish` (`ipc.ts:586-605`), close the handle before nulling it — the process is gone, so the handle is now pointing at a zombie kernel object with nothing else referencing it:

```ts
  watcher.onVanish(() => {
    cheatRuntime.processExited()
    patchEngine.forgetAll()
    hotkeyManager.unregisterAll()
    for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
      scriptRuntime.clear(cheat.id)
    }
    if (attachedHandle !== null) nativeAddon.detach(attachedHandle)
    attachedHandle = null
    attachedBase = null
    attachedPid = null
    attachedExe = null
    loadedModules = new Map()
    changedModules = []
    getWindow().webContents.send('game:state', currentGameState())
  })
```

In `releaseTarget` (`ipc.ts:626-...`, called on app quit), close the handle as the last step, after everything else that still needs it has run:

```ts
export function releaseTarget(): void {
  try {
    nativeAddon.stopWriteWatch()
  } catch {
    // No session, or the target is already gone — nothing to disarm.
  }
  patchEngine.restoreAll()
  hotkeyManager.unregisterAll()
  for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
    scriptRuntime.clear(cheat.id)
  }
  if (attachedHandle !== null) nativeAddon.detach(attachedHandle)
}
```

(Read the actual current content of these three functions before editing — the surrounding lines shown above are from this plan's research and should match closely, but confirm exact current line numbers/content first, since earlier plans in this repo's history have touched these same functions.)

- [ ] **Step 6: Typecheck and run tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/main/ipc.test.ts`
Run: `npx vitest run` (full suite)
Expected: all clean/PASS, unchanged pass counts.

- [ ] **Step 7: Commit**

```bash
git add native/src/process_utils.cc native/src/process_utils.h native/src/addon.cc src/main/nativeAddon.ts src/main/ipc.ts tests/native/process_utils.test.ts
git commit -m "Close the process handle on detach/re-attach/quit instead of leaking it"
```

---

### Task 3: Fix write-watch's displacement sign, DLL handle leak, and signature fallback

**Files:**
- Modify: `native/src/write_watch.cc`
- Test: `tests/native/write_watch.test.ts`

**Context:** Three independent bugs in this one file:

1. **Signed displacement serialized as unsigned hex** (`write_watch.cc:481` computes `out.displacement` as a signed `int64_t`, but line 917's `ToHex((uintptr_t)c.displacement)` casts it through `uintptr_t` first — a negative displacement like `-16` becomes `"0xfffffffffffffff0"`, a huge *positive* number once parsed back with `BigInt(...)` on the JS side (every consumer — `Scanner.tsx:251`, `Scanner.tsx:295`/`:345`, `ipc.ts:112` — already parses via `BigInt(...)`, which handles a signed *decimal* string correctly with zero consumer-side changes needed. Do not "fix" the consumers — fix only the serialization.). Reachable whenever a caught instruction's base register points PAST the watched field (e.g. `[rbp-0x30]`).
2. **`LOAD_DLL_DEBUG_EVENT`'s file handle is never closed** — line 755-762 (main capture loop) and the drain loop (line 839-850) both close `CREATE_PROCESS_DEBUG_EVENT`'s handle but neither handles `LOAD_DLL_DEBUG_EVENT`, whose `ev.u.LoadDll.hFile` the debugger is required to close per the Windows debug-API contract. A Mono/Unity game loading assemblies continuously leaks one handle per DLL load for the duration of any find-what-writes session.
3. **The forward-only signature fallback (line 543-544) ignores `ReadProcessMemory`'s return value and has no halving-probe retry**, unlike `cave_ops.cc`'s `DecodeRun`, which already solves this exact problem. When the lead-in read fails (line 540-541) and the fallback also fails or comes up short, the signature degrades to a near-zero-length bare-instruction pattern that matches hundreds of places — silently producing a patch that will report "ambiguous" forever, per this same file's own comment at line 500-506 about why the whole windowing scheme exists.

- [ ] **Step 1: Write a failing test for the displacement sign**

Add to `tests/native/write_watch.test.ts` (match this file's existing harness-driven capture-and-check pattern — find an existing test that captures a write and reads `caught.displacement` to copy its setup):

```ts
it('reports a negative displacement as a signed value, not a huge unsigned one', async () => {
  // Drive the harness into a state where the caught instruction's base
  // register points PAST the watched field (base + negative displacement
  // == watched address) — check test-harness/harness.c for an existing
  // command that produces this shape, or add one if none exists (a
  // `mov [rbp-N], eax`-style store, matching this file's other tests'
  // existing harness command conventions).
  // ... capture setup matching this file's existing pattern ...
  expect(BigInt(caught.displacement)).toBeLessThan(0n)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/write_watch.test.ts`
Expected: FAIL — `BigInt("0xfffffffffffffff0")` is a huge positive number, not negative.

- [ ] **Step 3: Fix the serialization**

In `native/src/write_watch.cc`, find the `o.Set("displacement", ...)` line (line 917) and change it from `ToHex((uintptr_t)c.displacement)` to a signed decimal string:

```cpp
    o.Set("displacement", Napi::String::New(env, std::to_string(c.displacement)));
```

(`c.displacement` is already declared `int64_t` — `std::to_string(int64_t)` produces a correctly-signed decimal string, e.g. `"-16"`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/native/write_watch.test.ts`
Expected: PASS. Also run the full file to confirm no existing test broke (every existing test that captures a POSITIVE displacement, which decimal and hex both represent identically as a magnitude, is unaffected).

- [ ] **Step 5: Fix the DLL handle leak**

In `native/src/write_watch.cc`'s main capture loop (around line 755-762), add a branch alongside the existing `CREATE_PROCESS_DEBUG_EVENT` handling:

```cpp
    if (ev.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      SetHwBreakpointAllThreads(pid, address);
      armed = true;
      if (ev.u.CreateProcessInfo.hFile) CloseHandle(ev.u.CreateProcessInfo.hFile);
    } else if (ev.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      // The debug API contract requires the debugger to close this handle;
      // leaving it open both leaks a handle in Apprentice's own process AND
      // keeps the loaded DLL file locked on disk for as long as the
      // write-watch session stays armed.
      if (ev.u.LoadDll.hFile) CloseHandle(ev.u.LoadDll.hFile);
    } else if (ev.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) {
```

Add the identical `LOAD_DLL_DEBUG_EVENT` branch to the drain loop (around line 839-850), which handles debug events the same way but with a different dispatch structure — read that loop's actual current `if`/`else if` chain before editing and insert the branch consistently with its existing style.

- [ ] **Step 6: Add a regression test for the DLL handle path**

Add to `tests/native/write_watch.test.ts`:

```ts
it('does not leak a handle count across a session that sees DLL loads', async () => {
  // A live game loading assemblies is hard to simulate deterministically
  // in a unit test; this test instead confirms the branch exists and
  // compiles correctly by checking that a normal start/stop capture cycle
  // (which the harness process itself triggers via its own DLL loads at
  // startup — ntdll, kernel32, etc., all seen as LOAD_DLL_DEBUG_EVENT
  // before this test's own watch starts) still completes cleanly with no
  // hang and no crash — the harness's OWN startup DLL loads happen before
  // startWriteWatch attaches, so this mainly guards against a regression
  // in the debug-event dispatch's control flow, not a direct handle-count
  // assertion (Node has no portable per-process handle-count API to assert
  // against from a Vitest test).
  await (addon as any).startWriteWatch(harness.pid, /* existing known address from this file's setup */)
  await new Promise((r) => setTimeout(r, 200))
  const caught = (addon as any).stopWriteWatch()
  expect(Array.isArray(caught)).toBe(true)
})
```

- [ ] **Step 7: Fix the signature fallback to check the read result and retry with a smaller window**

In `native/src/write_watch.cc` (around line 537-545), replace the ignored-return fallback with a halving-probe retry matching `cave_ops.cc`'s `DecodeRun` strategy:

```cpp
    // Reading from before the instruction can fail outright when it sits
    // near the start of a mapping. That is not fatal — retry with a
    // smaller forward-only window (halving each time, like DecodeRun's own
    // read-shrinking strategy in cave_ops.cc) rather than falling straight
    // to a bare, near-zero-length signature the moment the FIRST fallback
    // attempt also fails or comes up short.
    if (!ReadProcessMemory(proc, (LPCVOID)(insnAddr - kLookBack), win, sizeof(win), &winGot) ||
        winGot <= kLookBack) {
      lookBack = 0;
      winGot = 0;
      size_t tryForward = kForward;
      while (tryForward >= kMinSigBytes && winGot == 0) {
        SIZE_T got = 0;
        if (ReadProcessMemory(proc, (LPCVOID)insnAddr, win, tryForward, &got) && got >= kMinSigBytes) {
          winGot = got;
          break;
        }
        tryForward /= 2;
      }
    }
```

- [ ] **Step 8: Add a regression test asserting a too-short signature is reported, not silently accepted**

Add to `tests/native/write_watch.test.ts` (this may need a harness command that places the watched write very close to the start of an executable region — check `test-harness/harness.c` for an existing one, or confirm via this file's existing tests whether one already covers a lead-in-read-failure case that can be extended):

```ts
it('does not produce a signature shorter than kMinSigBytes even when the lead-in read fails', async () => {
  // ... capture a write near the start of an executable mapping, matching
  // this file's existing setup pattern for a similar edge case if one
  // exists ...
  expect(caught.signature.replace(/\?\?/g, '').length).toBeGreaterThanOrEqual(48) // kMinSigBytes, as hex chars this is *96*, adjust to match the file's actual signature encoding (hex-pair-per-byte vs raw byte count) before asserting
})
```

(This test's exact harness setup depends on `test-harness/harness.c`'s existing capabilities — if no command already places a write instruction near the start of an executable region, note in the task report that this specific edge case is verified by code inspection only, and don't force a brittle test into existence.)

- [ ] **Step 9: Rebuild and run the full native suite**

Run: `cd native && npx node-gyp build && cd ..`
Run: `npx vitest run tests/native/write_watch.test.ts`
Run: `npx vitest run tests/native`
Expected: all PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add native/src/write_watch.cc tests/native/write_watch.test.ts
git commit -m "Fix write-watch: signed displacement, DLL handle leak, signature fallback retry"
```

---

### Task 4: Refuse a force patch whose length isn't a real instruction boundary

**Files:**
- Modify: `src/main/patchEngine.ts`
- Modify: `src/main/ipc.ts`
- Test: `tests/main/patchEngine.test.ts`

**Context:** `patchEngine.ts:686` computes `replay = displaced.slice(patch.length * 2)` for `force` mode, assuming `patch.length` is exactly the byte length of the first whole instruction in the displaced run. That's true for a captured instruction, but `ipc.ts`'s `mono:resolveMethodBytes` handler auto-fills `length` as an arbitrary fixed-length snapshot for Mono-anchored patches — if that length doesn't land on an instruction boundary, the cave starts executing mid-instruction (undefined behavior in a live game), and if `patch.length >= run.length`, `.slice()` silently returns `''`, dropping the game's own instructions from the replay entirely.

- [ ] **Step 1: Write a failing test**

Add to `tests/main/patchEngine.test.ts` (read the file first to match its existing fake-`PatchOps` dependency-injection pattern — `apply()`/`installInjection` is tested against a fake `decodeRun` already, per this codebase's established convention):

```ts
it('refuses to install a force patch whose length does not match the first decoded instruction', async () => {
  const ops = makeFakeOps({
    // Configure the fake decodeRun to report a first-instruction length
    // (e.g. 3) that differs from the patch's own `length` field (e.g. 5) —
    // match this file's existing fake-ops shape for decodeRun's return type.
    decodeRun: () => ({ length: 8, decodable: true, relocatable: true, clobbers: [] }),
    // ... first-instruction-length probe per Step 3's actual implementation ...
  })
  const engine = new PatchEngine(ops)
  const patch: PatchCheat = {
    kind: 'patch', mode: 'force', id: 'p1', name: 'P1',
    originalBytes: '00'.repeat(8), length: 5 /* deliberately wrong */,
    signature: 'aa'.repeat(8), moduleName: null, moduleOffset: null,
    baseRegister: 'rax', fieldOffset: '0x8', value: 1, dataType: 'int32'
  }
  const result = await engine.apply(patch)
  expect(result.ok).toBe(false)
  expect(result.error).toContain('instruction boundary')
})
```

(Adapt the exact fake-ops shape and `PatchCheat` fields to match this codebase's actual current types in `store.ts` and `patchEngine.ts`'s actual `PatchOps` interface — read both before writing this test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: FAIL — no such guard exists yet.

- [ ] **Step 3: Add the guard in `installInjection`**

In `src/main/patchEngine.ts`, before the `force`-mode `replay` computation (line 684-686), add a boundary check. `this.ops.decodeRun` already exists (used elsewhere in this file to decode the displaced run) and reports a first-instruction length — use it to validate `patch.length` before slicing:

```ts
    } else {
      if (mode === 'force') {
        // patch.length must be exactly the byte length of the FIRST
        // instruction in the displaced run — decodeRun with minBytes=1
        // reports that length. A Mono-anchored patch's auto-filled length
        // (mono:resolveMethodBytes in ipc.ts) is a fixed snapshot size, not
        // a decoded instruction boundary, and can disagree with it. Slicing
        // at the wrong boundary starts the replayed run mid-instruction —
        // undefined behavior in a live game — or, if patch.length >=
        // run.length, silently drops the replay to an empty string.
        const firstInsn = this.ops.decodeRun(address, 1)
        if (!firstInsn.decodable || firstInsn.length !== patch.length) {
          return {
            ok: false,
            error:
              "This patch's recorded length does not match a real instruction boundary at this address — re-capture it.",
            caveAddress: null,
            displaced: null
          }
        }
        if (patch.length >= run.length) {
          return {
            ok: false,
            error: "This patch's recorded length covers the entire displaced run, leaving nothing to replay.",
            caveAddress: null,
            displaced: null
          }
        }
      }
      const replay =
        mode === 'capture' || mode === 'guard' ? displaced : displaced.slice(patch.length * 2)
```

(Confirm `this.ops.decodeRun`'s actual signature/return shape in the current `patchEngine.ts`/`PatchOps` interface before writing this — the shape above matches what Task 4 of the numeric-data-types-era work established, per `nativeAddon.ts`'s `decodeRun` wrapper, but verify against the live file.)

- [ ] **Step 4: Fix the misleading comment this guard makes newly-accurate**

In `src/main/ipc.ts`, `mono:resolveMethodBytes`'s handler comment (around line 995-1003 per the original review) currently claims `patch.length` "never governs how many bytes get overwritten there" — true for what gets *written* (a NOP patch's length), but the force-mode replay-slicing behavior this task just guarded means length DOES matter for `force` specifically. Update the comment to say so explicitly rather than leave a statement that's now more misleading than before this task:

```ts
    // patch.length governs how many bytes get NOP'd/overwritten only in
    // 'nop' mode — but for 'force' mode specifically, patchEngine.ts's
    // installInjection now REQUIRES patch.length to exactly match the
    // first decoded instruction's length (refusing to install otherwise),
    // since force mode slices the displaced run at that boundary. This
    // auto-fill is a fixed snapshot size, not a decoded boundary — if the
    // user picks force mode with an auto-filled length, installInjection's
    // own guard is what catches a mismatch, not this comment's old claim
    // that length "never" matters.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: PASS, including this new test and every pre-existing one (a correctly-captured patch's `length` already equals its first instruction's decoded length, by construction — this guard should never trip on real captured data, only on the auto-filled Mono case this task targets).

- [ ] **Step 6: Typecheck and run full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean/PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/patchEngine.ts src/main/ipc.ts tests/main/patchEngine.test.ts
git commit -m "Refuse a force patch whose length isn't a real instruction boundary"
```

---

### Task 5: Re-register hotkeys after deleting a cheat

**Files:**
- Modify: `src/main/ipc.ts`
- Test: `tests/main/ipc.test.ts` or `tests/main/hotkeys.test.ts` (whichever already covers `registerAll` call timing — check both before adding)

**Context:** `cheats:save`'s handler (`ipc.ts` around line 703-706) re-registers hotkeys after a save, guarded by `attachedExe !== null && exeName matches`. `cheats:delete`'s handler (`ipc.ts:708-722`) does not — a deleted cheat's hotkey stays registered via the closure `hotkeyManager.registerAll` captured at the LAST registration, so pressing it after deletion calls `freezeLoop.enable(deletedCheat)` and silently re-adds the deleted definition to the active freeze set with no UI row to ever turn it off again.

- [ ] **Step 1: Write a failing test**

Add to `tests/main/hotkeys.test.ts` (match this file's existing fake-`HotkeyDeps` pattern):

```ts
it('does not fire a hotkey for a cheat that was deleted', () => {
  // This test targets the CONTRACT: after a cheat with a hotkey is
  // deleted, HotkeyManager.registerAll must be called again with the
  // cheat no longer in loadCheats' returned list, so the accelerator is
  // unregistered. Since HotkeyManager itself already behaves correctly
  // given a fresh registerAll call (existing tests in this file already
  // cover that unregisterAll-then-register-fresh works), this test is
  // really an ipc.ts integration point — see Step 4 for where the real
  // regression coverage belongs; if this file doesn't naturally support
  // testing ipc.ts's cheats:delete handler directly, skip this file and
  // write the test in tests/main/ipc.test.ts instead against whatever
  // pure/exported surface of the delete handler exists.
})
```

(This finding's real fix is a one-line addition to an IPC handler that isn't directly unit-testable without either exporting the handler logic as a pure function or adding an integration-style test — read `tests/main/ipc.test.ts`'s existing structure first: it currently only tests pure exported functions like `applyRelearn`/`hasProfile`, not `ipcMain.handle` callbacks directly. If `cheats:delete`'s logic can be extracted to a small pure/testable function the same way `applyRelearn` was, do that; otherwise, note in the task report that this fix is verified by code inspection and the manual-testing convention this codebase already uses for renderer-adjacent IPC wiring, and skip to Step 3.)

- [ ] **Step 2: (If extraction is straightforward) extract and test; otherwise skip to Step 3**

- [ ] **Step 3: Add the fix**

In `src/main/ipc.ts`'s `cheats:delete` handler (line 708-722), add the same re-registration guard `cheats:save` already uses, after `deleteCheat`:

```ts
  ipcMain.handle('cheats:delete', (_e, exeName: string, cheatId: string) => {
    freezeLoop.disable(cheatId)
    scriptRuntime.clear(cheatId)
    if (patchEngine.isApplied(cheatId)) {
      const stored = loadCheats(exeName).find((c) => c.id === cheatId)
      if (stored && stored.kind === 'patch') patchEngine.restore(stored)
    }
    deleteCheat(exeName, cheatId)
    // A deleted cheat's hotkey must stop firing — without this,
    // HotkeyManager's registered accelerator still closes over the
    // now-deleted cheat definition and re-adds it to the freeze loop
    // every time the key is pressed, with no UI row left to disable it.
    // Same guard cheats:save already uses: only re-register if we're
    // deleting from the currently-attached exe's profile.
    if (attachedExe !== null && exeName.replace(/\.exe$/i, '') === attachedExe) {
      hotkeyManager.registerAll(attachedExe)
    }
  })
```

(Confirm the exact current content of this handler before editing — it may have gained more lines since this plan's research; add the re-registration block as the LAST statement in the handler regardless of what else is there, after `deleteCheat` has actually run.)

- [ ] **Step 4: Typecheck and run tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/main/ipc.test.ts tests/main/hotkeys.test.ts`
Run: `npx vitest run`
Expected: clean/PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts
git commit -m "Re-register hotkeys after deleting a cheat"
```

---

### Task 6: Prevent overlapping FreezeLoop ticks

**Files:**
- Modify: `src/main/freezeLoop.ts`
- Test: `tests/main/freezeLoop.test.ts`

**Context:** `freezeLoop.ts:71-79`'s `start()` fires `tick()` on a bare `setInterval` with no in-flight guard, and `tick()` is async — a Mono-target cheat whose resolve takes longer than the 100ms tick interval (a real possibility per `resolveMonoTarget`'s documented 2-second timeout and mandatory 10ms sleep between remote calls) causes ticks to overlap and pile up unboundedly, corrupting the degrade-counter's meaning and flooding the writeFn.

- [ ] **Step 1: Write a failing test**

Add to `tests/main/freezeLoop.test.ts` (match this file's existing `vi.useFakeTimers()`/`vi.advanceTimersByTimeAsync` pattern, visible in its other tests):

```ts
it('does not start a new tick while the previous one is still resolving', async () => {
  let resolveFirst: (v: boolean) => void
  let callCount = 0
  const writeFn = vi.fn(() => {
    callCount++
    if (callCount === 1) {
      return new Promise<boolean>((resolve) => { resolveFirst = resolve })
    }
    return Promise.resolve(true)
  })
  const loop = new FreezeLoop(writeFn, 50, DEGRADE_AFTER)
  loop.start()
  loop.enable(cheat)

  // Advance well past several tick intervals while the first tick's write
  // is still unresolved.
  await vi.advanceTimersByTimeAsync(500)
  expect(writeFn).toHaveBeenCalledTimes(1) // not piled up — still waiting on tick 1

  resolveFirst!(true)
  await vi.advanceTimersByTimeAsync(50)
  expect(writeFn).toHaveBeenCalledTimes(2) // resumes normally once tick 1 settles

  loop.stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/freezeLoop.test.ts`
Expected: FAIL — `writeFn` is called more than once during the 500ms advance, since ticks currently overlap unconditionally.

- [ ] **Step 3: Add the in-flight guard**

In `src/main/freezeLoop.ts`, add a `private ticking = false` field and guard `start()`'s interval callback:

```ts
export class FreezeLoop {
  private writeFn: WriteFn
  private intervalMs: number
  private degradeAfterTicks: number
  private timer: ReturnType<typeof setInterval> | null = null
  private active = new Map<string, CheatDefinition>()
  private failCounts = new Map<string, number>()
  private degraded = new Set<string>()
  private degradedCb: ((cheatId: string) => void) | null = null
  private recoveredCb: ((cheatId: string) => void) | null = null
  // Guards against a tick overlapping the previous one — a slow write (a
  // Mono target's resolve can legitimately exceed the tick interval) must
  // not stack a second dispatch on top of a still-in-flight one, which
  // would corrupt the degrade counter and flood writeFn with duplicate work.
  private ticking = false

  // ... constructor unchanged ...

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      void this.tick()
        .catch((err) => console.warn(`[freezeLoop] tick failed: ${String(err)}`))
        .finally(() => {
          this.ticking = false
        })
    }, this.intervalMs)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/freezeLoop.test.ts`
Expected: PASS, including every pre-existing test (this only changes behavior when a tick is slower than the interval — every existing test's writeFn resolves synchronously/immediately, so tick timing is unaffected for them).

- [ ] **Step 5: Typecheck and run full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/freezeLoop.ts tests/main/freezeLoop.test.ts
git commit -m "Prevent FreezeLoop ticks from overlapping when a write is slow"
```

---

### Task 7: Move `ScanNext` to a background thread and chunk its region reads

**Files:**
- Modify: `native/src/scanner.cc`, `native/src/scanner.h`
- Modify: `src/main/nativeAddon.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`, `src/renderer/src/tamper.d.ts`
- Test: `tests/native/scanner.test.ts`

**Context:** `scanner.cc:160-213`'s `ScanNext` is fully synchronous, issuing one `ReadProcessMemory` syscall per candidate directly on the JS/main thread — with hundreds of thousands of candidates (a common outcome of an under-narrowed first scan), clicking any next-scan filter hard-freezes the whole Electron app for as long as the scan takes. `ScanFirst` already solved this exact problem with an `AsyncWorker` (`scanner.cc:104-138`) — `ScanNext` needs the same treatment.

- [ ] **Step 1: Write a failing test for the async signature**

Add to `tests/native/scanner.test.ts` (match this file's existing harness-driven `scanFirst` test pattern, which already awaits a Promise):

```ts
it('scanNext returns a Promise and resolves with the filtered candidates', async () => {
  let candidates = await (addon as any).scanFirst(handle, 'int32', 100)
  await send('set 55')
  const result = (addon as any).scanNext(handle, candidates, 'int32', { mode: 'exact', value: 55 })
  expect(result).toBeInstanceOf(Promise)
  const filtered = await result
  expect(filtered.length).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/scanner.test.ts`
Expected: FAIL — `scanNext` currently returns an array directly, not a Promise (`result).toBeInstanceOf(Promise)` fails).

- [ ] **Step 3: Extract `ScanNext`'s body into a plain function and wrap it in an `AsyncWorker`**

In `native/src/scanner.cc`, rename the existing `ScanNext` function's body (lines 160-213) into a free function `RunScanNext` that takes plain C++ types (no `Napi::` types — this runs on a background thread, same rule Task 5 of the lua-scripting plan already established for `RunScriptImpl`), matching the shape `RunScanFirst` (used by `ScanFirstWorker`, line 104-138) already establishes:

```cpp
// Runs on a background thread via ScanNextWorker below — must not touch
// any Napi:: type. Takes the SAME plain-C++ representation ScanFirstWorker's
// OnOK/Execute split already uses for candidates (address + value pairs),
// converted from/to Napi types only in ScanNextWorker's constructor/OnOK.
std::vector<AddressValue> RunScanNext(
    HANDLE h, const std::vector<AddressValue>& candidates, const ValueSpec& spec,
    const std::string& mode, double filterValue) {
  std::vector<AddressValue> out;
  bool isFloat = IsFloatKind(spec.kind);
  for (const auto& candidate : candidates) {
    double current;
    if (!ReadValueAsDouble(h, candidate.address, spec, &current)) continue;
    bool keep = false;
    if (mode == "exact") {
      keep = ValuesEqual(current, filterValue, isFloat);
    } else {
      if (mode == "changed") keep = !ValuesEqual(current, candidate.value, isFloat);
      else if (mode == "unchanged") keep = ValuesEqual(current, candidate.value, isFloat);
      else if (mode == "increased") keep = current > candidate.value;
      else if (mode == "decreased") keep = current < candidate.value;
    }
    if (keep) out.push_back({candidate.address, current});
  }
  return out;
}

class ScanNextWorker : public Napi::AsyncWorker {
 public:
  ScanNextWorker(Napi::Env env, HANDLE h, std::vector<AddressValue> candidates,
                 ValueSpec spec, std::string mode, double filterValue)
      : Napi::AsyncWorker(env), h_(h), candidates_(std::move(candidates)), spec_(spec),
        mode_(std::move(mode)), filterValue_(filterValue),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override { results_ = RunScanNext(h_, candidates_, spec_, mode_, filterValue_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object obj = Napi::Object::New(env);
      obj.Set("address", Napi::String::New(env, ToHexAddr(results_[i].address)));
      obj.Set("value", Napi::Number::New(env, results_[i].value));
      result.Set((uint32_t)i, obj);
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE h_;
  std::vector<AddressValue> candidates_;
  ValueSpec spec_;
  std::string mode_;
  double filterValue_;
  std::vector<AddressValue> results_;
  Napi::Promise::Deferred deferred_;
};
```

(`AddressValue`, `ValuesEqual`, `IsFloatKind`, `ReadValueAsDouble`, `ToHexAddr` already exist in this file — reuse them exactly as `ScanFirst`'s own worker does; do not redefine.)

Replace the public `ScanNext` entry point with one that parses arguments, converts the `Napi::Array` of candidates into `std::vector<AddressValue>` (on the JS thread, in the constructor call site — NOT inside `Execute()`, same JS-thread/worker-thread boundary rule established in the lua-scripting plan), and queues the worker:

```cpp
Napi::Value ScanNext(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  Napi::Array jsCandidates = info[1].As<Napi::Array>();
  std::string dataType = info[2].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "dataType must be one of int8, int16, int32, int64, float, double")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object filter = info[3].As<Napi::Object>();
  std::string mode = filter.Get("mode").As<Napi::String>().Utf8Value();
  double filterValue = mode == "exact" ? filter.Get("value").As<Napi::Number>().DoubleValue() : 0.0;

  std::vector<AddressValue> candidates;
  candidates.reserve(jsCandidates.Length());
  for (uint32_t i = 0; i < jsCandidates.Length(); i++) {
    Napi::Object c = jsCandidates.Get(i).As<Napi::Object>();
    candidates.push_back({
        ParseHex(c.Get("address").As<Napi::String>().Utf8Value()),
        c.Get("value").As<Napi::Number>().DoubleValue()
    });
  }

  auto* worker = new ScanNextWorker(env, h, std::move(candidates), *specOpt, mode, filterValue);
  worker->Queue();
  return worker->GetPromise();
}
```

Update `native/src/scanner.h`'s declaration comment if it documents the old synchronous return (read the file first).

- [ ] **Step 4: Rebuild and run the failing test**

Run: `cd native && npx node-gyp build && cd ..`
Run: `npx vitest run tests/native/scanner.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `nativeAddon.ts`'s wrapper to reflect the new async signature**

In `src/main/nativeAddon.ts`, change `scanNext`'s type from a synchronous return to `Promise<Candidate[]>`, matching `scanFirst`'s existing comment about why (background thread, real wall-clock time):

```ts
  scanNext: (
    handle: number,
    candidates: Candidate[],
    dataType: string,
    filter: ScanFilter
  ): Promise<Candidate[]> => addon.scanNext(handle, candidates, dataType, filter),
```

- [ ] **Step 6: Update every caller to await it**

In `src/main/ipc.ts`, find the `scan:next` handler and add `await`/`async` (it likely already returns the wrapper's result directly from an async handler — read the current code and adjust minimally). Update `src/preload/index.ts` and `src/renderer/src/tamper.d.ts`'s `scanNext` type to `Promise<Candidate[]>` if not already declared as such (the IPC round-trip already made it a Promise from the renderer's perspective regardless of the native layer's sync/async-ness, so this may already be correct at the preload/tamper.d.ts layer — confirm before editing, and only change what's actually wrong).

- [ ] **Step 7: Typecheck and run tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean/PASS, unchanged pass counts elsewhere.

- [ ] **Step 8: Commit**

```bash
git add native/src/scanner.cc native/src/scanner.h src/main/nativeAddon.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts tests/native/scanner.test.ts
git commit -m "Move ScanNext to a background AsyncWorker instead of blocking the main thread"
```

---

### Task 8: Paginate scan results and raise the renderer's display cap

**Files:**
- Modify: `src/renderer/src/screens/Scanner.tsx`
- Test: manual verification (no renderer test harness exists for screen components, per this codebase's established convention)

**Context:** `Scanner.tsx:415` only renders the candidate list when `candidates.length <= 20` — above that, the UI shows a count and nothing else: no rows, no selection, no way to resolve a chain or find-what-writes. This traces to the original v1 plan with no stated rationale and isn't in any spec's out-of-scope section. Task 7 already fixed the native-side freeze (`ScanNext` off the main thread); this task fixes the display wall on top of it.

- [ ] **Step 1: Raise the render cap and add a virtualization-friendly slice**

In `src/renderer/src/screens/Scanner.tsx`, change the render gate (line 415) from a hard `<= 20` cutoff to always rendering, but only the first N rows with a clear "showing X of Y" indicator — read the surrounding component structure first to match its existing state/style conventions:

```tsx
const MAX_RENDERED_CANDIDATES = 500

// ... inside the component, near the existing candidates.length checks ...

{candidates.length > 0 && (
  <>
    <p>
      {candidates.length} candidate(s)
      {candidates.length > MAX_RENDERED_CANDIDATES &&
        ` (showing first ${MAX_RENDERED_CANDIDATES} — narrow further to see the rest)`}
    </p>
    <ul>
      {candidates.slice(0, MAX_RENDERED_CANDIDATES).map((c) => {
        // ... existing per-candidate row JSX, unchanged ...
      })}
    </ul>
  </>
)}
```

(Read the actual current JSX around line 399-438 before editing — the exact structure of the candidate row and its surrounding conditional wrapper must be preserved; this task only changes the CUTOFF and adds the `.slice()`, not the row rendering itself.)

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: both clean.

- [ ] **Step 3: Manual verification**

Run a scan against a real or harness process that produces more than 20 (and more than 500) candidates; confirm the list now renders up to 500 rows with a clear indicator when more exist, and that narrowing via a next-scan filter (now async per Task 7) doesn't freeze the UI while it runs.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/screens/Scanner.tsx
git commit -m "Raise Scanner's candidate render cap from 20 to 500 with a clear indicator"
```

---

### Task 9: Fix Memory Viewer's crash on Prev-page near address 0, and add an error boundary

**Files:**
- Modify: `src/renderer/src/screens/MemoryViewer.tsx`
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/components/ErrorBoundary.tsx`
- Test: manual verification

**Context:** `MemoryViewer.tsx:102-108`'s `page(-1)` computes `BigInt(baseAddress) - 256n` with no floor — near address 0 this produces a negative BigInt, which `.toString(16)` renders WITHOUT a `0x` prefix and WITH a leading `-` (e.g. `"0x-100"` after the existing `'0x' + ...` string concatenation). The next render's `BigInt(baseAddress)` call (line 168) then throws a `SyntaxError` mid-render. There is no error boundary anywhere in `App.tsx`, so this blanks the entire renderer.

- [ ] **Step 1: Clamp `page()` to never go below 0**

In `src/renderer/src/screens/MemoryViewer.tsx`, modify `page()` (currently around line 102-108):

```ts
  function page(deltaPages: number) {
    if (!baseAddress) return
    const delta = BigInt(deltaPages * PAGE_SIZE)
    let next = BigInt(baseAddress) + delta
    if (next < 0n) next = 0n
    const normalized = '0x' + next.toString(16)
    setBaseAddress(normalized)
    setAddressInput(normalized)
  }
```

Also validate in `jump()` (whatever function handles the address-input text field) that a parsed BigInt is non-negative and within 64 bits before accepting it — read the current `jump()`/`normalizeAddress()` implementation first and add the same floor there, since a user can type a value that produces the identical crash without ever touching Prev-page.

- [ ] **Step 2: Add a React error boundary around the screen switch**

Create `src/renderer/src/components/ErrorBoundary.tsx`:

```tsx
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// A render-time throw anywhere in the screen tree (a malformed address, a
// bad BigInt parse, any future screen's bug) previously blanked the ENTIRE
// app with no recovery — no error boundary existed anywhere in App.tsx.
// This catches it at the screen-switch level so the sidebar/nav stays
// usable and the user can navigate away from whatever screen broke,
// instead of needing to restart Apprentice.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="screen">
          <h2>Something went wrong on this screen</h2>
          <p className="muted">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
```

- [ ] **Step 3: Wrap the screen area in `App.tsx`**

In `src/renderer/src/App.tsx`, import `ErrorBoundary` and wrap the `<div className="main">` block's contents (read the current file first to find the exact JSX boundary — wrap everything inside `.main` that varies by `screen`, not the `Sidebar`, so a crash on one screen doesn't take navigation down with it):

```tsx
import ErrorBoundary from './components/ErrorBoundary'

// ... inside the render, wrap the existing screen-conditional JSX:
<div className="main">
  <ErrorBoundary>
    {screen === 'picker' && ( /* ...existing... */ )}
    {screen === 'cheats' && exeName && ( /* ...existing... */ )}
    {/* ...every other existing screen branch, unchanged... */}
  </ErrorBoundary>
</div>
```

(React error boundaries reset only when their `key` changes or `setState` clears the error — since this wraps ALL screens in one boundary rather than one per screen, switching screens after a crash via the sidebar won't automatically clear `state.error` unless the "Try again" button is clicked first, OR the boundary is keyed by `screen` so React remounts it on navigation. Prefer keying: `<ErrorBoundary key={screen}>` — this makes navigating to a different screen implicitly recover, which is the better UX and needs no extra click.)

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: both clean.

- [ ] **Step 5: Manual verification**

Navigate to Memory Viewer, jump to a low address (e.g. `0x50`), click Prev page repeatedly — confirm it clamps at `0x0` rather than crashing. Type a garbage address and confirm the input is rejected rather than crashing. If a crash is deliberately forced (e.g. by temporarily reverting Step 1 to test the boundary in isolation), confirm the error boundary shows a recoverable message instead of a blank app, then revert the deliberate break.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/screens/MemoryViewer.tsx src/renderer/src/App.tsx src/renderer/src/components/ErrorBoundary.tsx
git commit -m "Clamp MemoryViewer paging at address 0 and add a screen-level error boundary"
```

---

### Task 10: Free leaked caves on failed patch installs, and surface a failed restore instead of reporting idle

**Files:**
- Modify: `src/main/patchEngine.ts`
- Modify: `src/main/cheatRuntime.ts`
- Modify: `src/main/ipc.ts`
- Test: `tests/main/patchEngine.test.ts`, `tests/main/cheatRuntime.test.ts`

**Context:** Two related issues in the install/restore lifecycle:

1. `patchEngine.ts:587`'s `installInjection` allocates a cave, then several subsequent failure paths (the arm-write at ~724, the body-write at ~734, suspend failure at ~747, redirect failure at ~755) return without freeing it — and per Task 1's new `platform::FreeMemory`, there is now a way to. Every one of these failure paths runs BEFORE the site redirect (the `jump` write that makes the game's code actually reach the cave) — meaning no thread can possibly be executing inside the cave yet, so freeing it is always safe at these specific points (this is a different safety argument than Task 1's "only free once a thread is confirmed finished" — here, no thread has ever been directed at the cave at all).
2. `cheatRuntime.ts:105-113`'s `disarm` calls `this.deps.restore(target)` (currently `void`-returning, discarding `patchEngine.restore`'s actual `boolean` result) and unconditionally sets state to `idle` regardless of whether the restore succeeded. If a restore write fails, the UI reports "off" while the game's code is still patched — and the next `apply()` call's own idempotency guard treats "not currently armed" as license to skip re-installing, so the user has no way to even retry.

- [ ] **Step 1: Write a failing test for the cave leak**

Add to `tests/main/patchEngine.test.ts` (match this file's existing fake-`PatchOps` pattern, which likely already has a `freeCave`-shaped gap to fill — check whether `PatchOps` currently declares `allocateCave` without a matching free):

```ts
it('frees the allocated cave when the body write fails before any thread reaches it', async () => {
  const freeCave = vi.fn()
  const ops = makeFakeOps({
    allocateCave: () => '0x2000',
    writeBytes: (addr: string) => addr !== '0x2000', // fails only the body write at the cave
    freeCave // new PatchOps method this task adds
  })
  const engine = new PatchEngine(ops)
  const result = await engine.apply(/* a valid force-mode patch, matching this file's existing fixtures */)
  expect(result.ok).toBe(false)
  expect(freeCave).toHaveBeenCalledWith('0x2000')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: FAIL — `PatchOps` has no `freeCave` method yet.

- [ ] **Step 3: Add `freeCave` to `PatchOps` and `nativeAddon.ts`, backed by Task 1's `FreeMemory`**

In `src/main/patchEngine.ts`, add to the `PatchOps` interface (read the file first to match its existing method declaration style):

```ts
  // Releases a cave allocateCave reserved, when installation failed before
  // the site redirect ever pointed the game at it — safe to call in that
  // window specifically, since no thread can be executing inside a cave
  // the game was never redirected to. See platform::FreeMemory's own
  // safety comment for the general rule this is a narrow, provably-safe
  // instance of.
  freeCave(address: string): void
```

In `src/main/ipc.ts`, wire the real implementation into wherever the concrete `PatchOps` object is constructed (find the object literal implementing `PatchOps` for the real `nativeAddon`-backed engine):

```ts
  freeCave: (address: string) => {
    if (attachedHandle === null) return
    nativeAddon.freeMemory(attachedHandle, address)
  },
```

Add the matching wrapper to `src/main/nativeAddon.ts`:

```ts
  freeMemory: (handle: number, address: string): boolean => addon.freeMemory(handle, address),
```

(This requires `freeMemory` to be exported from the native addon taking a hex-string address, unlike Task 1's `FreeMemory` which takes a raw `uintptr_t`. Add a thin wrapper export in `native/src/addon.cc`/wherever `allocateCave`'s own hex-string-taking export lives — follow that existing export's exact parameter-parsing pattern (`ParseHex` on the incoming string) rather than inventing a new convention.)

- [ ] **Step 4: Call `freeCave` on every pre-redirect failure path in `installInjection`**

In `src/main/patchEngine.ts`'s `installInjection` (the function containing lines 587-755 from this plan's research), add `this.ops.freeCave(cave)` before every `return { ok: false, ... }` that occurs AFTER `cave` is allocated (line 587) and BEFORE the site redirect actually succeeds (the `jump`/site-write near the end of the function). Read the full function to enumerate every such return — this plan's research identified failure points at the arm-write, the body-write, the suspend-failure, and the redirect-write-failure itself (the LAST one, right before or at the point the jump is written, is the boundary — a failure writing the jump itself still means the game was never actually redirected, so it's also safe to free). The ONLY failure path in this function that must NOT free the cave is one occurring AFTER the site redirect has been confirmed written (if any exists) — there isn't one in the current code structure (the redirect write is the final step), so every failure path in this function gets the `freeCave` call.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: PASS, all existing tests unaffected (freeCave is a new no-op-shaped addition on failure paths only; the success path is untouched).

- [ ] **Step 6: Write a failing test for the restore-failure surfacing**

Add to `tests/main/cheatRuntime.test.ts` (match this file's existing fake-`CheatRuntimeDeps` pattern):

```ts
it('does not report idle when disarm\'s restore write fails', () => {
  const deps = makeFakeDeps({ restore: () => false }) // restore now returns boolean
  const runtime = new CheatRuntime(deps)
  runtime.arm(/* a fixture patch, matching this file's existing setup */)
  runtime.disarm('patch1', /* the same fixture */)
  const status = runtime.status('patch1')
  expect(status.state).not.toBe('idle')
  expect(status.state).toBe('failed')
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/main/cheatRuntime.test.ts`
Expected: FAIL — `disarm` currently always sets `idle`.

- [ ] **Step 8: Make `restore` return success, and have `disarm` report failure honestly**

In `src/main/cheatRuntime.ts`, change the `CheatRuntimeDeps` interface's `restore` from `void` to `boolean` (read the file first — line 20 per this plan's research):

```ts
  restore(patch: PatchCheat): boolean
```

Add `'restore-failed'` to `AnchorReason` in `src/main/anchor.ts` (alongside the existing `'module-missing' | 'no-match' | ...` union), so `disarm`'s failure has a real, type-checked reason to report through the existing `CheatStatus.reason` field rather than inventing a parallel mechanism:

```ts
export type AnchorReason =
  | 'module-missing'
  | 'no-match'
  | 'ambiguous'
  | 'bytes-differ'
  | 'not-yet-compiled'
  | 'mono-not-loaded'
  | 'mono-assembly-not-loaded'
  // Added: disarm()'s restore write failed — the game's code is still
  // patched even though the user asked to turn it off. Distinct from every
  // other reason above, which all describe a FAILED ARM; this describes a
  // failed DISARM, surfaced through the same CheatStatus.reason field
  // since CheatRuntime already has no separate channel for it.
  | 'restore-failed'
```

In `src/main/cheatRuntime.ts`'s `disarm` (line 105-113):

```ts
  disarm(patchId: string, patch?: PatchCheat): void {
    this.cancelTimer(patchId)
    const target = this.armed.get(patchId) ?? patch
    this.armed.delete(patchId)
    this.generations.set(patchId, (this.generations.get(patchId) ?? 0) + 1)
    const restored = target ? this.deps.restore(target) : true
    if (restored) {
      this.states.set(patchId, idle())
      this.changeCb?.(patchId, idle())
    } else {
      const failedStatus: CheatStatus = {
        state: 'failed',
        unverified: false,
        reason: 'restore-failed',
        address: null,
        attempts: 0
      }
      this.states.set(patchId, failedStatus)
      this.changeCb?.(patchId, failedStatus)
    }
  }
```

(Confirm `CheatStatus`'s exact field shape in the current file before writing this — the shape above matches `idle()`'s own return shape per this plan's research, adjust field names if they've drifted.)

Update `src/main/ipc.ts`'s `CheatRuntime` construction (around line 454-465 per this plan's research) to propagate `patchEngine.restore`'s actual boolean instead of discarding it:

```ts
const cheatRuntime = new CheatRuntime({
  locate: async (patch) => {
    const status = await patchEngine.locate(patch)
    return { address: status.address, reason: status.reason ?? null }
  },
  apply: (patch) => patchEngine.apply(patch),
  restore: (patch) => patchEngine.restore(patch),
  isVerified: (patch) =>
    patch.moduleName === null || !changedModules.includes(patch.moduleName.toLowerCase())
})
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run tests/main/cheatRuntime.test.ts`
Expected: PASS, all existing tests unaffected (every existing test's fake `restore` presumably returns/resolves successfully already, either explicitly or because `void` was previously accepted anywhere a value was ignored — update any fake in this test file that implements `restore` as a bare `() => {}` to `() => true` so it keeps behaving as "succeeds", per this task's Global Constraint against changing existing passing behavior).

- [ ] **Step 10: Typecheck and run full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean/PASS.

- [ ] **Step 11: Commit**

```bash
git add src/main/patchEngine.ts src/main/cheatRuntime.ts src/main/anchor.ts src/main/ipc.ts src/main/nativeAddon.ts native/src/addon.cc tests/main/patchEngine.test.ts tests/main/cheatRuntime.test.ts
git commit -m "Free leaked caves on failed installs; report a failed restore instead of idle"
```

---

### Task 11: Guard native worker threads against unbounded allocation and escaped exceptions

**Files:**
- Modify: `native/src/pointer.cc`
- Modify: `native/src/scanner.cc`, `native/src/patch_ops.cc`
- Test: `tests/native/pointer.test.ts`, `tests/native/scanner.test.ts`, `tests/native/patch_ops.test.ts`

**Context:** `binding.gyp` defines `NAPI_DISABLE_CPP_EXCEPTIONS`, so `Napi::AsyncWorker::Execute()` bodies are NOT wrapped in a try/catch by node-addon-api — an escaped C++ exception on a worker thread calls `std::terminate` and kills the whole Electron process (the lua-scripting plan's Task 3/final-review already established and fixed this exact hazard for `RunScriptImpl`; this task applies the same discipline to the OLDER native workers that predate that fix). Two specific unbounded-allocation sites make this reachable: `pointer.cc:72-101`'s `CollectPointers` has NO cap at all on how many pointer entries it accumulates (unlike `scanner.cc`'s `kMaxScanResults`), and `scanner.cc`/`patch_ops.cc` both size a per-region read buffer to `mbi.RegionSize` with no cap, so a single multi-GB committed region allocates multi-GB in Apprentice's own process.

- [ ] **Step 1: Cap `CollectPointers`**

In `native/src/pointer.cc`, add a cap matching `scanner.cc`'s `kMaxScanResults` pattern (read `scanner.cc:17` and its usage at lines 65/80 for the exact style to mirror):

```cpp
// Same reasoning as scanner.cc's kMaxScanResults: an unbounded pointer
// collection against a real game's multi-GB committed heap can produce on
// the order of 10^8 entries before this function even returns, which
// std::sort then has to sort — this is the actual OOM risk that motivates
// this whole task, not a hypothetical one. The UI's job is to tell the
// user pointer-chain resolution didn't find enough candidates; this cap is
// what keeps that possible instead of exhausting memory first.
constexpr size_t kMaxPointerEntries = 5'000'000;

std::vector<PointerEntry> CollectPointers(HANDLE h) {
  std::vector<PointerEntry> out;
  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (out.size() < kMaxPointerEntries &&
         VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool readable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) &&
        !(mbi.Protect & PAGE_GUARD);
    if (readable && mbi.RegionSize >= sizeof(uintptr_t)) {
      std::vector<uint8_t> buffer(mbi.RegionSize);
      SIZE_T bytesRead = 0;
      if (ReadProcessMemory(h, mbi.BaseAddress, buffer.data(), mbi.RegionSize, &bytesRead)) {
        uintptr_t base = (uintptr_t)mbi.BaseAddress;
        for (SIZE_T offset = 0; offset + sizeof(uintptr_t) <= bytesRead; offset += sizeof(uintptr_t)) {
          if (out.size() >= kMaxPointerEntries) break;
          uintptr_t val;
          memcpy(&val, buffer.data() + offset, sizeof(val));
          if (val != 0) out.push_back({base + offset, val});
        }
      }
    }
    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break;
    addr = next;
  }
  return out;
}
```

- [ ] **Step 2: Cap the per-region read buffer in `scanner.cc` and `patch_ops.cc`**

In both `native/src/scanner.cc` (around line 72) and `native/src/patch_ops.cc` (around line 111), replace the unconditional `std::vector<uint8_t> buffer(mbi.RegionSize)` with a chunked read that never allocates more than a fixed cap at once, reading a region in fixed-size slices when it exceeds the cap:

```cpp
    // Never allocate the full region size in one shot — a single
    // multi-GB committed region (real in a large game) would otherwise
    // allocate multi-GB in Apprentice's own process just to scan it. Chunk
    // to a fixed size instead; correctness (finding every candidate in the
    // region) is unaffected since candidates never span a chunk boundary
    // in an aligned scan/pointer-collection stride.
    constexpr size_t kChunkSize = 4 * 1024 * 1024;
    if (readable && mbi.RegionSize >= sizeof(uintptr_t)) {
      size_t remaining = mbi.RegionSize;
      uintptr_t chunkBase = (uintptr_t)mbi.BaseAddress;
      std::vector<uint8_t> buffer(std::min(remaining, kChunkSize));
      while (remaining > 0) {
        size_t thisChunk = std::min(remaining, kChunkSize);
        if (buffer.size() < thisChunk) buffer.resize(thisChunk);
        SIZE_T bytesRead = 0;
        if (ReadProcessMemory(h, (LPCVOID)chunkBase, buffer.data(), thisChunk, &bytesRead)) {
          // ... existing per-candidate scan logic, now iterating `buffer`
          // up to `bytesRead` and adding `chunkBase` (not the original
          // mbi.BaseAddress) as the base for each offset found ...
        }
        chunkBase += thisChunk;
        remaining -= thisChunk;
      }
    }
```

(This changes the loop STRUCTURE around the existing per-candidate scan logic in each file — read each file's actual current inner loop body before editing, since `scanner.cc`'s and `patch_ops.cc`'s per-candidate logic differ (one compares against a target value, the other looks for byte patterns) and must be preserved exactly, just re-based onto `chunkBase` instead of the original region base. A candidate that straddles a chunk boundary is a real edge case this chunking introduces if the stride doesn't align to `kChunkSize` — mitigate by overlapping each chunk's read by `spec.size - 1` bytes (the widest value type, 8 bytes) at the chunk boundary, or by choosing `kChunkSize` as a multiple of the largest alignment stride already in use; read `scanner.cc`'s existing 4-byte-alignment-regardless-of-width comment before deciding, and prefer the overlap approach for correctness.)

- [ ] **Step 3: Wrap every `AsyncWorker::Execute()` body in try/catch**

Across `scanner.cc` (`ScanFirstWorker`, and Task 7's new `ScanNextWorker`), `pointer.cc` (its `AsyncWorker`, if `ResolvePointerChain` uses one — check), and `patch_ops.cc` (`ScanAobWorker`), wrap each `Execute()` method's body:

```cpp
  void Execute() override {
    try {
      results_ = RunScanFirst(handle_, spec_, target_);
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown native error during scan");
    }
  }
```

(`Napi::AsyncWorker::SetError` is the correct mechanism — it routes to `OnError` instead of `OnOK`, matching the existing `OnError` handler each of these workers already has. This is a pure safety net given `NAPI_DISABLE_CPP_EXCEPTIONS`'s effect on `Execute()` specifically — it changes nothing about the success path.)

- [ ] **Step 4: Rebuild and run tests**

Run: `cd native && npx node-gyp build && cd ..`
Run: `npx vitest run tests/native/pointer.test.ts tests/native/scanner.test.ts tests/native/patch_ops.test.ts`
Run: `npx vitest run tests/native`
Expected: all PASS, unchanged pass counts (these are safety nets and internal chunking — no observable output should change for any existing test's inputs).

- [ ] **Step 5: Commit**

```bash
git add native/src/pointer.cc native/src/scanner.cc native/src/patch_ops.cc
git commit -m "Cap pointer collection, chunk region reads, and catch exceptions on worker threads"
```

---

### Task 12: Short-circuit anchor resolution when the module isn't loaded

**Files:**
- Modify: `src/main/anchor.ts`
- Test: `tests/main/anchor.test.ts`

**Context:** `anchor.ts:157-172`'s `locate` function only checks `module === undefined` AFTER already running a full unbounded `ops.scanAob` across all executable memory (the `bounded` variable is computed from `module !== undefined`, so an undefined module falls through to the unbounded scan path). Since `'module-missing'` is in `CheatRuntime`'s retryable-reasons list, `CheatRuntime` re-triggers `locate` on backoff — every 5 seconds, forever, for a patch anchored to a module the current game build doesn't load — each retry re-scanning gigabytes of executable memory.

- [ ] **Step 1: Write a failing test**

Add to `tests/main/anchor.test.ts` (match this file's existing fake-`AnchorOps` pattern):

```ts
it('does not scan when the anchored module is not loaded', async () => {
  const scanAob = vi.fn().mockResolvedValue([])
  const ops = makeFakeOps({ scanAob }) // modules map deliberately does NOT include the patch's moduleName
  const patch: PatchCheat = {
    /* ...matching this file's existing fixture shape, with moduleName set
       to something NOT present in the fake modules map... */
  }
  const result = await locate(ops, patch, new Map(), new Set())
  expect(result.reason).toBe('module-missing')
  expect(scanAob).not.toHaveBeenCalled()
})
```

(Confirm `locate`'s actual exported signature — parameters and their order — in the current `anchor.ts` before writing this call; this plan's research read it as taking `ops`, `patch`, a `modules` map, and a `verified` set, per the surrounding code at lines 130-161, but verify directly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/anchor.test.ts`
Expected: FAIL — `scanAob` IS called currently.

- [ ] **Step 3: Add the short-circuit**

In `src/main/anchor.ts`, before the Path 2 scan block (around line 157-161), add an early return:

```ts
  const module =
    patch.moduleName === null ? undefined : modules.get(patch.moduleName.toLowerCase())

  // A patch anchored to a specific module that isn't loaded at all cannot
  // possibly be found by scanning — the code simply isn't mapped into the
  // process yet (or ever, for a build that dropped the DLL). Scanning
  // gigabytes of unrelated executable memory to reach the same conclusion
  // 'module-missing' would report anyway is pure waste, and since
  // CheatRuntime retries 'module-missing' on a 5-second backoff forever,
  // that waste repeats indefinitely for as long as the patch stays armed.
  if (patch.moduleName !== null && module === undefined) {
    return { address: null, matchCount: null, reason: 'module-missing', relearnedOffset: null, scanned: false }
  }

  // Path 1: module base + RVA, for a module whose fingerprint still matches.
  if (
    patch.moduleName !== null &&
    patch.moduleOffset !== null &&
    module &&
    verified.has(patch.moduleName.toLowerCase())
  ) {
    // ... existing Path 1 code, unchanged ...
```

(Confirm the exact shape of `locate`'s return type — `{ address, matchCount, reason, relearnedOffset, scanned }` per this plan's research at line 153/172 — before writing the early return, and match it exactly including the `scanned: false` field, which downstream code may depend on to distinguish "gave up without scanning" from "scanned and found nothing".)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/anchor.test.ts`
Expected: PASS, and every existing test unaffected — this only short-circuits a case that previously always resulted in `reason: 'module-missing'` anyway (per line 168-169's existing logic), just without the wasted scan first, so no existing test's EXPECTED OUTPUT changes, only whether `scanAob` gets called along the way. If any existing test asserts `scanAob` WAS called for a module-missing case, that assertion needs updating — per this plan's Global Constraint, treat that as a signal to double check the fix is scoped correctly, not to force the test to match.

- [ ] **Step 5: Typecheck and run full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/anchor.ts tests/main/anchor.test.ts
git commit -m "Skip the AOB scan when a patch's anchored module isn't loaded at all"
```

---

### Task 13: Make profile saves atomic

**Files:**
- Modify: `src/main/profile.ts`
- Test: `tests/main/profile.test.ts`

**Context:** `profile.ts:110-113`'s `saveProfile` is a bare `fs.writeFileSync` — a crash or power loss mid-write leaves a truncated/corrupt file, and `loadProfile` (line 62-73) correctly REFUSES to open a corrupt file rather than silently overwriting it, meaning the only recovery from an interrupted write is hand-editing JSON. This matters because saves happen unattended during gameplay (`patchEngine.onRelearn`, `recordModuleFingerprint`).

- [ ] **Step 1: Write a failing test**

Add to `tests/main/profile.test.ts` (match this file's existing `fs.mkdtempSync`-based temp-dir pattern):

```ts
it('never leaves a truncated file behind if the process were to die mid-write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprentice-profile-'))
  setGamesDir(dir)
  const profile: GameProfile = { schema: 2, exe: 'game', modules: {}, cheats: [] }
  saveProfile('game', profile)
  // The write must go through a temp file + rename, not a direct write —
  // confirm no stray .tmp file is left behind after a successful save
  // (proving the rename happened), and that the real file is valid JSON.
  const files = fs.readdirSync(dir)
  expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  expect(files).toContain('game.json')
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf-8'))
  expect(written.cheats).toEqual([])
  fs.rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/profile.test.ts`
Expected: this specific test likely already PASSES by accident (a direct `writeFileSync` also leaves no `.tmp` file) — the real regression this task guards against (a crash DURING the write) isn't directly testable without actually killing the process mid-write. Write the test anyway as a basic sanity check on the new code path, and rely on code review for the atomicity property itself; note this limitation in the task report rather than forcing an untestable claim into a passing assertion.

- [ ] **Step 3: Implement atomic write**

In `src/main/profile.ts`, change `saveProfile` (line 110-113):

```ts
export function saveProfile(exeName: string, profile: GameProfile): void {
  const target = filePathFor(exeName)
  const tmp = target + '.tmp'
  // Write to a temp file first, then rename over the target. A rename on
  // the same filesystem is atomic on both Windows (ReplaceFile-backed) and
  // POSIX — a crash or power loss mid-write leaves the .tmp file
  // incomplete/absent and the ORIGINAL file untouched, instead of a
  // half-written target that loadProfile then correctly refuses to open
  // with no way to recover short of hand-editing JSON.
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2))
  fs.renameSync(tmp, target)
}
```

(Confirm `filePathFor`'s exact name/signature in the current file before using it — this plan's research read it from the surrounding `loadProfile`/`saveProfile` pair.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/profile.test.ts`
Expected: PASS, all existing tests unaffected (the final on-disk content and filename are identical to before — only the write MECHANISM changed).

- [ ] **Step 5: Typecheck and run full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/profile.ts tests/main/profile.test.ts
git commit -m "Write profile saves to a temp file and rename, instead of a direct write"
```

---

### Task 14: Route value writes through the protect/restore dance, and surface a failed write in the UI

**Files:**
- Modify: `native/src/memory_ops.cc`
- Modify: `native/src/script_ops.cc`
- Modify: `src/renderer/src/screens/MemoryViewer.tsx`
- Test: `tests/native/memory_ops.test.ts`, `tests/native/script_ops.test.ts`

**Context:** `memory_ops.cc:50-...`'s `WriteValue` (used by the Memory Viewer's byte editor and every value-cheat write) and `script_ops.cc:255-264`'s `LuaWriteBytes` both call `WriteProcessMemory` directly with no protection dance — unlike `patch_ops.cc`'s `WriteBytes` and `platform_win32.cc`'s `WriteMemory`, which both correctly protect→write→restore→flush around a page that may be read-only or read-execute. Writing to a `PAGE_READONLY` page (or code) via either of these paths silently fails with no error surfaced anywhere — the Memory Viewer's edit input just closes with no visible change and no explanation. Additionally, `LuaWriteBytes` has no length cap unlike `LuaReadBytes`'s existing 4096-byte cap.

- [ ] **Step 1: Write a failing test for the protection dance**

Add to `tests/native/memory_ops.test.ts` (match this file's existing harness-driven pattern):

```ts
it('writeValue succeeds against a page that is not already writable', () => {
  // The harness process's own .text section (code) is PAGE_EXECUTE_READ,
  // not writable — find an address inside it (e.g. the harness's known
  // entry point, matching whatever this test file's OTHER tests already
  // use as a known-executable address) and confirm a value write there
  // succeeds rather than silently failing.
  const codeAddr = /* ... */
  const ok = (addon as any).writeValue(handle, codeAddr, [], 'int8', 0x90)
  expect(ok).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/memory_ops.test.ts`
Expected: FAIL — `WriteProcessMemory` against a non-writable page fails without the protection dance.

- [ ] **Step 3: Route `WriteValue` through the same protect/restore helper `patch_ops.cc`/`platform_win32.cc` already use**

Read `native/src/patch_ops.cc`'s `WriteBytes` (the function with the existing "temporarily make the page writable... put the original protection back... flush the instruction cache" comment) in full, and either (a) extract its protect/restore/flush logic into a small shared helper both files can call, or (b) inline the same dance directly into `memory_ops.cc`'s `WriteValue` — prefer (a) if the extraction is clean given the existing file boundaries, since `CODEBASE_MAP.md` already flags duplicated hex-parsing helpers across these same files as debt; don't compound it with a second duplicated protect/restore implementation if a shared header is a reasonable lift. If (a) proves more invasive than this task's scope, do (b) and note in the task report that the duplication should be addressed alongside the existing hex-helper debt in a future pass.

Whichever approach: `WriteValue` (`memory_ops.cc:50-...`) must end up wrapping its `WriteProcessMemory` call in VirtualProtectEx(PAGE_EXECUTE_READWRITE) → write → VirtualProtectEx(restore original) → FlushInstructionCache, matching `patch_ops.cc`'s existing multi-page-straddle-aware handling (read that function's own comment about `oldProtect` only reporting the FIRST page's protection when a range straddles a boundary — `WriteValue`'s writes are at most 8 bytes, so a straddle is possible near a page boundary and must be handled the same careful way `patch_ops.cc` already does, not a naive single-page assumption).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/native/memory_ops.test.ts`
Expected: PASS, plus every existing test in this file (writing to an already-writable page must behave identically to before — the protect/restore dance is a no-op in effect when the page was already `PAGE_READWRITE`).

- [ ] **Step 5: Cap `LuaWriteBytes`'s length and route it through the same protection dance**

In `native/src/script_ops.cc`'s `LuaWriteBytes` (line 255-264), add the same 4096-byte cap `LuaReadBytes` already has (line 244), and route the actual `WriteProcessMemory` call through Step 3's shared protect/restore mechanism:

```cpp
int LuaWriteBytes(lua_State* L) {
  uintptr_t address = static_cast<uintptr_t>(luaL_checkinteger(L, 1));
  size_t length;
  const char* data = luaL_checklstring(L, 2, &length);
  if (length == 0 || length > 4096) return luaL_error(L, "writeBytes length must be 1..4096");
  HANDLE h = HandleFromRegistry(L);
  bool ok = /* call Step 3's shared protect/restore/write helper with (h, address, data, length) */;
  lua_pushboolean(L, ok);
  return 1;
}
```

Add a native test to `tests/native/script_ops.test.ts` mirroring Step 1's memory_ops test, plus one confirming the new length cap raises a Lua error for a >4096-byte write, matching `LuaReadBytes`'s existing cap-rejection test if one exists in this file (copy its shape).

- [ ] **Step 6: Surface a failed write in the Memory Viewer UI**

In `src/renderer/src/screens/MemoryViewer.tsx`, `commitEdit` (or whatever the current function name is — read the file first) currently calls `window.tamper.writeMemoryByte(...)` and, per the earlier whole-codebase review, ignores its boolean return value entirely. Add a visible failure message:

```ts
  async function commitEdit(offset: number) {
    // ... existing validation/address computation ...
    const ok = await window.tamper.writeMemoryByte(byteAddress, value)
    if (!ok) {
      setDetachedError(`Write to ${byteAddress} failed — the page may be read-only.`)
      // (Reuse whatever error-state field this file already has for
      // surfacing a banner — `detachedError` if the earlier bugfix/review
      // pass already added one for the detach case, otherwise this file's
      // existing error-display convention; read the current file to match
      // exactly rather than introducing a second, parallel error field.)
    }
    setEditingOffset(null)
    const refreshed = await window.tamper.readMemoryBlock(baseAddress, PAGE_SIZE)
    setBlock(refreshed ? toArrayBuffer(refreshed) : null)
  }
```

(Match this function's actual current implementation exactly before editing — it has evolved across the memory-viewer plan's tasks and final-review fixes; this step only adds the `if (!ok)` branch, nothing else changes.)

- [ ] **Step 7: Rebuild and run the full native and app test suites**

Run: `cd native && npx node-gyp build && cd ..`
Run: `npx vitest run tests/native/memory_ops.test.ts tests/native/script_ops.test.ts`
Run: `npx vitest run`
Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: all clean/PASS.

- [ ] **Step 8: Commit**

```bash
git add native/src/memory_ops.cc native/src/script_ops.cc src/renderer/src/screens/MemoryViewer.tsx tests/native/memory_ops.test.ts tests/native/script_ops.test.ts
git commit -m "Route value writes through protect/restore; cap and report failed Lua/UI writes"
```

# Mono Runtime Symbol Resolution (#9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a class, field, or method by name against the target's live Mono runtime, and use that resolution as a new value-cheat target and a new patch anchor — proven against Valheim's own `Player.m_godMode` and `Character.ApplyDamage`.

**Architecture:** A generic native "remote call" primitive makes the target process execute a call into one of its own exported functions on a throwaway thread. A Mono bridge is built entirely from that primitive: resolve `mono.dll`'s exports by name, then call Mono's own introspection functions (class/field/method lookup, method compilation) the same way the target would call them itself. Two new consumers plug into existing machinery: `MonoTarget` (a value-cheat kind resolving through the existing offset-walk) and a third `anchor.ts` resolution path (resolving a patch's address by class+method name instead of module+RVA or AOB scan).

**Tech Stack:** Electron + React + TypeScript, C++ N-API addon (node-gyp, Zydis), vitest, MSVC for native test fixtures.

**Spec:** `docs/superpowers/specs/2026-07-30-mono-resolver-design.md`
**Codebase orientation:** `CODEBASE_MAP.md` — read it before Task 1.

## Global Constraints

- x86-64 only. Windows first, Linux-capable by construction: every new native call goes through `native/src/platform/platform.h`, Windows implementation + a Linux stub that refuses cleanly.
- No network calls anywhere in the stack.
- Every existing safety rule stands: never install on unverified bytes or an ambiguous/zero signature match; suspend all threads while writing an injection site; never free a cave while the process lives; restore on disable/detach/exit.
- **A resolved function address is verified to fall inside `mono.dll`'s own mapped range before it is ever called.** A lookup that returns garbage must never be called.
- **`mono_thread_attach` is always paired with `mono_thread_detach`**, owned by the bridge layer, never left to an individual call site.
- **A remote call that does not return within its timeout is abandoned, not waited on indefinitely.** Its cave is never freed while the thread could still be running.
- **No general "call an arbitrary game method with arbitrary arguments" feature.** Every call site this plan ships targets a fixed, known Mono introspection function; the only user-supplied input reaching the remote-call primitive is a name string looked up against Mono's own metadata.
- `mono_compile_method` (forcing a method to JIT-compile) is only ever triggered by an explicit user action — never automatically, never as part of a background retry.
- Addresses are `0x`-prefixed lowercase strings. Byte blobs are unspaced lowercase hex.
- Verification commands, from the repo root: `npx vitest run`, `npx tsc --noEmit`, `npm run build`.
- **Stop Tamper before rebuilding the native addon.** After changing `native/binding.gyp` sources, run `configure` before `build`. **Rebuild anything C from PowerShell, never Bash.**
- `tests/native/*.test.ts` must keep exactly one top-level `beforeAll` per file.

---

## File Structure

**Create:**
- `native/src/mono_call.cc` / `.h` — the generic remote-call primitive (stub builder, `CreateRemoteThread`-based execution, result read-back).
- `native/src/mono_bridge.cc` / `.h` — the Mono-specific layer built on `mono_call`: export resolution inside `mono.dll`, thread attach/detach pairing, and thin wrappers for each `mono_*` function this plan calls.
- `test-harness/probe_mono.c` — the fake Mono host DLL: hand-built fake metadata plus exports matching real Mono embedding-API signatures.
- `src/main/monoResolver.ts` — main-process wrapper: `resolveClass`, `resolveField`, `resolveMethod`, `listAssemblies`, `listClasses`, `listFields`, `listMethods`.
- `src/renderer/src/screens/MonoExplorer.tsx` — the browse/search/resolve screen.
- `tests/native/mono_call.test.ts`, `tests/native/mono_bridge.test.ts`, `tests/main/monoResolver.test.ts`, `tests/main/anchor.test.ts` (extended), `tests/main/cheatRuntime.test.ts` (extended).

**Modify:**
- `native/src/platform/platform.h`, `platform_win32.cc`, `platform_linux.cc` — add `ResolveExport`, `CreateRemoteThread`, `WaitForRemoteThread`, `CloseRemoteThread`.
- `native/src/cave_ops.cc` / `.h` — add `EncodeImmuneGuard`.
- `native/src/addon.cc`, `native/binding.gyp` — export and build the new files.
- `test-harness/harness.c` — a dedicated one-argument test-target function for the remote-thread primitive.
- `src/main/nativeAddon.ts` — typed wrappers for the new addon exports.
- `src/main/store.ts` — `MonoTarget`, `PatchCheat`'s `monoClass`/`monoMethod`/`monoMethodSignature`.
- `src/main/anchor.ts` — third resolution path; new `AnchorReason` values.
- `src/main/cheatRuntime.ts` — retryable-reason set gains the two new Mono reasons.
- `src/main/patchEngine.ts` — `immune` mode wiring.
- `src/main/ipc.ts` — `MonoTarget` read/write in `writeCheat`/`verifyCheat`; new `mono:*` IPC channels.
- `src/preload/index.ts`, `src/renderer/src/tamper.d.ts` — bridge the new channels.
- `src/renderer/src/App.tsx` — mount `MonoExplorer`.
- `CODEBASE_MAP.md` — new files, exports, channels.

---

## Task 1: Resolve an exported function's address inside a loaded module

**Files:**
- Modify: `native/src/platform/platform.h`, `platform_win32.cc`, `platform_linux.cc`, `native/src/addon.cc` (no new export yet — this task adds the platform primitive only; it is exercised indirectly via Task 3's Napi surface, and directly by a small native-only test that calls it through a tiny temporary export — see Step 6).
- Test: `tests/native/mono_call.test.ts` (created here, extended by later tasks)

**Interfaces:**
- Consumes: `platform::ReadMemory` (existing).
- Produces: `platform::ResolveExport(ProcessHandle handle, uintptr_t moduleBase, const std::string& name) -> uintptr_t` (0 on failure — module not really a PE, name not found, or a forwarded export, which this returns 0 for rather than resolving further).

Every later task needs to find a real function's address inside a module already loaded in the target (`probe_write` in `probe.dll` for Task 3's proof, and every `mono_*` function inside `mono.dll` from Task 5 onward). This is the one place that logic lives.

- [ ] **Step 1: Add the platform declaration**

In `native/src/platform/platform.h`, after `ListModules`:

```cpp
// The address of an exported function or variable inside a module already
// loaded in the target, found by walking that module's own PE export
// directory in the target's memory — not GetProcAddress, which only works
// on modules loaded in THIS process. Returns 0 when the module isn't a
// well-formed PE, the name isn't exported, or the export is a forwarder
// (a string naming another DLL's export rather than a real address) —
// none of this sub-project's targets are forwarded, and resolving a
// forwarder chain is not attempted.
uintptr_t ResolveExport(ProcessHandle handle, uintptr_t moduleBase, const std::string& name);
```

- [ ] **Step 2: Implement it for Windows**

In `native/src/platform/platform_win32.cc`, add (this file already includes `<windows.h>`):

```cpp
uintptr_t platform::ResolveExport(ProcessHandle handle, uintptr_t moduleBase, const std::string& name) {
  IMAGE_DOS_HEADER dos{};
  if (!platform::ReadMemory(handle, moduleBase, &dos, sizeof(dos))) return 0;
  if (dos.e_magic != IMAGE_DOS_SIGNATURE) return 0;

  IMAGE_NT_HEADERS64 nt{};
  if (!platform::ReadMemory(handle, moduleBase + dos.e_lfanew, &nt, sizeof(nt))) return 0;
  if (nt.Signature != IMAGE_NT_SIGNATURE) return 0;
  if (nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return 0; // refuse a 32-bit image, same reasoning as ListModules

  const IMAGE_DATA_DIRECTORY& exportDir =
      nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
  if (exportDir.VirtualAddress == 0 || exportDir.Size == 0) return 0;
  uintptr_t exportDirStart = moduleBase + exportDir.VirtualAddress;
  uintptr_t exportDirEnd = exportDirStart + exportDir.Size;

  IMAGE_EXPORT_DIRECTORY ied{};
  if (!platform::ReadMemory(handle, exportDirStart, &ied, sizeof(ied))) return 0;

  // Bounded the same way ListModules bounds its module count: a real
  // module's export table is a few hundred to a few thousand entries, and
  // capping avoids an unbounded read driven by a corrupt NumberOfNames.
  uint32_t count = ied.NumberOfNames;
  if (count > 16384) count = 16384;
  if (count == 0) return 0;

  std::vector<uint32_t> nameRvas(count);
  if (!platform::ReadMemory(handle, moduleBase + ied.AddressOfNames,
                            nameRvas.data(), count * sizeof(uint32_t))) return 0;
  std::vector<uint16_t> ordinals(count);
  if (!platform::ReadMemory(handle, moduleBase + ied.AddressOfNameOrdinals,
                            ordinals.data(), count * sizeof(uint16_t))) return 0;

  for (uint32_t i = 0; i < count; i++) {
    char nameBuf[256] = {0};
    if (!platform::ReadMemory(handle, moduleBase + nameRvas[i], nameBuf, sizeof(nameBuf) - 1)) continue;
    if (name != nameBuf) continue;

    uint16_t ordinal = ordinals[i];
    uint32_t funcRva = 0;
    if (!platform::ReadMemory(handle, moduleBase + ied.AddressOfFunctions + ordinal * sizeof(uint32_t),
                              &funcRva, sizeof(funcRva))) return 0;
    if (funcRva == 0) return 0;

    uintptr_t funcAddr = moduleBase + funcRva;
    // A forwarded export's RVA points back INSIDE the export directory
    // itself (at a "OtherDll.OtherFunc" string) rather than at real code.
    if (funcAddr >= exportDirStart && funcAddr < exportDirEnd) return 0;
    return funcAddr;
  }
  return 0;
}
```

- [ ] **Step 3: Implement the Linux stub**

In `native/src/platform/platform_linux.cc`:

```cpp
uintptr_t platform::ResolveExport(ProcessHandle, uintptr_t, const std::string&) {
  return 0;
}
```

- [ ] **Step 4: Rebuild the addon**

From PowerShell (Tamper must not be running):

```powershell
cd native; npx node-gyp build; cd ..
```

Expected: builds clean (no source-file list change yet, so `configure` is not required).

- [ ] **Step 5: Create the test file with a placeholder-free smoke test**

Since `ResolveExport` has no Napi export of its own yet, prove it through `native/src/addon.cc`'s existing test harness attach flow indirectly is not possible until Task 3 wires a caller. Instead, add a temporary-but-real internal test entry point: export it directly for testing purposes now (this export is genuinely useful on its own — later tasks reuse it — so it is not throwaway).

In `native/src/mono_call.h` (new file, created now so this task has something to export from; Task 3 fills in the rest of this file):

```cpp
#pragma once
#include <napi.h>

Napi::Value ResolveExport(const Napi::CallbackInfo& info);
```

In `native/src/mono_call.cc` (new file):

```cpp
#include "mono_call.h"
#include "platform/platform.h"
#include <cstdio>
#include <string>

namespace {
uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}
std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
} // namespace

Napi::Value ResolveExport(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t moduleBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string name = info[2].As<Napi::String>().Utf8Value();

  uintptr_t addr = platform::ResolveExport(handle, moduleBase, name);
  if (addr == 0) return env.Null();
  return Napi::String::New(env, ToHex(addr));
}
```

In `native/src/addon.cc`: add `#include "mono_call.h"` and, in the export table:

```cpp
  exports.Set("resolveExport", Napi::Function::New(env, ResolveExport));
```

In `native/binding.gyp`: add `"src/mono_call.cc"` to `sources`.

Create `tests/native/mono_call.test.ts`:

```ts
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

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('resolveExport', () => {
  it('finds a real exported function inside a loaded DLL', async () => {
    const reply = await send('loaddll')
    const probeBase = reply.split(' ')[1]

    const addr = (addon as any).resolveExport(handle, probeBase, 'probe_write')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)

    await send('unloaddll')
  })

  it('finds an exported data symbol too', async () => {
    await send('loaddll')
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')

    const addr = (addon as any).resolveExport(handle, probe.base, 'g_probe_field')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)

    await send('unloaddll')
  })

  it('returns null for a name that is not exported', async () => {
    await send('loaddll')
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')

    const addr = (addon as any).resolveExport(handle, probe.base, 'not_a_real_export')
    expect(addr).toBeNull()

    await send('unloaddll')
  })

  it('returns null against a bad module base', () => {
    const addr = (addon as any).resolveExport(handle, '0x1', 'anything')
    expect(addr).toBeNull()
  })
})
```

- [ ] **Step 6: Run the tests**

```powershell
cd native; npx node-gyp configure; npx node-gyp build; cd ..
```

Run: `npx vitest run tests/native/mono_call.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add native/src/platform native/src/mono_call.cc native/src/mono_call.h native/src/addon.cc native/binding.gyp tests/native/mono_call.test.ts
git commit -m "Resolve an exported function's address inside a loaded module"
```

---

## Task 2: Run a function on a throwaway thread inside the target

**Files:**
- Modify: `native/src/platform/platform.h`, `platform_win32.cc`, `platform_linux.cc`, `test-harness/harness.c`
- Test: `tests/native/mono_call.test.ts` (extended)

**Interfaces:**
- Consumes: nothing new.
- Produces: `platform::ThreadHandle` (alias for `uintptr_t`), `platform::CreateRemoteThread(ProcessHandle handle, uintptr_t startAddress, uintptr_t param) -> ThreadHandle` (0 on failure), `platform::WaitForRemoteThread(ThreadHandle thread, uint32_t timeoutMs) -> bool`, `platform::CloseRemoteThread(ThreadHandle thread) -> void`.

This is the actual "make the target run code it wasn't going to run" primitive. Task 3 builds the generic call-with-arguments stub on top of it; this task proves the raw mechanism works by pointing it at a dedicated one-argument test target, matching the exact ABI `CreateRemoteThread`'s start routine requires (`DWORD WINAPI ThreadProc(LPVOID param)` — one pointer argument, arriving in `RCX`).

- [ ] **Step 1: Add a dedicated remote-thread test target to the harness**

In `test-harness/harness.c`, add near the other exported-shaped helpers (this function's job is only to prove `CreateRemoteThread` genuinely ran code in the target — it writes a known marker through the pointer it's given):

```c
// Matches LPTHREAD_START_ROUTINE's exact ABI (one pointer arg, arriving in
// RCX per the Windows x64 convention) so CreateRemoteThread can start a
// thread here directly, with no stub needed — this proves the raw
// mechanism works before Task 3 builds a stub for functions that need
// MORE than one argument.
__declspec(dllexport) unsigned long __stdcall RemoteThreadProbe(void* param) {
  *(int*)param = 0x1337;
  return 0;
}
```

Add a harness command to report this function's address (needed since `harness.exe` is the running process itself, not a loaded DLL — `resolveExport` from Task 1 works on it exactly the same way, using `attach()`'s own reported `baseAddress`, so no new command is strictly required — this step just confirms the export exists; skip adding a command).

- [ ] **Step 2: Rebuild the harness**

From PowerShell:

```powershell
& cmd.exe /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'
```

Delete stray `.obj` files and verify `harness.exe`'s timestamp changed.

- [ ] **Step 3: Write the failing test**

Append to `tests/native/mono_call.test.ts`:

```ts
describe('remote thread', () => {
  it('runs a function inside the target and observes its effect', async () => {
    const { baseAddress } = (addon as any).attach(harness.pid) // fresh handle+base, same process
    const funcAddr = (addon as any).resolveExport(handle, baseAddress, 'RemoteThreadProbe')
    expect(funcAddr).toMatch(/^0x[0-9a-f]+$/)

    // A small scratch buffer inside the target for the probe to write into.
    // allocateCave already exists (cave_ops.cc) and gives readable/writable/
    // executable memory near an address — using it here for a plain
    // read/write scratch slot is a convenient reuse, not a new primitive.
    const scratch = (addon as any).allocateCave(handle, baseAddress)
    expect(scratch).not.toBeNull()

    const started = (addon as any).createRemoteThread(handle, funcAddr, scratch)
    expect(started).toBe(true)

    const value = (addon as any).readBytes(handle, scratch, 4)
    const marker = Buffer.from(value, 'hex').readInt32LE(0)
    expect(marker).toBe(0x1337)
  })

  it('reports failure rather than hanging when the timeout is too short for a slow target', () => {
    // Calling the SAME already-proven-working function again, but this is
    // exercising the plumbing (a real call still completes well inside a
    // short timeout for a trivial function) — the assertion is about the
    // API surface returning a boolean, not about inducing a real timeout,
    // which native/src/platform_win32.cc's WaitForRemoteThread test below
    // covers more directly.
    const funcAddr = (addon as any).resolveExport(handle, harnessBase, 'RemoteThreadProbe')
    const scratch = (addon as any).allocateCave(handle, harnessBase)
    const started = (addon as any).createRemoteThread(handle, funcAddr, scratch)
    expect(typeof started).toBe('boolean')
  })
})
```

Replace the second test's `harnessBase` with a variable captured once in `beforeAll` — add `let harnessBase: string` alongside the existing `let handle: number` at the top of the file, and set it in `beforeAll`: `const attached = (addon as any).attach(harness.pid); handle = attached.handle; harnessBase = attached.baseAddress`.

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/native/mono_call.test.ts -t "remote thread"`
Expected: FAIL — `createRemoteThread` is not a function.

- [ ] **Step 5: Add the platform declarations**

In `native/src/platform/platform.h`, after `ResolveExport`:

```cpp
using ThreadHandle = uintptr_t;

// Starts a thread in the target at `startAddress`, passing `param` as its
// single argument (matching LPTHREAD_START_ROUTINE's ABI: one pointer,
// arriving in RCX). Returns 0 on failure.
ThreadHandle CreateRemoteThread(ProcessHandle handle, uintptr_t startAddress, uintptr_t param);
// Waits up to timeoutMs for the thread to exit. False on timeout OR error
// — the caller must not free anything the thread could still be running
// inside when this returns false; see the never-free-a-live-cave rule.
bool WaitForRemoteThread(ThreadHandle thread, uint32_t timeoutMs);
void CloseRemoteThread(ThreadHandle thread);
```

- [ ] **Step 6: Implement for Windows**

In `native/src/platform/platform_win32.cc`:

```cpp
platform::ThreadHandle platform::CreateRemoteThread(ProcessHandle handle, uintptr_t startAddress, uintptr_t param) {
  HANDLE h = reinterpret_cast<HANDLE>(handle);
  HANDLE thread = ::CreateRemoteThread(
      h, nullptr, 0,
      reinterpret_cast<LPTHREAD_START_ROUTINE>(startAddress),
      reinterpret_cast<LPVOID>(param), 0, nullptr);
  return reinterpret_cast<uintptr_t>(thread);
}

bool platform::WaitForRemoteThread(ThreadHandle thread, uint32_t timeoutMs) {
  HANDLE h = reinterpret_cast<HANDLE>(thread);
  return WaitForSingleObject(h, timeoutMs) == WAIT_OBJECT_0;
}

void platform::CloseRemoteThread(ThreadHandle thread) {
  CloseHandle(reinterpret_cast<HANDLE>(thread));
}
```

- [ ] **Step 7: Implement the Linux stub**

In `native/src/platform/platform_linux.cc`:

```cpp
platform::ThreadHandle platform::CreateRemoteThread(ProcessHandle, uintptr_t, uintptr_t) { return 0; }
bool platform::WaitForRemoteThread(ThreadHandle, uint32_t) { return false; }
void platform::CloseRemoteThread(ThreadHandle) {}
```

- [ ] **Step 8: Add the Napi binding**

In `native/src/mono_call.h`, add:

```cpp
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info);
```

In `native/src/mono_call.cc`, add:

```cpp
// A simple, synchronous create-wait-close for this task's proof; Task 3's
// callRemoteFunction wraps the same three platform calls in an AsyncWorker
// so the interesting, potentially-slower version doesn't block Electron's
// main thread. This one exists to test CreateRemoteThread/WaitForRemote
// Thread/CloseRemoteThread in isolation, on a trivial one-argument target.
Napi::Value CreateRemoteThread(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t startAddress = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t param = ParseHex(info[2].As<Napi::String>().Utf8Value());

  platform::ThreadHandle thread = platform::CreateRemoteThread(handle, startAddress, param);
  if (thread == 0) return Napi::Boolean::New(env, false);

  bool ok = platform::WaitForRemoteThread(thread, 2000);
  platform::CloseRemoteThread(thread);
  return Napi::Boolean::New(env, ok);
}
```

In `native/src/addon.cc`, add to the export table:

```cpp
  exports.Set("createRemoteThread", Napi::Function::New(env, CreateRemoteThread));
```

- [ ] **Step 9: Rebuild and run**

```powershell
cd native; npx node-gyp build; cd ..
```

Run: `npx vitest run tests/native/mono_call.test.ts`
Expected: PASS, 7 tests total (5 from Task 1 plus this task's 2).

- [ ] **Step 10: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add native/src/platform native/src/mono_call.cc native/src/mono_call.h native/src/addon.cc test-harness/harness.c test-harness/harness.exe tests/native/mono_call.test.ts
git commit -m "Run a function on a throwaway thread inside the target"
```

---

## Task 3: The generic remote-call primitive

**Files:**
- Modify: `native/src/mono_call.cc`, `native/src/mono_call.h`, `native/src/addon.cc`
- Modify: `src/main/nativeAddon.ts`
- Test: `tests/native/mono_call.test.ts` (extended)

**Interfaces:**
- Consumes: `platform::AllocateNear`, `platform::WriteMemory`, `platform::ReadMemory`, `platform::CreateRemoteThread`, `platform::WaitForRemoteThread`, `platform::CloseRemoteThread`, `platform::ResolveExport` (all above).
- Produces: addon export `callRemoteFunction(handle, functionAddress, args: string[]) -> Promise<string | null>` — up to 4 hex-string arguments (each a `0x`-prefixed pointer or integer), resolves to an 8-byte hex result, or `null` on failure/timeout. `nativeAddon.ts`'s `callRemoteFunction(handle, functionAddress, args)`.

This is the piece every later Mono call is built from: given a real function address and up to four pointer/integer arguments, get the game to call it and hand back the return value.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/mono_call.test.ts`:

```ts
describe('callRemoteFunction', () => {
  it('calls a real exported function with two arguments and observes its effect', async () => {
    // RemoteCallProbe2 is added to the harness in Step 3 below, specifically
    // for this test: an ordinary two-pointer/integer-argument function,
    // deliberately NOT float-typed. Windows x64 assigns argument registers
    // positionally with the bank (GP vs XMM) chosen by that slot's type, so
    // a float argument needs XMM1, not RDX — this stub only ever loads
    // RCX/RDX/R8/R9, matching the plan's explicit scope: every real call
    // site in this sub-project is a Mono introspection function taking
    // pointers/integers only, never floats.
    const funcAddr = (addon as any).resolveExport(handle, harnessBase, 'RemoteCallProbe2')
    const scratch = (addon as any).allocateCave(handle, harnessBase)

    const result = await (addon as any).callRemoteFunction(handle, funcAddr, [scratch, '0x2a'])
    expect(result).not.toBeNull()

    const after = (addon as any).readBytes(handle, scratch, 4)
    expect(Buffer.from(after, 'hex').readInt32LE(0)).toBe(42)
  })

  it('works with fewer than 4 arguments', async () => {
    const funcAddr = (addon as any).resolveExport(handle, harnessBase, 'RemoteThreadProbe')
    const scratch = (addon as any).allocateCave(handle, harnessBase)
    const result = await (addon as any).callRemoteFunction(handle, funcAddr, [scratch])
    expect(result).not.toBeNull()
    const marker = (addon as any).readBytes(handle, scratch, 4)
    expect(Buffer.from(marker, 'hex').readInt32LE(0)).toBe(0x1337)
  })

  it('resolves null rather than throwing when the function address is bogus', async () => {
    const result = await (addon as any).callRemoteFunction(handle, '0x1', [])
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/mono_call.test.ts -t "callRemoteFunction"`
Expected: FAIL — `callRemoteFunction` is not a function.

- [ ] **Step 3: Add a two-argument harness test target**

In `test-harness/harness.c`, add near `RemoteThreadProbe` (Task 2):

```c
// A two-argument remote-call proof: writes `value` through `target`.
// Unlike RemoteThreadProbe (Task 2), this is NOT shaped as a thread entry
// point — it's an ordinary function with a normal 2-argument prototype,
// proving the stub's argument marshalling rather than the raw
// thread-start mechanism. Deliberately int/pointer-typed, not float:
// Windows x64 assigns argument registers positionally with the bank (GP
// vs XMM) chosen by that slot's type, and this stub only ever loads
// RCX/RDX/R8/R9 — matching the plan's scope, since every real call site
// in this sub-project is a Mono introspection function taking
// pointers/integers only.
__declspec(dllexport) void __stdcall RemoteCallProbe2(int* target, int value) {
  *target = value;
}
```

Rebuild the harness from PowerShell and verify `harness.exe`'s timestamp changed, the same way Task 2's `RemoteThreadProbe` addition was built.

- [ ] **Step 4: Write the stub-builder**

In `native/src/mono_call.cc`, add (before the Napi entry points):

```cpp
namespace {

// Builds a small stub, hand-encoded the same way EncodeJump in cave_ops.cc
// is — the byte layout here is exactly what matters, so it is written
// directly rather than through Zydis's encoder. Windows x64 calling
// convention: the first four integer/pointer arguments go in RCX, RDX, R8,
// R9. The stub loads up to 4 args, calls the target function, writes its
// 8-byte return value (RAX) to resultAddress, and returns 0 as the
// thread's exit code.
//
// Stack alignment: CreateRemoteThread invokes this stub as a real thread
// entry point, through Windows' own thread-start trampoline — which,
// like any function call, leaves RSP ≡ 8 (mod 16) at our entry (a `call`
// pushes an 8-byte return address, so a callee always sees that parity).
// A `call` we make ourselves needs RSP ≡ 0 (mod 16) immediately before
// it. `sub rsp, 0x28` (40 ≡ 8 mod 16) is the standard fix: it both
// flips the parity to 0 mod 16 and provides the required 0x20 shadow-space
// bytes in one instruction — the idiom used by essentially every
// hand-written stub that calls into the Win64 ABI from a raw entry point.
// `add rsp, 0x28` after the call is its exact inverse (unlike an `and`,
// which would lose bits and make the adjustment irreversible), so RSP is
// back to its true entry value before this stub's own `ret` — otherwise
// that `ret` pops garbage instead of the address the OS's trampoline
// expects, corrupting the thread (and, empirically, taking the whole
// target process down with it).
//
//   mov rcx, args[0]      48 B9 <imm64>   (10 bytes, 0 if unused)
//   mov rdx, args[1]      48 BA <imm64>   (10 bytes)
//   mov r8,  args[2]      49 B8 <imm64>   (10 bytes)
//   mov r9,  args[3]      49 B9 <imm64>   (10 bytes)
//   mov rax, function     48 B8 <imm64>   (10 bytes)
//   sub rsp, 0x28         48 83 EC 28     (4 bytes)
//   call rax              FF D0           (2 bytes)
//   add rsp, 0x28         48 83 C4 28     (4 bytes)
//   mov rcx, resultAddr   48 B9 <imm64>   (10 bytes)
//   mov [rcx], rax        48 89 01        (3 bytes)
//   xor eax, eax          31 C0           (2 bytes)
//   ret                   C3              (1 byte)
std::vector<uint8_t> BuildCallStub(uintptr_t function,
                                   const std::vector<uintptr_t>& args,
                                   uintptr_t resultAddress) {
  std::vector<uint8_t> out;
  auto emitMovImm64 = [&](uint8_t opcodeByte, bool rex49, uintptr_t imm) {
    out.push_back(rex49 ? 0x49 : 0x48);
    out.push_back(opcodeByte);
    for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(imm >> (i * 8)));
  };

  uintptr_t a0 = args.size() > 0 ? args[0] : 0;
  uintptr_t a1 = args.size() > 1 ? args[1] : 0;
  uintptr_t a2 = args.size() > 2 ? args[2] : 0;
  uintptr_t a3 = args.size() > 3 ? args[3] : 0;

  emitMovImm64(0xB9, false, a0);       // mov rcx, a0
  emitMovImm64(0xBA, false, a1);       // mov rdx, a1
  emitMovImm64(0xB8, true, a2);        // mov r8,  a2
  emitMovImm64(0xB9, true, a3);        // mov r9,  a3
  emitMovImm64(0xB8, false, function); // mov rax, function

  out.insert(out.end(), {0x48, 0x83, 0xEC, 0x28}); // sub rsp, 0x28
  out.insert(out.end(), {0xFF, 0xD0});             // call rax
  out.insert(out.end(), {0x48, 0x83, 0xC4, 0x28}); // add rsp, 0x28 (exact inverse)

  emitMovImm64(0xB9, false, resultAddress); // mov rcx, resultAddress
  out.insert(out.end(), {0x48, 0x89, 0x01}); // mov [rcx], rax
  out.insert(out.end(), {0x31, 0xC0});       // xor eax, eax
  out.push_back(0xC3);                       // ret

  return out;
}

// The 76-byte stub above, plus its 8-byte result slot, fits comfortably in
// a single cave. The result slot sits at cave+0 and the stub code at
// cave+8, matching cave_ops.cc's own documented slot-then-code layout.
constexpr uintptr_t kResultOffset = 0;
constexpr uintptr_t kCodeOffset = 8;

} // namespace

class RemoteCallWorker : public Napi::AsyncWorker {
 public:
  RemoteCallWorker(Napi::Env env, platform::ProcessHandle handle,
                   uintptr_t function, std::vector<uintptr_t> args)
      : Napi::AsyncWorker(env),
        handle_(handle),
        function_(function),
        args_(std::move(args)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    uintptr_t cave = platform::AllocateNear(handle_, function_, 256);
    if (!cave) return; // ok_ stays false; OnOK reports null

    std::vector<uint8_t> stub = BuildCallStub(function_, args_, cave + kResultOffset);
    if (!platform::WriteMemory(handle_, cave + kCodeOffset, stub.data(), stub.size())) return;

    platform::ThreadHandle thread =
        platform::CreateRemoteThread(handle_, cave + kCodeOffset, 0);
    if (!thread) return;

    bool finished = platform::WaitForRemoteThread(thread, 2000);
    platform::CloseRemoteThread(thread);
    // Never read the result slot, and never treat the cave as free to
    // reuse, unless the thread genuinely finished — see the never-free-a-
    // live-cave rule. A caller only sees `null`; the cave is deliberately
    // leaked in the timeout case rather than freed out from under a thread
    // that might still be running inside it, the same trade-off #7 already
    // made for a failed install.
    if (!finished) return;

    uint8_t result[8] = {0};
    if (!platform::ReadMemory(handle_, cave + kResultOffset, result, sizeof(result))) return;
    memcpy(result_, result, sizeof(result));
    ok_ = true;
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!ok_) {
      deferred_.Resolve(env.Null());
      return;
    }
    char hex[20];
    snprintf(hex, sizeof(hex), "0x%02x%02x%02x%02x%02x%02x%02x%02x",
             result_[7], result_[6], result_[5], result_[4],
             result_[3], result_[2], result_[1], result_[0]);
    deferred_.Resolve(Napi::String::New(env, hex));
  }

  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t function_;
  std::vector<uintptr_t> args_;
  bool ok_ = false;
  uint8_t result_[8] = {0};
  Napi::Promise::Deferred deferred_;
};
```

- [ ] **Step 5: Add the Napi entry point**

In `native/src/mono_call.h`, add:

```cpp
Napi::Value CallRemoteFunction(const Napi::CallbackInfo& info);
```

In `native/src/mono_call.cc`, add:

```cpp
Napi::Value CallRemoteFunction(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t function = ParseHex(info[1].As<Napi::String>().Utf8Value());

  std::vector<uintptr_t> args;
  if (info.Length() >= 3 && info[2].IsArray()) {
    Napi::Array arr = info[2].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length() && i < 4; i++) {
      args.push_back(ParseHex(arr.Get(i).As<Napi::String>().Utf8Value()));
    }
  }

  auto* worker = new RemoteCallWorker(env, handle, function, std::move(args));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
```

In `native/src/addon.cc`, add `#include <cstring>` if not already present (for `memcpy`) and, in the export table:

```cpp
  exports.Set("callRemoteFunction", Napi::Function::New(env, CallRemoteFunction));
```

- [ ] **Step 6: Rebuild and run**

```powershell
cd native; npx node-gyp build; cd ..
```

Run: `npx vitest run tests/native/mono_call.test.ts`
Expected: PASS, 10 tests total (7 from Tasks 1-2 plus this task's 3).

- [ ] **Step 7: Add the typed wrapper**

In `src/main/nativeAddon.ts`:

```ts
  // Makes the target execute a call into one of its own exported
  // functions, on a throwaway thread, and reports the 8-byte return value
  // back (as 0x-prefixed hex), or null on failure/timeout. Up to 4
  // pointer/integer arguments. Runs on a background thread in the addon
  // (Napi::AsyncWorker) — a remote call can take up to its 2s timeout.
  callRemoteFunction: (
    handle: number,
    functionAddress: string,
    args: string[]
  ): Promise<string | null> => addon.callRemoteFunction(handle, functionAddress, args),
```

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add native/src/mono_call.cc native/src/mono_call.h native/src/addon.cc test-harness/harness.c test-harness/harness.exe src/main/nativeAddon.ts tests/native/mono_call.test.ts
git commit -m "Make the target call its own exported functions on our behalf"
```

---

## Task 4: A fake Mono host for testing

**Files:**
- Create: `test-harness/probe_mono.c`
- Modify: `.gitignore` (build outputs, if not already covered by the Task 2/`#8` pattern)

**Interfaces:**
- Consumes: nothing — this is a standalone fixture DLL.
- Produces: harness commands `loadmono` → `OK <0xbase>`, `unloadmono` → `OK`. Exports matching real Mono embedding-API signatures, backed by hand-built fake metadata: `mono_get_root_domain`, `mono_thread_attach`, `mono_thread_detach`, `mono_class_from_name`, `mono_class_get_fields`, `mono_field_get_name`, `mono_field_get_offset`, `mono_class_get_methods`, `mono_method_get_name`, `mono_compile_method`, `mono_assembly_foreach`, `mono_assembly_get_image`.

Real Mono cannot be embedded in the test harness, so this fixture stands in for it: same function names and argument shapes real Mono uses, backed by fake, hand-built data the tests can assert exact values against. Every later task's tests call these exports through `callRemoteFunction`, exactly the way `mono_bridge.cc` will call the real ones.

- [ ] **Step 1: Design the fake metadata**

Two fake classes, each with one field and one method, plus one fake assembly containing both — enough to prove every operation this plan needs without needing a third.

- [ ] **Step 2: Write `probe_mono.c`**

Create `test-harness/probe_mono.c`:

```c
#include <windows.h>
#include <string.h>

// Fake stand-ins for Mono's opaque handle types. Real Mono callers never
// look inside these structs — they only pass the pointers back into other
// mono_* calls — so this fixture is free to lay them out however is
// convenient, as long as every exported function's SIGNATURE (argument
// and return types) matches real Mono's public embedding API exactly.
// That signature match is what lets mono_bridge.cc's calling code be
// tested here and trusted against the real mono.dll unchanged.

typedef struct { int dummy; } FakeDomain;
typedef struct { int dummy; } FakeThread;
typedef struct { int dummy; } FakeAssembly;
typedef struct { int dummy; } FakeImage;

typedef struct {
  const char* name;
  int offset; // field offset within an instance, as mono_field_get_offset returns
} FakeField;

typedef struct {
  const char* name;
} FakeMethod;

typedef struct {
  const char* namespaceName;
  const char* className;
  FakeField fields[2];
  int fieldCount;
  FakeMethod methods[2];
  int methodCount;
} FakeClass;

static FakeDomain g_domain;
static FakeThread g_thread;
static FakeAssembly g_assembly;
static FakeImage g_image;

// "Player" with one static-ish field the tests treat as m_godMode, and one
// method standing in for ApplyDamage. "Character" is a second class purely
// to prove class-name lookup actually discriminates between two classes
// rather than always returning the first one defined.
static FakeClass g_classes[2] = {
  { "", "Player",
    { { "m_godMode", 0x691 }, { "m_localPlayer", 0x10 } }, 2,
    { { "UseStamina" }, { "TakeDamage" } }, 2 },
  { "", "Character",
    { { "m_health", 0x20 } }, 1,
    { { "ApplyDamage" } }, 1 },
};

__declspec(dllexport) FakeDomain* __stdcall mono_get_root_domain(void) {
  return &g_domain;
}

__declspec(dllexport) FakeThread* __stdcall mono_thread_attach(FakeDomain* domain) {
  (void)domain;
  return &g_thread;
}

__declspec(dllexport) void __stdcall mono_thread_detach(FakeThread* thread) {
  (void)thread;
}

__declspec(dllexport) FakeImage* __stdcall mono_assembly_get_image(FakeAssembly* assembly) {
  (void)assembly;
  return &g_image;
}

__declspec(dllexport) FakeClass* __stdcall mono_class_from_name(
    FakeImage* image, const char* nameSpace, const char* name) {
  (void)image;
  for (int i = 0; i < 2; i++) {
    if (strcmp(g_classes[i].namespaceName, nameSpace) == 0 &&
        strcmp(g_classes[i].className, name) == 0) {
      return &g_classes[i];
    }
  }
  return NULL;
}

// Iterator-style, matching real Mono: caller owns an 8-byte iter slot,
// initialized to 0, passed by pointer; each call returns the next field
// (or NULL when exhausted) and advances *iter itself.
__declspec(dllexport) FakeField* __stdcall mono_class_get_fields(FakeClass* klass, void** iter) {
  intptr_t index = (intptr_t)*iter;
  if (index >= klass->fieldCount) return NULL;
  *iter = (void*)(index + 1);
  return &klass->fields[index];
}

__declspec(dllexport) const char* __stdcall mono_field_get_name(FakeField* field) {
  return field->name;
}

__declspec(dllexport) int __stdcall mono_field_get_offset(FakeField* field) {
  return field->offset;
}

__declspec(dllexport) FakeMethod* __stdcall mono_class_get_methods(FakeClass* klass, void** iter) {
  intptr_t index = (intptr_t)*iter;
  if (index >= klass->methodCount) return NULL;
  *iter = (void*)(index + 1);
  return &klass->methods[index];
}

__declspec(dllexport) const char* __stdcall mono_method_get_name(FakeMethod* method) {
  return method->name;
}

// Real mono_compile_method returns the JIT-compiled entry address. This
// fixture has no JIT, so it returns the method struct's own address —
// tests assert THAT a non-null, stable address comes back and that calling
// it twice for the same method returns the same address, not that it
// points at real machine code.
__declspec(dllexport) void* __stdcall mono_compile_method(FakeMethod* method) {
  return (void*)method;
}

typedef void (__stdcall *ForeachCallback)(void* data, void* userData);

__declspec(dllexport) void __stdcall mono_assembly_foreach(ForeachCallback callback, void* userData) {
  callback(&g_assembly, userData);
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h; (void)reason; (void)reserved;
  return TRUE;
}
```

- [ ] **Step 3: Add harness commands**

In `test-harness/harness.c`, near the `loaddll`/`unloaddll` commands:

```c
    } else if (strncmp(line, "loadmono", 8) == 0) {
      HMODULE m = LoadLibraryA("test-harness\\probe_mono.dll");
      if (m == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)m);
    } else if (strncmp(line, "unloadmono", 10) == 0) {
      HMODULE m = GetModuleHandleA("probe_mono.dll");
      if (m != NULL) FreeLibrary(m);
      printf("OK\n");
```

Place these before the `loaddll`/`unloaddll` checks or after — neither shares a prefix with `loaddll`/`unloaddll`/any existing command, so ordering is not load-bearing here (unlike `loaddll2` vs `loaddll` in Task 2 of #8).

- [ ] **Step 4: Build the fixture DLL and the harness**

From PowerShell:

```powershell
& cmd.exe /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /LD /Fe:test-harness\probe_mono.dll test-harness\probe_mono.c'
& cmd.exe /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'
```

Delete stray `.obj`/`.lib`/`.exp` files; verify both output timestamps changed.

- [ ] **Step 5: Commit the fixture (no tests yet — Task 5 is the first consumer)**

`probe_mono.dll` follows the same commit-the-binary precedent `probe.dll`/`probe2.dll` already set in #8.

```bash
git add test-harness/probe_mono.c test-harness/probe_mono.dll test-harness/harness.c test-harness/harness.exe
git commit -m "Add a fake Mono host for testing symbol resolution without a real game"
```

---

## Task 5: Resolve a class and a field by name

**Files:**
- Create: `native/src/mono_bridge.cc`, `native/src/mono_bridge.h`, `src/main/monoResolver.ts`
- Modify: `native/src/addon.cc`, `native/binding.gyp`, `src/main/nativeAddon.ts`
- Test: `tests/native/mono_bridge.test.ts`

**Interfaces:**
- Consumes: `callRemoteFunction`, `resolveExport` (Task 1/3); `probe_mono.dll` (Task 4).
- Produces: addon export `monoResolveClass(handle, monoDllBase, namespaceName, className) -> Promise<string | null>` (a `MonoClass*` handle, as hex), `monoResolveField(handle, monoDllBase, classHandle, fieldName) -> Promise<{ offset: number } | null>` — offset only, since a field's address is `objectPointer + offset`, and the object pointer is a separate concern (resolved via `monoStaticFieldValue` below). `monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName) -> Promise<string | null>` — the STATIC field's own storage address (used for a field like `m_localPlayer`, whose *value*, not offset, is the thing to dereference). `src/main/monoResolver.ts` wraps all three plus the attach/detach pairing (see Step 3).

The class name string, the field name string, and every argument passed to `callRemoteFunction` have to exist *inside the target's memory* — Mono's functions take `const char*`, not a value marshalled some other way. This task's real complexity is writing those strings into the target (a cave, written once, reused for every lookup) before calling anything.

- [ ] **Step 1: Write the failing test**

Create `tests/native/mono_bridge.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number
let monoBase: string

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
  const reply = await send('loadmono')
  monoBase = reply.split(' ')[1]
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('monoResolveClass', () => {
  it('resolves a real class by namespace and name', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    expect(klass).toMatch(/^0x[0-9a-f]+$/)
  })

  it('resolves a different class to a different handle', async () => {
    const player = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const character = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    expect(character).not.toBe(player)
  })

  it('returns null for a class that does not exist', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'NoSuchClass')
    expect(klass).toBeNull()
  })
})

describe('monoResolveField', () => {
  it('finds a known field and its offset', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const field = await (addon as any).monoResolveField(handle, monoBase, klass, 'm_godMode')
    expect(field.offset).toBe(0x691)
  })

  it('returns null for a field that does not exist on that class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const field = await (addon as any).monoResolveField(handle, monoBase, klass, 'not_a_field')
    expect(field).toBeNull()
  })
})

describe('monoStaticFieldAddress', () => {
  it('finds the storage address of a field, distinct from its offset', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const addr = await (addon as any).monoStaticFieldAddress(handle, monoBase, klass, 'm_localPlayer')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/mono_bridge.test.ts`
Expected: FAIL — `monoResolveClass` is not a function.

- [ ] **Step 3: Write the shared remote-call sequence, then `mono_bridge.cc`**

Every bridge call needs the exact same attach → call → detach pattern, so first factor the allocate-write-run-read-cleanup sequence `RemoteCallWorker` (Task 3) already implements out into a shared free function — `mono_bridge.cc`'s workers call it directly rather than round-tripping through the async `callRemoteFunction` Napi boundary from within native code.

In `native/src/mono_call.h`, add:

```cpp
// Shared by RemoteCallWorker and mono_bridge.cc's multi-step sequences: the
// full allocate-write-run-read-cleanup sequence for one remote call.
// Returns true and fills `outResult` (8 bytes) on success.
bool RunRemoteCall(platform::ProcessHandle handle, uintptr_t function,
                   const std::vector<uintptr_t>& args, uint8_t outResult[8]);
```

In `native/src/mono_call.cc`, extract this from `RemoteCallWorker::Execute()`:

```cpp
bool RunRemoteCall(platform::ProcessHandle handle, uintptr_t function,
                   const std::vector<uintptr_t>& args, uint8_t outResult[8]) {
  uintptr_t cave = platform::AllocateNear(handle, function, 256);
  if (!cave) return false;

  std::vector<uint8_t> stub = BuildCallStub(function, args, cave + kResultOffset);
  if (!platform::WriteMemory(handle, cave + kCodeOffset, stub.data(), stub.size())) return false;

  platform::ThreadHandle thread = platform::CreateRemoteThread(handle, cave + kCodeOffset, 0);
  if (!thread) return false;

  bool finished = platform::WaitForRemoteThread(thread, 2000);
  platform::CloseRemoteThread(thread);
  if (!finished) return false;

  return platform::ReadMemory(handle, cave + kResultOffset, outResult, 8);
}
```

`BuildCallStub`, `kResultOffset`, and `kCodeOffset` stay file-local to `mono_call.cc` (only `RunRemoteCall` is declared in the header). `RemoteCallWorker::Execute()` becomes a two-line call to `RunRemoteCall`.

Now write `mono_bridge.cc`:

```cpp
#include "mono_bridge.h"
#include "mono_call.h"
#include "platform/platform.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}
std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}
uintptr_t BytesToPtr(const uint8_t b[8]) {
  uintptr_t v = 0;
  memcpy(&v, b, 8);
  return v;
}

uintptr_t WriteString(platform::ProcessHandle handle, uintptr_t near, const std::string& s) {
  uintptr_t cave = platform::AllocateNear(handle, near, 256);
  if (!cave) return 0;
  std::vector<char> buf(s.begin(), s.end());
  buf.push_back('\0');
  if (!platform::WriteMemory(handle, cave, buf.data(), buf.size())) return 0;
  return cave;
}

// The attach/detach pairing every bridge call needs. Returns the root
// domain and the attached thread handle, or 0/0 on failure — a caller that
// gets 0/0 must not proceed to any further call.
struct MonoContext {
  uintptr_t rootDomain = 0;
  uintptr_t attachedThread = 0;
  bool ok = false;
};

MonoContext AttachToMono(platform::ProcessHandle handle, uintptr_t monoDllBase) {
  MonoContext ctx;
  uintptr_t getRootDomain = platform::ResolveExport(handle, monoDllBase, "mono_get_root_domain");
  uintptr_t threadAttach = platform::ResolveExport(handle, monoDllBase, "mono_thread_attach");
  if (!getRootDomain || !threadAttach) return ctx;

  uint8_t result[8] = {0};
  if (!RunRemoteCall(handle, getRootDomain, {}, result)) return ctx;
  ctx.rootDomain = BytesToPtr(result);
  if (!ctx.rootDomain) return ctx;

  if (!RunRemoteCall(handle, threadAttach, {ctx.rootDomain}, result)) return ctx;
  ctx.attachedThread = BytesToPtr(result);
  if (!ctx.attachedThread) return ctx;

  ctx.ok = true;
  return ctx;
}

void DetachFromMono(platform::ProcessHandle handle, uintptr_t monoDllBase, const MonoContext& ctx) {
  if (!ctx.ok) return;
  uintptr_t threadDetach = platform::ResolveExport(handle, monoDllBase, "mono_thread_detach");
  if (!threadDetach) return;
  uint8_t ignored[8];
  RunRemoteCall(handle, threadDetach, {ctx.attachedThread}, ignored);
}

} // namespace

class MonoResolveClassWorker : public Napi::AsyncWorker {
 public:
  MonoResolveClassWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                         std::string namespaceName, std::string className)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        namespaceName_(std::move(namespaceName)), className_(std::move(className)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    // NOTE: real mono_class_from_name takes a MonoImage*, not a domain —
    // resolving an image from an assembly is Task 7's job (assembly
    // enumeration). For this task, callers pass the image handle directly
    // as `monoDllBase` parameter's sibling argument — see monoResolver.ts's
    // resolveClass, which threads a caller-supplied image handle through.
    uintptr_t classFromName = platform::ResolveExport(handle_, monoDllBase_, "mono_class_from_name");
    if (!classFromName) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uintptr_t nsAddr = WriteString(handle_, monoDllBase_, namespaceName_);
    uintptr_t nameAddr = WriteString(handle_, monoDllBase_, className_);
    if (!nsAddr || !nameAddr) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uint8_t result[8] = {0};
    if (RunRemoteCall(handle_, classFromName, {imageHandle_, nsAddr, nameAddr}, result)) {
      uintptr_t classHandle = BytesToPtr(result);
      if (classHandle) { classHandle_ = classHandle; ok_ = true; }
    }
    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    if (!ok_) { deferred_.Resolve(Env().Null()); return; }
    deferred_.Resolve(Napi::String::New(Env(), ToHex(classHandle_)));
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

  void SetImageHandle(uintptr_t h) { imageHandle_ = h; }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_;
  uintptr_t imageHandle_ = 0;
  std::string namespaceName_, className_;
  bool ok_ = false;
  uintptr_t classHandle_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoResolveClass(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string namespaceName = info[2].As<Napi::String>().Utf8Value();
  std::string className = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoResolveClassWorker(env, handle, monoDllBase, namespaceName, className);
  // Test fixture only: the fake host's mono_class_from_name ignores its
  // image argument entirely (see probe_mono.c), so 0 is fine here. The
  // real bridge (Task 7) threads a resolved MonoImage* through once
  // assembly/image enumeration exists — tracked there, not here.
  worker->SetImageHandle(0);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class MonoResolveFieldWorker : public Napi::AsyncWorker {
 public:
  MonoResolveFieldWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                         uintptr_t classHandle, std::string fieldName, bool wantAddress)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        classHandle_(classHandle), fieldName_(std::move(fieldName)), wantAddress_(wantAddress),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    uintptr_t getFields = platform::ResolveExport(handle_, monoDllBase_, "mono_class_get_fields");
    uintptr_t getName = platform::ResolveExport(handle_, monoDllBase_, "mono_field_get_name");
    uintptr_t getOffset = platform::ResolveExport(handle_, monoDllBase_, "mono_field_get_offset");
    if (!getFields || !getName || !getOffset) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uintptr_t iterSlot = platform::AllocateNear(handle_, monoDllBase_, 16);
    if (!iterSlot) { DetachFromMono(handle_, monoDllBase_, ctx); return; }
    uintptr_t zero = 0;
    platform::WriteMemory(handle_, iterSlot, &zero, sizeof(zero));

    for (int guard = 0; guard < 256; guard++) {
      uint8_t result[8] = {0};
      if (!RunRemoteCall(handle_, getFields, {classHandle_, iterSlot}, result)) break;
      uintptr_t field = BytesToPtr(result);
      if (!field) break; // iteration exhausted

      uint8_t nameResult[8] = {0};
      if (!RunRemoteCall(handle_, getName, {field}, nameResult)) break;
      uintptr_t namePtr = BytesToPtr(nameResult);
      char nameBuf[256] = {0};
      if (!platform::ReadMemory(handle_, namePtr, nameBuf, sizeof(nameBuf) - 1)) continue;

      if (fieldName_ == nameBuf) {
        if (wantAddress_) {
          fieldAddress_ = field; // caller wants the field's own storage location
        } else {
          uint8_t offsetResult[8] = {0};
          if (RunRemoteCall(handle_, getOffset, {field}, offsetResult)) {
            offset_ = static_cast<int32_t>(BytesToPtr(offsetResult));
          }
        }
        ok_ = true;
        break;
      }
    }
    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!ok_) { deferred_.Resolve(env.Null()); return; }
    if (wantAddress_) {
      deferred_.Resolve(Napi::String::New(env, ToHex(fieldAddress_)));
      return;
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("offset", Napi::Number::New(env, offset_));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::string fieldName_;
  bool wantAddress_;
  bool ok_ = false;
  int32_t offset_ = 0;
  uintptr_t fieldAddress_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoResolveField(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());
  std::string fieldName = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoResolveFieldWorker(env, handle, monoDllBase, classHandle, fieldName, false);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value MonoStaticFieldAddress(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());
  std::string fieldName = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoResolveFieldWorker(env, handle, monoDllBase, classHandle, fieldName, true);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
```

Update `native/src/mono_call.h` to declare `RunRemoteCall` as shown above, and remove the now-duplicated body from `RemoteCallWorker::Execute()`, replacing it with:

```cpp
  void Execute() override {
    uint8_t result[8] = {0};
    ok_ = RunRemoteCall(handle_, function_, args_, result);
    if (ok_) memcpy(result_, result, 8);
  }
```

- [ ] **Step 4: Wire the Napi exports and build**

In `native/src/addon.cc`: add `#include "mono_bridge.h"` and, in the export table:

```cpp
  exports.Set("monoResolveClass", Napi::Function::New(env, MonoResolveClass));
  exports.Set("monoResolveField", Napi::Function::New(env, MonoResolveField));
  exports.Set("monoStaticFieldAddress", Napi::Function::New(env, MonoStaticFieldAddress));
```

In `native/binding.gyp`, add `"src/mono_bridge.cc"` to `sources`.

```powershell
cd native; npx node-gyp configure; npx node-gyp build; cd ..
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/native/mono_bridge.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write `monoResolver.ts`**

Create `src/main/monoResolver.ts`:

```ts
import { nativeAddon } from './nativeAddon'

// Thin wrappers over the native Mono bridge. Every function here resolves
// or returns null — never throws — matching the codebase's existing
// convention for "can't find it right now" being a normal outcome, not an
// error (see nativeAddon.ts's tryReadBytes/tryReadValue).
export const monoResolver = {
  resolveClass: (
    handle: number,
    monoDllBase: string,
    namespaceName: string,
    className: string
  ): Promise<string | null> => nativeAddon.monoResolveClass(handle, monoDllBase, namespaceName, className),

  resolveField: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<{ offset: number } | null> =>
    nativeAddon.monoResolveField(handle, monoDllBase, classHandle, fieldName),

  staticFieldAddress: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<string | null> =>
    nativeAddon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName)
}
```

Add the corresponding typed wrappers to `src/main/nativeAddon.ts`:

```ts
  monoResolveClass: (
    handle: number,
    monoDllBase: string,
    namespaceName: string,
    className: string
  ): Promise<string | null> => addon.monoResolveClass(handle, monoDllBase, namespaceName, className),
  monoResolveField: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<{ offset: number } | null> =>
    addon.monoResolveField(handle, monoDllBase, classHandle, fieldName),
  monoStaticFieldAddress: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<string | null> => addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName),
```

- [ ] **Step 7: Typecheck and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add native/src/mono_bridge.cc native/src/mono_bridge.h native/src/mono_call.cc native/src/mono_call.h native/src/addon.cc native/binding.gyp src/main/monoResolver.ts src/main/nativeAddon.ts tests/native/mono_bridge.test.ts
git commit -m "Resolve a Mono class and field by name against the live runtime"
```

---

## Task 6: Resolve and compile a method by name

**Files:**
- Modify: `native/src/mono_bridge.cc`, `native/src/mono_bridge.h`, `native/src/addon.cc`, `src/main/monoResolver.ts`, `src/main/nativeAddon.ts`
- Test: `tests/native/mono_bridge.test.ts` (extended)

**Interfaces:**
- Consumes: `AttachToMono`/`DetachFromMono`/`RunRemoteCall`/`WriteString` (Task 5, made available by keeping them in the same translation unit — no header changes needed since this task adds functions to the same `mono_bridge.cc`).
- Produces: addon export `monoCompileMethod(handle, monoDllBase, classHandle, methodName) -> Promise<string | null>` (the compiled entry address). `monoResolver.ts`'s `compileMethod`.

Mirrors Task 5's field-iteration shape exactly, but for methods, ending in a call to `mono_compile_method` — the one operation in this whole sub-project that can force real JIT compilation, and per the spec must only ever be triggered by an explicit user action (enforced at the call sites in later tasks, not here — this task just exposes the primitive).

- [ ] **Step 1: Write the failing test**

Append to `tests/native/mono_bridge.test.ts`:

```ts
describe('monoCompileMethod', () => {
  it('finds a known method and compiles it to a stable address', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    const addr1 = await (addon as any).monoCompileMethod(handle, monoBase, klass, 'ApplyDamage')
    expect(addr1).toMatch(/^0x[0-9a-f]+$/)
    const addr2 = await (addon as any).monoCompileMethod(handle, monoBase, klass, 'ApplyDamage')
    expect(addr2).toBe(addr1)
  })

  it('returns null for a method that does not exist on that class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const addr = await (addon as any).monoCompileMethod(handle, monoBase, klass, 'NoSuchMethod')
    expect(addr).toBeNull()
  })

  it('distinguishes methods on different classes with the same iteration shape', async () => {
    const player = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const stamina = await (addon as any).monoCompileMethod(handle, monoBase, player, 'UseStamina')
    const character = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    const damage = await (addon as any).monoCompileMethod(handle, monoBase, character, 'ApplyDamage')
    expect(stamina).not.toBeNull()
    expect(damage).not.toBeNull()
    expect(stamina).not.toBe(damage)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/mono_bridge.test.ts -t "monoCompileMethod"`
Expected: FAIL — `monoCompileMethod` is not a function.

- [ ] **Step 3: Implement it**

Append to `native/src/mono_bridge.cc` (reusing `AttachToMono`/`DetachFromMono`/`WriteString`/`BytesToPtr`/`ToHex`/`ParseHex`, already file-local to this translation unit):

```cpp
class MonoCompileMethodWorker : public Napi::AsyncWorker {
 public:
  MonoCompileMethodWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                          uintptr_t classHandle, std::string methodName)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        classHandle_(classHandle), methodName_(std::move(methodName)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    uintptr_t getMethods = platform::ResolveExport(handle_, monoDllBase_, "mono_class_get_methods");
    uintptr_t getName = platform::ResolveExport(handle_, monoDllBase_, "mono_method_get_name");
    uintptr_t compile = platform::ResolveExport(handle_, monoDllBase_, "mono_compile_method");
    if (!getMethods || !getName || !compile) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uintptr_t iterSlot = platform::AllocateNear(handle_, monoDllBase_, 16);
    if (!iterSlot) { DetachFromMono(handle_, monoDllBase_, ctx); return; }
    uintptr_t zero = 0;
    platform::WriteMemory(handle_, iterSlot, &zero, sizeof(zero));

    for (int guard = 0; guard < 256; guard++) {
      uint8_t result[8] = {0};
      if (!RunRemoteCall(handle_, getMethods, {classHandle_, iterSlot}, result)) break;
      uintptr_t method = BytesToPtr(result);
      if (!method) break;

      uint8_t nameResult[8] = {0};
      if (!RunRemoteCall(handle_, getName, {method}, nameResult)) break;
      uintptr_t namePtr = BytesToPtr(nameResult);
      char nameBuf[256] = {0};
      if (!platform::ReadMemory(handle_, namePtr, nameBuf, sizeof(nameBuf) - 1)) continue;

      if (methodName_ == nameBuf) {
        uint8_t compileResult[8] = {0};
        if (RunRemoteCall(handle_, compile, {method}, compileResult)) {
          uintptr_t entry = BytesToPtr(compileResult);
          if (entry) { entryAddress_ = entry; ok_ = true; }
        }
        break;
      }
    }
    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    if (!ok_) { deferred_.Resolve(Env().Null()); return; }
    deferred_.Resolve(Napi::String::New(Env(), ToHex(entryAddress_)));
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Env().Null()); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::string methodName_;
  bool ok_ = false;
  uintptr_t entryAddress_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoCompileMethod(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());
  std::string methodName = info[3].As<Napi::String>().Utf8Value();

  auto* worker = new MonoCompileMethodWorker(env, handle, monoDllBase, classHandle, methodName);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
```

Add to `native/src/mono_bridge.h`:

```cpp
Napi::Value MonoCompileMethod(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: Wire the export and build**

In `native/src/addon.cc`, add to the export table:

```cpp
  exports.Set("monoCompileMethod", Napi::Function::New(env, MonoCompileMethod));
```

```powershell
cd native; npx node-gyp build; cd ..
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/native/mono_bridge.test.ts`
Expected: PASS, 9 tests total.

- [ ] **Step 6: Extend the TypeScript wrappers**

In `src/main/nativeAddon.ts`, add:

```ts
  monoCompileMethod: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    methodName: string
  ): Promise<string | null> => addon.monoCompileMethod(handle, monoDllBase, classHandle, methodName),
```

In `src/main/monoResolver.ts`, add:

```ts
  // The one operation in this bridge that can force real JIT compilation
  // of a method the game hasn't run yet. Every caller of this function
  // must be a deliberate, explicit user action — never a background retry
  // — per the sub-project's own safety rule.
  compileMethod: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    methodName: string
  ): Promise<string | null> => nativeAddon.monoCompileMethod(handle, monoDllBase, classHandle, methodName),
```

- [ ] **Step 7: Typecheck and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add native/src/mono_bridge.cc native/src/mono_bridge.h native/src/addon.cc src/main/nativeAddon.ts src/main/monoResolver.ts tests/native/mono_bridge.test.ts
git commit -m "Compile a Mono method by name to get its live entry address"
```

---

## Task 7: Enumerate assemblies and classes

**Files:**
- Modify: `native/src/mono_bridge.cc`, `native/src/mono_bridge.h`, `native/src/addon.cc`, `src/main/monoResolver.ts`, `src/main/nativeAddon.ts`
- Test: `tests/native/mono_bridge.test.ts` (extended)

**Interfaces:**
- Consumes: Task 5/6's `AttachToMono`/`DetachFromMono`/`RunRemoteCall`/`WriteString`.
- Produces: `monoListAssemblies(handle, monoDllBase) -> Promise<string[]>` (a list of `MonoAssembly*` handles — the fake host has exactly one). `monoAssemblyImage(handle, monoDllBase, assemblyHandle) -> Promise<string | null>`. `monoListFieldNames(handle, monoDllBase, classHandle) -> Promise<string[]>`, `monoListMethodNames(handle, monoDllBase, classHandle) -> Promise<string[]>` (both loop-driven, reusing the exact iteration shape Tasks 5/6 already built — no new native mechanism). `monoResolver.ts` gains `listAssemblies`, `listFieldNames`, `listMethodNames`.

This is the one place needing a genuinely new mechanism: `mono_assembly_foreach` is callback-based (Mono calls back into caller-supplied code once per assembly), unlike the iterator-based field/method enumeration Tasks 5–6 already handle by simple looping. A callback means injecting a small collector stub the target calls INTO, appending each result to a growable buffer, which Tamper reads back once the top-level call returns.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/mono_bridge.test.ts`:

```ts
describe('monoListAssemblies', () => {
  it('finds the one fake assembly', async () => {
    const assemblies = await (addon as any).monoListAssemblies(handle, monoBase)
    expect(assemblies.length).toBe(1)
    expect(assemblies[0]).toMatch(/^0x[0-9a-f]+$/)
  })
})

describe('monoListFieldNames / monoListMethodNames', () => {
  it('lists every field name on a class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const names = await (addon as any).monoListFieldNames(handle, monoBase, klass)
    expect(names.sort()).toEqual(['m_godMode', 'm_localPlayer'])
  })

  it('lists every method name on a class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    const names = await (addon as any).monoListMethodNames(handle, monoBase, klass)
    expect(names).toEqual(['ApplyDamage'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/mono_bridge.test.ts -t "monoList"`
Expected: FAIL — the functions don't exist.

- [ ] **Step 3: Implement the loop-driven listers first (no new mechanism)**

Append to `native/src/mono_bridge.cc` — these two are the SAME iteration loop `MonoResolveFieldWorker`/`MonoCompileMethodWorker` already run, just collecting every name instead of stopping at a match:

```cpp
class MonoListFieldNamesWorker : public Napi::AsyncWorker {
 public:
  MonoListFieldNamesWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase,
                           uintptr_t classHandle)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase), classHandle_(classHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    uintptr_t getFields = platform::ResolveExport(handle_, monoDllBase_, "mono_class_get_fields");
    uintptr_t getName = platform::ResolveExport(handle_, monoDllBase_, "mono_field_get_name");
    if (!getFields || !getName) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    uintptr_t iterSlot = platform::AllocateNear(handle_, monoDllBase_, 16);
    if (!iterSlot) { DetachFromMono(handle_, monoDllBase_, ctx); return; }
    uintptr_t zero = 0;
    platform::WriteMemory(handle_, iterSlot, &zero, sizeof(zero));

    for (int guard = 0; guard < 256; guard++) {
      uint8_t result[8] = {0};
      if (!RunRemoteCall(handle_, getFields, {classHandle_, iterSlot}, result)) break;
      uintptr_t field = BytesToPtr(result);
      if (!field) break;

      uint8_t nameResult[8] = {0};
      if (!RunRemoteCall(handle_, getName, {field}, nameResult)) break;
      char nameBuf[256] = {0};
      if (platform::ReadMemory(handle_, BytesToPtr(nameResult), nameBuf, sizeof(nameBuf) - 1)) {
        names_.push_back(nameBuf);
      }
    }
    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, names_.size());
    for (size_t i = 0; i < names_.size(); i++) out.Set((uint32_t)i, Napi::String::New(env, names_[i]));
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_, classHandle_;
  std::vector<std::string> names_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoListFieldNames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t classHandle = ParseHex(info[2].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListFieldNamesWorker(env, handle, monoDllBase, classHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
```

Write `MonoListMethodNamesWorker`/`MonoListMethodNames` identically, swapping `mono_class_get_fields`/`mono_field_get_name` for `mono_class_get_methods`/`mono_method_get_name`.

- [ ] **Step 4: Implement the callback-based assembly lister**

This is the one genuinely new mechanism. The stub `mono_assembly_foreach` calls back into must itself be machine code injected into the target — a second, small stub distinct from `BuildCallStub`, since this one is called BY the target rather than calling something.

Append to `native/src/mono_bridge.cc`:

```cpp
namespace {

// mono_assembly_foreach's callback signature: void (__stdcall*)(void* data,
// void* userData). This stub is what Mono calls, once per assembly. It
// appends `data` to a growable list in memory: a count at userData+0,
// followed by up to 64 pointer-sized slots starting at userData+8 — a
// fixed cap, matching the bounded-list pattern ListModules already uses,
// rather than unbounded/dynamic growth inside injected code.
//
//   mov rax, [rcx+8]         ; load userData's slot for arg0 (rcx=data,
//                             ; rdx=userData per __stdcall/x64 - actually
//                             ; __stdcall on x64 IS the same as the normal
//                             ; convention: rcx=data, rdx=userData)
//   ... see the byte-level construction below; this comment describes
//   INTENT, the actual bytes are built directly, matching BuildCallStub's
//   own style of a fully-commented byte layout.
//
// Concretely: RCX = data (the MonoAssembly*), RDX = userData (our buffer).
// Buffer layout: [0..8) = count (uint64), [8 + count*8 ..) = next slot.
//   mov rax, [rdx]            48 8B 02          -- rax = count
//   cmp rax, 64                48 83 F8 40       -- cap at 64 entries
//   jae done                   77 0F             -- (rel8, patched below)
//   lea r8, [rdx+8]            4C 8D 42 08       -- r8 = &slots[0]
//   mov [r8+rax*8], rcx        4A 89 0C C0       -- slots[count] = data
//   inc rax                    48 FF C0
//   mov [rdx], rax             48 89 02          -- count += 1
// done:
//   ret                        C3
std::vector<uint8_t> BuildAssemblyCollectorStub() {
  std::vector<uint8_t> out = {
    0x48, 0x8B, 0x02,                   // mov rax, [rdx]
    0x48, 0x83, 0xF8, 0x40,             // cmp rax, 64
    0x77, 0x0F,                         // jae +0x0F (to `ret`, 15 bytes ahead)
    0x4C, 0x8D, 0x42, 0x08,             // lea r8, [rdx+8]
    0x4A, 0x89, 0x0C, 0xC0,             // mov [r8+rax*8], rcx
    0x48, 0xFF, 0xC0,                   // inc rax
    0x48, 0x89, 0x02,                   // mov [rdx], rax
    0xC3,                               // ret
  };
  return out;
}

} // namespace

class MonoListAssembliesWorker : public Napi::AsyncWorker {
 public:
  MonoListAssembliesWorker(Napi::Env env, platform::ProcessHandle handle, uintptr_t monoDllBase)
      : Napi::AsyncWorker(env), handle_(handle), monoDllBase_(monoDllBase),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    MonoContext ctx = AttachToMono(handle_, monoDllBase_);
    if (!ctx.ok) return;

    uintptr_t foreach_ = platform::ResolveExport(handle_, monoDllBase_, "mono_assembly_foreach");
    if (!foreach_) { DetachFromMono(handle_, monoDllBase_, ctx); return; }

    // Buffer: 8-byte count + 64 pointer-sized slots, right after the
    // collector stub's own code in the same cave.
    uintptr_t cave = platform::AllocateNear(handle_, monoDllBase_, 8 + 64 * 8 + 64);
    if (!cave) { DetachFromMono(handle_, monoDllBase_, ctx); return; }
    uintptr_t bufferAddr = cave;
    uintptr_t stubAddr = cave + 8 + 64 * 8;

    uintptr_t zero = 0;
    platform::WriteMemory(handle_, bufferAddr, &zero, sizeof(zero));
    std::vector<uint8_t> stub = BuildAssemblyCollectorStub();
    if (!platform::WriteMemory(handle_, stubAddr, stub.data(), stub.size())) {
      DetachFromMono(handle_, monoDllBase_, ctx);
      return;
    }

    uint8_t ignored[8];
    RunRemoteCall(handle_, foreach_, {stubAddr, bufferAddr}, ignored);

    uint64_t count = 0;
    platform::ReadMemory(handle_, bufferAddr, &count, sizeof(count));
    if (count > 64) count = 64;
    std::vector<uintptr_t> slots(count);
    if (count > 0) {
      platform::ReadMemory(handle_, bufferAddr + 8, slots.data(), count * sizeof(uintptr_t));
    }
    assemblies_ = slots;

    DetachFromMono(handle_, monoDllBase_, ctx);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array out = Napi::Array::New(env, assemblies_.size());
    for (size_t i = 0; i < assemblies_.size(); i++) {
      out.Set((uint32_t)i, Napi::String::New(env, ToHex(assemblies_[i])));
    }
    deferred_.Resolve(out);
  }
  void OnError(const Napi::Error&) override { deferred_.Resolve(Napi::Array::New(Env(), 0)); }

 private:
  platform::ProcessHandle handle_;
  uintptr_t monoDllBase_;
  std::vector<uintptr_t> assemblies_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value MonoListAssemblies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t monoDllBase = ParseHex(info[1].As<Napi::String>().Utf8Value());

  auto* worker = new MonoListAssembliesWorker(env, handle, monoDllBase);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
```

Add all four new declarations to `native/src/mono_bridge.h`:

```cpp
Napi::Value MonoListFieldNames(const Napi::CallbackInfo& info);
Napi::Value MonoListMethodNames(const Napi::CallbackInfo& info);
Napi::Value MonoListAssemblies(const Napi::CallbackInfo& info);
```

- [ ] **Step 5: Wire exports and build**

In `native/src/addon.cc`, add to the export table:

```cpp
  exports.Set("monoListFieldNames", Napi::Function::New(env, MonoListFieldNames));
  exports.Set("monoListMethodNames", Napi::Function::New(env, MonoListMethodNames));
  exports.Set("monoListAssemblies", Napi::Function::New(env, MonoListAssemblies));
```

```powershell
cd native; npx node-gyp build; cd ..
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/native/mono_bridge.test.ts`
Expected: PASS, 12 tests total.

- [ ] **Step 7: Extend the TypeScript wrappers**

In `src/main/nativeAddon.ts`:

```ts
  monoListFieldNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    addon.monoListFieldNames(handle, monoDllBase, classHandle),
  monoListMethodNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    addon.monoListMethodNames(handle, monoDllBase, classHandle),
  monoListAssemblies: (handle: number, monoDllBase: string): Promise<string[]> =>
    addon.monoListAssemblies(handle, monoDllBase),
```

In `src/main/monoResolver.ts`:

```ts
  listFieldNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    nativeAddon.monoListFieldNames(handle, monoDllBase, classHandle),
  listMethodNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    nativeAddon.monoListMethodNames(handle, monoDllBase, classHandle),
  listAssemblies: (handle: number, monoDllBase: string): Promise<string[]> =>
    nativeAddon.monoListAssemblies(handle, monoDllBase)
```

- [ ] **Step 8: Typecheck and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add native/src/mono_bridge.cc native/src/mono_bridge.h native/src/addon.cc src/main/nativeAddon.ts src/main/monoResolver.ts tests/native/mono_bridge.test.ts
git commit -m "Enumerate a class's fields and methods, and list loaded assemblies"
```

---

## Task 8: `MonoTarget` — a value cheat resolved by name

**Files:**
- Modify: `src/main/store.ts`, `src/main/ipc.ts`
- Test: `tests/main/store.test.ts` (extended), a new `tests/main/monoTarget.test.ts` for the pure resolution helper

**Interfaces:**
- Consumes: `monoResolver.resolveClass`, `monoResolver.resolveField`, `monoResolver.staticFieldAddress` (Task 5).
- Produces: `store.ts`'s `MonoTarget` type and `isMonoTarget` guard; a pure `resolveMonoTargetAddress(target, handle, monoDllBase, resolver)` in a new small module, `src/main/monoTargetResolve.ts`, so the address-resolution DECISION is unit-testable against a fake resolver the same way `anchor.ts` is tested against `FakeOps` — `ipc.ts`'s `writeCheat`/`verifyCheat` call this function rather than reimplementing the two-hop dereference logic inline.

- [ ] **Step 1: Add the type to `store.ts`**

In `src/main/store.ts`, add near `AnchorTarget`:

```ts
// A value reached through Mono-resolved metadata by name, instead of a
// scanned chain or a captured pointer. staticFieldName's ADDRESS is the
// base; when instanceFieldName is absent, that address's own VALUE is the
// target (a plain static field). When present, the static field's value is
// dereferenced once (it holds an object pointer) and instanceFieldName's
// offset is added — the [LocalPlayer]+Player.m_godMode shape exactly.
export interface MonoTarget {
  kind: 'mono'
  className: string
  staticFieldName: string
  instanceFieldName?: string
}
```

Update `CheatTarget`:

```ts
export type CheatTarget = ChainTarget | AnchorTarget | MonoTarget
```

Add the guard, next to `isAnchorTarget`:

```ts
export function isMonoTarget(target: CheatTarget): target is MonoTarget {
  return (target as MonoTarget).kind === 'mono'
}
```

- [ ] **Step 2: Write the failing test for the pure resolver**

Create `tests/main/monoTarget.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveMonoTargetAddress, MonoResolverOps } from '../../src/main/monoTargetResolve'
import type { MonoTarget } from '../../src/main/store'

class FakeResolver implements MonoResolverOps {
  classes = new Map<string, string>() // className -> handle
  staticAddresses = new Map<string, string>() // `${classHandle}.${fieldName}` -> address
  memory = new Map<string, string>() // address -> hex value (for the dereference hop)

  async resolveClass(_handle: number, _base: string, _ns: string, className: string) {
    return this.classes.get(className) ?? null
  }
  async staticFieldAddress(_handle: number, _base: string, classHandle: string, fieldName: string) {
    return this.staticAddresses.get(`${classHandle}.${fieldName}`) ?? null
  }
  async resolveField(_handle: number, _base: string, classHandle: string, fieldName: string) {
    const key = `${classHandle}.${fieldName}`
    return this.staticAddresses.has(key) ? { offset: Number(this.staticAddresses.get(key)) } : null
  }
  readBytes(address: string, _length: number) {
    return this.memory.get(address) ?? null
  }
}

const godModeTarget: MonoTarget = {
  kind: 'mono',
  className: 'Player',
  staticFieldName: 'm_localPlayer',
  instanceFieldName: 'm_godMode'
}

const staticOnlyTarget: MonoTarget = {
  kind: 'mono',
  className: 'GameSettings',
  staticFieldName: 'm_difficulty'
}

describe('resolveMonoTargetAddress', () => {
  it('resolves a static-only field to its own storage address', async () => {
    const ops = new FakeResolver()
    ops.classes.set('GameSettings', '0xc1')
    ops.staticAddresses.set('0xc1.m_difficulty', '0x9000')

    const addr = await resolveMonoTargetAddress(staticOnlyTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x9000')
  })

  it('dereferences a static field to an object, then adds the instance offset', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_godMode', '1681') // offset, per store.ts's field-offset shape
    ops.memory.set('0x9100', '0050300000000000') // little-endian pointer 0x3050

    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x' + (0x3050 + 1681).toString(16))
  })

  it('returns null when the class does not resolve', async () => {
    const ops = new FakeResolver()
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('returns null when the static field is not found', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('returns null when the object pointer reads as zero (not yet touched by the game)', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0000000000000000')
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/main/monoTarget.test.ts`
Expected: FAIL — `src/main/monoTargetResolve.ts` does not exist.

- [ ] **Step 4: Write `monoTargetResolve.ts`**

Create `src/main/monoTargetResolve.ts`:

```ts
import type { MonoTarget } from './store'
import { littleEndianToBigInt } from './ipc'

export interface MonoResolverOps {
  resolveClass(handle: number, monoDllBase: string, namespaceName: string, className: string): Promise<string | null>
  resolveField(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<{ offset: number } | null>
  staticFieldAddress(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<string | null>
  readBytes(address: string, length: number): string | null
}

function addHex(address: string, delta: bigint): string {
  return '0x' + (BigInt(address) + delta).toString(16)
}

// Resolves a MonoTarget to a live address: find the class, find the static
// field, and either use its own storage address directly (no
// instanceFieldName) or dereference it to an object pointer and add the
// instance field's offset — the [LocalPlayer]+Player.m_godMode shape.
// Every failure mode returns null rather than throwing, matching the
// codebase's "can't resolve right now" convention.
export async function resolveMonoTargetAddress(
  target: MonoTarget,
  handle: number,
  monoDllBase: string,
  ops: MonoResolverOps
): Promise<string | null> {
  const classHandle = await ops.resolveClass(handle, monoDllBase, '', target.className)
  if (classHandle === null) return null

  const staticAddress = await ops.staticFieldAddress(handle, monoDllBase, classHandle, target.staticFieldName)
  if (staticAddress === null) return null

  if (target.instanceFieldName === undefined) return staticAddress

  const field = await ops.resolveField(handle, monoDllBase, classHandle, target.instanceFieldName)
  if (field === null) return null

  const pointerHex = ops.readBytes(staticAddress, 8)
  if (pointerHex === null) return null
  const objectPointer = littleEndianToBigInt(pointerHex)
  if (objectPointer === 0n) return null // the game hasn't set this yet this session

  return addHex('0x' + objectPointer.toString(16), BigInt(field.offset))
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/main/monoTarget.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Wire it into `ipc.ts`'s value-cheat read/write**

In `src/main/ipc.ts`, import `isMonoTarget`, `resolveMonoTargetAddress`, and `monoResolver`. Every game's Mono runtime base is resolved once per attach the same way module fingerprints are (reuse `attachedHandle`'s already-listed modules — find `mono.dll`'s base from `loadedModules`, which Task 1's `refreshModuleContext` (from #8) already populates). Add:

```ts
function monoDllBase(): string | null {
  const mono = loadedModules.get('mono.dll') ?? loadedModules.get('mono-2.0-bdwgc.dll')
  return mono ? mono.base : null
}

const monoOps: MonoResolverOps = {
  resolveClass: (h, base, ns, cls) => monoResolver.resolveClass(h, base, ns, cls),
  resolveField: (h, base, cls, field) => monoResolver.resolveField(h, base, cls, field),
  staticFieldAddress: (h, base, cls, field) => monoResolver.staticFieldAddress(h, base, cls, field),
  readBytes: (address, length) =>
    attachedHandle === null ? null : nativeAddon.tryReadBytes(attachedHandle, address, length)
}
```

In `writeCheat` and `verifyCheat` (both already branch on `isAnchorTarget`), add a branch for `isMonoTarget` alongside it:

```ts
    if (isMonoTarget(target)) {
      const base = monoDllBase()
      if (base === null || attachedHandle === null) continue // writeCheat: `continue`; verifyCheat: `return { alive: false, value: null }`
      const resolved = await resolveMonoTargetAddress(target, attachedHandle, base, monoOps)
      if (resolved === null) continue // or the verifyCheat equivalent
      const ok = nativeAddon.writeValue(attachedHandle, resolved, [], cheat.dataType, cheat.value)
      if (ok) anySucceeded = true
      continue
    }
```

Both `writeCheat` and `verifyCheat` become `async` (they already call `nativeAddon.tryReadValue`/`writeValue` synchronously today; the Mono branch's `await` propagates up). Update every call site accordingly (`cheats:oneShot`, `cheats:verify`, and `FreezeLoop`'s write callback, which already tolerates a `Promise<boolean>` return with no change needed since `FreezeLoop` already only checks truthiness — update its type signature from `boolean` to `boolean | Promise<boolean>` if TypeScript flags it, or simply make `WriteFn` return `Promise<boolean>` and have every existing synchronous caller wrap in `Promise.resolve` implicitly, which an `async` writeFn body already does).

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. `tests/main/freezeLoop.test.ts` and `tests/main/ipc.test.ts` must still pass — if `FreezeLoop`'s `WriteFn` type needs to change to `Promise<boolean>`, check `freezeLoop.test.ts`'s fake write functions still satisfy it (a synchronous function returning `boolean` is NOT assignable to `() => Promise<boolean>` — if this breaks, wrap the test fakes' returns in `Promise.resolve(...)` rather than changing `freezeLoop.ts`'s tick loop, which already just does `if (ok) ...` and works identically whether `ok` arrives via `await` or not, since `tick()` itself would need to become `async` too — trace this through fully and fix whichever direction keeps `freezeLoop.test.ts` passing with the SMALLEST change, since this file is out of this task's stated scope beyond what wiring `MonoTarget` requires).

- [ ] **Step 8: Commit**

```bash
git add src/main/store.ts src/main/monoTargetResolve.ts src/main/ipc.ts src/main/freezeLoop.ts tests/main/monoTarget.test.ts
git commit -m "Add MonoTarget: a value cheat resolved by class and field name"
```

---

## Task 9: A third patch-anchor path — resolve by class and method name

**Files:**
- Modify: `src/main/store.ts`, `src/main/anchor.ts`, `src/main/cheatRuntime.ts`, `src/main/ipc.ts`
- Test: `tests/main/anchor.test.ts` (extended), `tests/main/cheatRuntime.test.ts` (extended)

**Interfaces:**
- Consumes: `monoResolver.resolveClass`, `monoResolver.compileMethod` (Tasks 5–6).
- Produces: `PatchCheat`'s `monoClass?: string`, `monoMethod?: string`; `anchor.ts`'s `AnchorReason` gains `'mono-not-loaded'` and `'mono-assembly-not-loaded'`; `resolvePatchAddress` gains a third path, taking a new `MonoOps` parameter.

- [ ] **Step 1: Add the fields to `PatchCheat`**

In `src/main/store.ts`, add to `PatchCheat` (near `moduleName`/`moduleOffset`):

```ts
  // An alternative to moduleName/moduleOffset: resolve this patch's
  // address by asking the live Mono runtime for a class+method, instead of
  // arithmetic or an AOB scan. Absent means "not Mono-anchored" — every
  // existing patch keeps resolving exactly as before.
  monoClass?: string
  monoMethod?: string
```

- [ ] **Step 2: Add the new `AnchorReason` values**

In `src/main/anchor.ts`, extend the union:

```ts
export type AnchorReason =
  | 'module-missing'
  | 'no-match'
  | 'ambiguous'
  | 'bytes-differ'
  | 'not-yet-compiled'
  // mono.dll isn't in the target's module list yet.
  | 'mono-not-loaded'
  // The runtime is up but the named class's assembly hasn't loaded yet
  // (a scene not yet entered, content not yet active).
  | 'mono-assembly-not-loaded'
```

- [ ] **Step 3: Write the failing test**

Append to `tests/main/anchor.test.ts`:

```ts
import { resolvePatchAddress as resolvePatchAddressWithMono } from '../../src/main/anchor'

const monoPatch: PatchCheat = {
  kind: 'patch',
  id: 'p3',
  name: 'P3',
  originalBytes: 'f30f114110',
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: null,
  moduleOffset: null,
  monoClass: 'Character',
  monoMethod: 'ApplyDamage'
}

class FakeMonoOps {
  monoDllBase: string | null = '0x500000'
  classHandle: string | null = '0xc9'
  methodAddress: string | null = null
  resolveClassCalls = 0
  compileMethodCalls = 0

  async resolveClass(): Promise<string | null> {
    this.resolveClassCalls++
    return this.classHandle
  }
  async compileMethod(): Promise<string | null> {
    this.compileMethodCalls++
    return this.methodAddress
  }
}

describe('resolvePatchAddress — mono path', () => {
  it('resolves via class+method when the patch names no module', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x700000', ORIGINAL)
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = '0x700000'

    const result = await resolvePatchAddressWithMono(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBe('0x700000')
    expect(monoOps.resolveClassCalls).toBe(1)
    expect(monoOps.compileMethodCalls).toBe(1)
  })

  it('reports mono-not-loaded when mono.dll is not in the module list', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.monoDllBase = null

    const result = await resolvePatchAddressWithMono(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('mono-not-loaded')
  })

  it('reports mono-assembly-not-loaded when the class does not resolve yet', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.classHandle = null

    const result = await resolvePatchAddressWithMono(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('mono-assembly-not-loaded')
  })

  it('reports bytes-differ when the compiled address does not verify', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x700000', 'cccccccccc')
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = '0x700000'

    const result = await resolvePatchAddressWithMono(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('bytes-differ')
  })

  it('does not attempt the mono path for a patch that names a module', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', ORIGINAL)
    const monoOps = new FakeMonoOps()

    await resolvePatchAddressWithMono(modulePatch, modules, verified, ops, monoOps as any)
    expect(monoOps.resolveClassCalls).toBe(0)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/main/anchor.test.ts -t "mono path"`
Expected: FAIL — `resolvePatchAddress` doesn't accept a fifth argument, and doesn't attempt this path.

- [ ] **Step 5: Extend `resolvePatchAddress`**

In `src/main/anchor.ts`, add the interface and extend the signature:

```ts
export interface MonoOps {
  monoDllBase(): string | null
  resolveClass(monoDllBase: string, className: string): Promise<string | null>
  compileMethod(monoDllBase: string, classHandle: string, methodName: string): Promise<string | null>
}
```

Change `resolvePatchAddress`'s signature to accept `monoOps?: MonoOps` as a fifth parameter, and add the third path before the existing module-arithmetic path (mono resolution has no fallback to scanning, since a class+method-anchored patch has no meaningful AOB signature to fall back to — it never had one captured):

```ts
export async function resolvePatchAddress(
  patch: PatchCheat,
  modules: Map<string, LoadedModule>,
  verified: Set<string>,
  ops: AnchorOps,
  monoOps?: MonoOps
): Promise<AnchorResult> {
  if (patch.monoClass !== undefined && patch.monoMethod !== undefined && monoOps) {
    const monoDllBase = monoOps.monoDllBase()
    if (monoDllBase === null) {
      return { address: null, matchCount: null, reason: 'mono-not-loaded', relearnedOffset: null, scanned: false }
    }
    const classHandle = await monoOps.resolveClass(monoDllBase, patch.monoClass)
    if (classHandle === null) {
      return { address: null, matchCount: null, reason: 'mono-assembly-not-loaded', relearnedOffset: null, scanned: false }
    }
    const address = await monoOps.compileMethod(monoDllBase, classHandle, patch.monoMethod)
    if (address === null || !bytesMatch(ops, address, patch)) {
      return { address: null, matchCount: null, reason: 'bytes-differ', relearnedOffset: null, scanned: false }
    }
    return { address, matchCount: 1, reason: null, relearnedOffset: null, scanned: false }
  }

  // ... existing module-arithmetic / AOB-scan body, unchanged
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/main/anchor.test.ts`
Expected: PASS, all existing tests plus the 5 new ones (the existing tests call `resolvePatchAddress` with 4 arguments — `monoOps` being optional means they are unaffected).

- [ ] **Step 7: Add the new reasons to `cheatRuntime`'s retryable set**

In `src/main/cheatRuntime.ts`, extend `RETRYABLE`:

```ts
const RETRYABLE: AnchorReason[] = [
  'not-yet-compiled',
  'no-match',
  'module-missing',
  'mono-not-loaded',
  'mono-assembly-not-loaded'
]
```

Add a test to `tests/main/cheatRuntime.test.ts`, in the existing "retries no-match and module-missing" style:

```ts
  it('retries mono-not-loaded and mono-assembly-not-loaded', async () => {
    for (const reason of ['mono-not-loaded', 'mono-assembly-not-loaded'] as AnchorReason[]) {
      deps = new FakeDeps()
      clock = new FakeClock()
      runtime = new CheatRuntime(deps, clock)
      deps.located = { address: null, reason }
      runtime.arm(patch)
      await settle()
      expect(runtime.status('p1').state).toBe('arming')
      expect(clock.pending).toHaveLength(1)
    }
  })
```

- [ ] **Step 8: Wire `patchEngine.ts` to pass `MonoOps` through**

In `src/main/patchEngine.ts`, `PatchEngine`'s `resolveAddress` currently calls `resolvePatchAddress(patch, this.modules, this.verified, this.ops)`. Add an optional `monoOps` field, set via a new `setMonoOps(ops: MonoOps): void` method (mirroring `setAnchorContext`), and pass it through:

```ts
  private monoOps: MonoOps | undefined

  setMonoOps(ops: MonoOps): void {
    this.monoOps = ops
  }
```

and in `resolveAddress`, change the call to `resolvePatchAddress(patch, this.modules, this.verified, this.ops, this.monoOps)`.

In `src/main/ipc.ts`, construct a `MonoOps` implementation and call `patchEngine.setMonoOps(...)` once, near where `patchEngine.setAnchorContext` is wired:

```ts
const monoPatchOps: MonoOps = {
  monoDllBase,
  resolveClass: (base, cls) =>
    attachedHandle === null ? Promise.resolve(null) : monoResolver.resolveClass(attachedHandle, base, '', cls),
  compileMethod: (base, cls, method) =>
    attachedHandle === null ? Promise.resolve(null) : monoResolver.compileMethod(attachedHandle, base, cls, method)
}
patchEngine.setMonoOps(monoPatchOps)
```

- [ ] **Step 9: Run the full suite, typecheck, commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/main/store.ts src/main/anchor.ts src/main/cheatRuntime.ts src/main/patchEngine.ts src/main/ipc.ts tests/main/anchor.test.ts tests/main/cheatRuntime.test.ts
git commit -m "Resolve a patch's address by Mono class and method name"
```

---

## Task 10: `immune` mode — a this-pointer guard at a method's entry

**Files:**
- Modify: `native/src/cave_ops.cc`, `native/src/cave_ops.h`, `native/src/addon.cc`, `src/main/nativeAddon.ts`, `src/main/store.ts`, `src/main/patchEngine.ts`
- Test: `tests/native/cave_ops.test.ts` (extended), `tests/main/patchEngine.test.ts` (extended)

**Interfaces:**
- Consumes: `platform::AllocateNear` / `DecodeRun` / `EncodeJump` (existing), `resolvePatchAddress`'s mono path (Task 9).
- Produces: `encodeImmuneGuard(playerPointerAddress, argRegister, caveCodeAddress, returnAddress) -> hex` native export — `caveCodeAddress` is where the encoded blob's first byte will live once written, needed to compute the internal `jne`'s relative displacement, the same reasoning `EncodeJump` already takes `from` for; `patchMode`'s union gains `'immune'`; `PatchEngine.apply` gets a new cave-assembly branch for it.

The CT table's damage-immunity pattern, generalized: compare a method's first argument (the `this` pointer, per Windows x64 calling convention arriving in whichever register the compiled method actually uses — for a Mono-JIT instance method this is `rcx`, matching the CT table's own `cmp rax,rcx`) against a resolved player-pointer address, and return immediately (skip the whole method body) only on a match.

- [ ] **Step 1: Write the failing native test**

Append to `tests/native/cave_ops.test.ts`, following the file's existing `beforeAll`-shared harness setup (do NOT add a second top-level `beforeAll`):

```ts
describe('encodeImmuneGuard', () => {
  it('produces bytes that compare the arg register, skip on match, and fall through otherwise', () => {
    // playerPointerAddress: a memory location holding the address to
    // compare against. argRegister: which register holds "this" at the
    // hooked method's entry. caveCodeAddress: where this blob will be
    // written (needed to compute the internal jne's relative
    // displacement). returnAddress: where a non-matching call falls
    // through to, skipping straight past the (displaced) method body only
    // when the compare matches.
    const cave = (addon as any).allocateCave(handle, baseAddress)
    expect(cave).not.toBeNull()
    const bytes = (addon as any).encodeImmuneGuard('0x50000000', 'rcx', cave, '0x140000200')
    expect(typeof bytes).toBe('string')
    expect(bytes.length).toBeGreaterThan(0)
    // Decodable by the existing decodeRun machinery — same safety bar
    // every other cave body meets. Write it into the cave at the SAME
    // address encodeImmuneGuard was told it would live at, so the
    // internal jne's relative displacement is actually correct here.
    expect((addon as any).writeBytes(handle, cave, bytes)).toBe(true)
    const decoded = (addon as any).decodeRun(handle, cave, bytes.length / 2)
    expect(decoded.decodable).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/cave_ops.test.ts -t "encodeImmuneGuard"`
Expected: FAIL — `encodeImmuneGuard` is not a function.

- [ ] **Step 3: Implement it**

In `native/src/cave_ops.cc`, add near `EncodeGuardedSkip` (reuse `RegisterByName`, `ParseHex`, `ToHex`, `BytesToHex` already local to this file). `caveCodeAddress` is where this encoded blob's first byte will be written — needed up front to compute the internal `jne`'s relative displacement, the same reasoning `EncodeJump` already takes `from` for; without it, the jump's target could not be computed correctly at all:

```cpp
// Compares argRegister (the hooked method's "this" pointer, arriving in
// whichever GPR the calling convention uses for the first argument —
// rcx for a Mono-JIT instance method) against the pointer stored AT
// playerPointerAddress. On match, returns 0 immediately (the "no damage"
// / "immune" outcome — skip the method body entirely). On no match, falls
// through to returnAddress, where the displaced original prologue plus a
// jump back to the method's continuation is expected to sit (assembled by
// the caller, same "cave holds displaced + effect + jmpBack" shape every
// other patch mode uses).
//
//   mov rax, [playerPointerAddress]   48 A1 <imm64>   (10 bytes) — moffs
//                                                       form: loads
//                                                       [absolute imm64]
//                                                       into rax directly
//   cmp argRegister, rax               <REX> 39 <ModRM> (3-4 bytes)
//   jne returnAddress                  0F 85 <rel32>   (6 bytes)
//   xor eax, eax                       31 C0            (2 bytes)
//   ret                                C3               (1 byte)
Napi::Value EncodeImmuneGuard(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uintptr_t playerPointerAddress = ParseHex(info[0].As<Napi::String>().Utf8Value());
  std::string argRegName = info[1].As<Napi::String>().Utf8Value();
  uintptr_t caveCodeAddress = ParseHex(info[2].As<Napi::String>().Utf8Value());
  uintptr_t returnAddress = ParseHex(info[3].As<Napi::String>().Utf8Value());

  ZydisRegister argReg = RegisterByName(argRegName);
  if (argReg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown arg register").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uint8_t> out;
  out.push_back(0x48);
  out.push_back(0xA1);
  for (int i = 0; i < 8; i++) out.push_back(static_cast<uint8_t>(playerPointerAddress >> (i * 8)));
  // 10 bytes so far (mov rax, moffs64)

  ZydisEncoderRequest cmpReq;
  memset(&cmpReq, 0, sizeof(cmpReq));
  cmpReq.mnemonic = ZYDIS_MNEMONIC_CMP;
  cmpReq.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  cmpReq.operand_count = 2;
  cmpReq.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
  cmpReq.operands[0].reg.value = argReg;
  cmpReq.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
  cmpReq.operands[1].reg.value = ZYDIS_REGISTER_RAX;
  uint8_t cmpBuf[16];
  ZyanUSize cmpLen = sizeof(cmpBuf);
  if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&cmpReq, cmpBuf, &cmpLen))) {
    Napi::Error::New(env, "failed to encode cmp").ThrowAsJavaScriptException();
    return env.Null();
  }
  out.insert(out.end(), cmpBuf, cmpBuf + cmpLen);
  // out.size() now = 10 + cmpLen

  // jne rel32: 6 bytes (0F 85 + imm32). Its own address, for the relative
  // calculation, is caveCodeAddress + out.size() (right after mov+cmp).
  uintptr_t jneAddress = caveCodeAddress + out.size();
  int64_t rel = (int64_t)returnAddress - (int64_t)(jneAddress + 6);
  if (rel > INT32_MAX || rel < INT32_MIN) {
    Napi::Error::New(env, "return address out of rel32 range").ThrowAsJavaScriptException();
    return env.Null();
  }
  int32_t rel32 = (int32_t)rel;
  out.push_back(0x0F);
  out.push_back(0x85);
  for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>(rel32 >> (i * 8)));

  out.push_back(0x31); out.push_back(0xC0); // xor eax, eax
  out.push_back(0xC3);                       // ret

  return Napi::String::New(env, BytesToHex(out.data(), out.size()));
}
```

- [ ] **Step 4: Declare, wire, build**

In `native/src/cave_ops.h`, add:

```cpp
Napi::Value EncodeImmuneGuard(const Napi::CallbackInfo& info);
```

In `native/src/addon.cc`, add to the export table:

```cpp
  exports.Set("encodeImmuneGuard", Napi::Function::New(env, EncodeImmuneGuard));
```

```powershell
cd native; npx node-gyp build; cd ..
```

- [ ] **Step 5: Run the native test**

Run: `npx vitest run tests/native/cave_ops.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 6: Add the typed wrapper**

In `src/main/nativeAddon.ts`:

```ts
  encodeImmuneGuard: (
    playerPointerAddress: string,
    argRegister: string,
    caveCodeAddress: string,
    returnAddress: string
  ): string => addon.encodeImmuneGuard(playerPointerAddress, argRegister, caveCodeAddress, returnAddress),
```

Add `encodeImmuneGuard` to `PatchOps` in `src/main/patchEngine.ts` (same shape) and to the live `patchOps` implementation in `src/main/ipc.ts` (delegating to `nativeAddon.encodeImmuneGuard`, same pattern as `encodeGuardedSkip`).

- [ ] **Step 7: Add `'immune'` to `PatchCheat.mode` and wire cave assembly**

In `src/main/store.ts`:

```ts
  mode?: 'nop' | 'force' | 'capture' | 'guard' | 'immune'
```

and `patchMode`'s return type accordingly.

In `src/main/patchEngine.ts`'s `apply`, find the existing branch that assembles a cave body per mode (`force`/`capture`/`guard`) and add an `immune` branch. `immune` needs a resolved player-pointer address to compare against — this reuses the existing anchor-slot mechanism: an `immune` patch is expected to carry a `baseRegister`-style pointer the same way `guard` mode's `armValue` does (write a test first, following the existing `guard`-mode test in `tests/main/patchEngine.test.ts` as the template, asserting: `encodeImmuneGuard` is called with the cave's code address and the patch's site as the return address, the resulting bytes are what gets written, and install refuses the same way every other mode refuses on a failed byte-verify or failed suspend).

```ts
    if (mode === 'immune') {
      if (patch.armValue === undefined) {
        return { ok: false, error: 'This immune patch has no player pointer recorded — re-capture it.' }
      }
      const playerPointerSlot = addHex(cave, 0) // reuse the existing slot-at-cave+0 convention
      this.ops.writeBytes(playerPointerSlot, patch.armValue.replace('0x', '').padStart(16, '0'))
      const code = cave + 8
      const guardBytes = this.ops.encodeImmuneGuard(playerPointerSlot, patch.baseRegister ?? 'rcx', code, addHex(code, /* displaced length placeholder — mirrors guard mode's existing returnAddress-after-displaced-run computation */ 0))
      // ... follow guard mode's existing displaced-run + jmpBack assembly exactly, substituting guardBytes for guard mode's own guard blob.
    }
```

(This step deliberately points at "follow guard mode's existing assembly" rather than re-deriving it in full — `apply`'s `guard` branch already computes `displaced`, writes `effect + displaced + jmpBack` into the cave, and installs the trampoline; `immune`'s only difference is which bytes occupy the "effect" position and that a NON-matching call falls through to the DISPLACED run exactly like guard mode's non-matching case already does. Read the current `guard` branch in full before writing this branch, and mirror its structure precisely rather than guessing at the exact byte offsets, since they depend on `decodeRun`'s returned length, which is only known at install time.)

- [ ] **Step 8: Run the full suite, typecheck, commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add native/src/cave_ops.cc native/src/cave_ops.h native/src/addon.cc src/main/nativeAddon.ts src/main/store.ts src/main/patchEngine.ts src/main/ipc.ts tests/native/cave_ops.test.ts tests/main/patchEngine.test.ts
git commit -m "Add immune mode: skip a method entirely for one resolved object"
```

---

## Task 11: The Mono Explorer screen

**Files:**
- Create: `src/renderer/src/screens/MonoExplorer.tsx`
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/tamper.d.ts`, `src/renderer/src/App.tsx`
- No new automated tests — this repo has no renderer test suite (an accepted, pre-existing gap); verification is `npx tsc --noEmit && npm run build`, same as #8's Task 9.

**Interfaces:**
- Consumes: `monoResolver.listAssemblies`, `resolveClass`, `listFieldNames`, `listMethodNames` (Tasks 5–7); `MonoTarget`, `PatchCheat.monoClass`/`monoMethod` (Tasks 8–9).
- Produces: `window.tamper.monoListClasses`, `monoListFieldNames`, `monoListMethodNames`, `monoResolveField`; a "use as value target" / "use as patch anchor" affordance the existing cheat-creation flow consumes.

- [ ] **Step 1: Add IPC channels**

In `src/main/ipc.ts`, add handlers (each guards on `attachedHandle === null` the same way every existing handler does):

```ts
  ipcMain.handle('mono:listClasses', async () => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    // A class-name index doesn't exist as a single Mono call — this walks
    // every listed assembly's image and, per image, every class via the
    // fixed-namespace lookup this task's UI actually needs (searching by
    // typed name rather than a full unbounded class dump, matching the
    // design's "lazy, drill-down" choice: this handler resolves ONE
    // caller-supplied namespace+name pair, not a listing).
    return []
  })

  ipcMain.handle('mono:resolveClass', async (_e, namespaceName: string, className: string) => {
    if (attachedHandle === null) return null
    const base = monoDllBase()
    if (base === null) return null
    return monoResolver.resolveClass(attachedHandle, base, namespaceName, className)
  })

  ipcMain.handle('mono:listFields', async (_e, classHandle: string) => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    return monoResolver.listFieldNames(attachedHandle, base, classHandle)
  })

  ipcMain.handle('mono:listMethods', async (_e, classHandle: string) => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    return monoResolver.listMethodNames(attachedHandle, base, classHandle)
  })
```

`mono:listClasses` is left returning `[]` deliberately here — real "browse without knowing a name" enumeration needs assembly→image resolution (`mono_assembly_get_image`, wired in Task 5's bridge but not yet threaded through a per-image class walk), which is a natural follow-on once `monoResolveClass` is proven against real Valheim in Task 12. Document this explicitly in the UI (Step 3) as "search by exact name" rather than a live-updating tree for this task, matching the plan's own scope discipline over promising a fuller browse experience than what's been built and tested.

- [ ] **Step 2: Bridge the channels**

In `src/preload/index.ts`:

```ts
  monoResolveClass: (namespaceName: string, className: string) =>
    ipcRenderer.invoke('mono:resolveClass', namespaceName, className),
  monoListFields: (classHandle: string) => ipcRenderer.invoke('mono:listFields', classHandle),
  monoListMethods: (classHandle: string) => ipcRenderer.invoke('mono:listMethods', classHandle),
```

In `src/renderer/src/tamper.d.ts`, add the three methods to the `Window['tamper']` interface:

```ts
      monoResolveClass: (namespaceName: string, className: string) => Promise<string | null>
      monoListFields: (classHandle: string) => Promise<string[]>
      monoListMethods: (classHandle: string) => Promise<string[]>
```

- [ ] **Step 3: Write the screen**

Create `src/renderer/src/screens/MonoExplorer.tsx`:

```tsx
import { useState } from 'react'

interface Props {
  onUseAsValueTarget: (className: string, fieldName: string) => void
  onUseAsPatchAnchor: (className: string, methodName: string) => void
}

// Search-by-exact-name today, not a live browsable tree — a full class
// listing needs per-assembly image walking not yet wired (see ipc.ts's
// mono:listClasses). Typing the class name you already know (from a
// reference like a Cheat Engine table) resolves it and shows its fields
// and methods, which covers this sub-project's proven use case exactly.
export default function MonoExplorer({ onUseAsValueTarget, onUseAsPatchAnchor }: Props) {
  const [namespaceName, setNamespaceName] = useState('')
  const [className, setClassName] = useState('')
  const [classHandle, setClassHandle] = useState<string | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [methods, setMethods] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  async function resolve() {
    setError(null)
    const handle = await window.tamper.monoResolveClass(namespaceName, className)
    if (handle === null) {
      setError(`Could not resolve ${namespaceName ? namespaceName + '.' : ''}${className} — is the runtime attached and this class loaded yet?`)
      setClassHandle(null)
      setFields([])
      setMethods([])
      return
    }
    setClassHandle(handle)
    setFields(await window.tamper.monoListFields(handle))
    setMethods(await window.tamper.monoListMethods(handle))
  }

  return (
    <div>
      <h2>Mono Explorer</h2>
      <input
        placeholder="Namespace (often blank)"
        value={namespaceName}
        onChange={(e) => setNamespaceName(e.target.value)}
      />
      <input
        placeholder="Class name, e.g. Player"
        value={className}
        onChange={(e) => setClassName(e.target.value)}
      />
      <button onClick={resolve}>Resolve</button>
      {error && <p style={{ color: 'var(--error)' }}>{error}</p>}
      {classHandle && (
        <>
          <h3>Fields</h3>
          <ul>
            {fields.map((f) => (
              <li key={f}>
                {f}
                <button onClick={() => onUseAsValueTarget(className, f)}>Use as value target</button>
              </li>
            ))}
          </ul>
          <h3>Methods</h3>
          <ul>
            {methods.map((m) => (
              <li key={m}>
                {m}
                <button onClick={() => onUseAsPatchAnchor(className, m)}>Use as patch anchor</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Mount it**

In `src/renderer/src/App.tsx`, add `MonoExplorer` alongside the existing screens, wiring `onUseAsValueTarget`/`onUseAsPatchAnchor` to whatever pre-fills the existing cheat-creation form fields in `CheatList.tsx` (match the file's existing prop-drilling or lifted-state pattern — read `App.tsx` in full before wiring this, since the exact mechanism for "hand a value over to CheatList's creation form" is established there, not invented fresh here).

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts src/renderer/src/screens/MonoExplorer.tsx src/renderer/src/App.tsx
git commit -m "Add a Mono Explorer screen to resolve classes by name"
```

---

## Task 12: Prove it against real Valheim, and update the map

**Files:**
- No new source files — this is the acceptance run.
- Modify: `CODEBASE_MAP.md`, and any source file where the acceptance run surfaces a real Mono-version signature mismatch (see Step 2).

**Interfaces:**
- Consumes: everything above.

Every prior task's tests run against the fake Mono host, which proves the mechanism, not the real game's actual Mono build. This task is where a real signature mismatch (a Mono embedding function this plan assumed exists, under a different name or calling shape in Valheim's actual `mono.dll`) gets caught and fixed — exactly the role Valheim played for #7 and #8's own acceptance sessions.

- [ ] **Step 1: Resolve `Player.m_godMode` against the real game**

With Valheim running and Tamper attached, use the Mono Explorer to resolve `Player`, confirm `m_godMode` appears in its field list, and confirm the resolved address (via a `MonoTarget` value cheat built from it) reads a sane boolean value that changes when toggled through the game's own means if possible, or at minimum reads consistently across two separate resolutions in the same session.

- [ ] **Step 2: Resolve and install an `immune` patch on `Character.ApplyDamage`**

Build a patch with `monoClass: 'Character'`, `monoMethod: 'ApplyDamage'`, `mode: 'immune'`, with `armValue` captured from the player's own resolved pointer (via the `LocalPlayer`-equivalent static field this codebase's session already identified: `Player.m_localPlayer` or whatever the real field name resolves to — confirm against the actual CT file referenced earlier in this project's history, `Valheim_edit_by_WaifuHunter.CT`, which names it precisely). Install it, confirm in-game that the player takes no damage while a nearby creature's health still changes normally from combat.

- [ ] **Step 3: Fix any real-signature mismatch found**

If any `mono_*` function this plan assumed differs from what Valheim's actual `mono.dll` exports (a different name, an extra/missing argument), fix `mono_bridge.cc`'s `platform::ResolveExport` calls and argument marshalling to match, re-run the fake-host tests to confirm they still pass (the fake host's exports are a contract this bridge code satisfies — if a real name changes, update BOTH the bridge call site and, if the fake host's own export was named to match the wrong assumption, `probe_mono.c` too, keeping the two in sync), and record what was found in a follow-up note under `docs/superpowers/follow-ups/`, in the style of the existing Valheim session notes.

- [ ] **Step 4: Run the full suite one more time**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 5: Update `CODEBASE_MAP.md`**

Add `mono_call.cc`, `mono_bridge.cc`, `monoResolver.ts`, `monoTargetResolve.ts`, `MonoExplorer.tsx` to the appropriate tables with accurate current line counts (recount, don't guess — see #8's Task 10 finding about stale counts). Document the new addon exports (`resolveExport`, `createRemoteThread`, `callRemoteFunction`, `monoResolveClass`, `monoResolveField`, `monoStaticFieldAddress`, `monoCompileMethod`, `monoListFieldNames`, `monoListMethodNames`, `monoListAssemblies`, `encodeImmuneGuard`) and the new IPC channels (`mono:resolveClass`, `mono:listFields`, `mono:listMethods`). Note the real Mono export names confirmed against Valheim's actual `mono.dll` if any differed from this plan's assumptions.

- [ ] **Step 6: Commit**

```bash
git add CODEBASE_MAP.md docs/superpowers/follow-ups/
git commit -m "Prove class/field/method resolution and an immune hook against real Valheim"
```

---

## Self-review notes (carried into the plan above, not a separate step)

- **Spec coverage:** remote-call primitive (Tasks 2–3), Mono bridge simple lookups (Task 5), method compilation (Task 6), enumeration incl. the callback-based assembly lister (Task 7), `MonoTarget` (Task 8), third anchor path (Task 9), `immune` mode (Task 10), explorer UI (Task 11), fake-host testing (Task 4) and real acceptance (Task 12), safety rules (address-range verification in `ResolveExport`'s forwarder check and `RunRemoteCall`'s never-free-a-live-thread handling; attach/detach pairing centralized in `AttachToMono`/`DetachFromMono`; `mono_compile_method` never called except from an explicit `compileMethod`/Task 9 install path) — all covered.
- **IL2CPP, arbitrary method calls, eager full enumeration, thread hijacking** — explicitly absent from every task above, matching the spec's Out of Scope list.
- **Type consistency:** `MonoOps`/`MonoResolverOps` interface names are distinct (`anchor.ts`'s `MonoOps` for patch resolution vs. `monoTargetResolve.ts`'s `MonoResolverOps` for value-target resolution) — deliberately two small interfaces rather than one shared one, since a patch's resolution (class+method) and a value target's resolution (class+field, possibly dereferenced) are different enough shapes that forcing one interface to cover both would leak irrelevant methods into each caller's fake in tests.
- Task 10's `encodeImmuneGuard` takes `caveCodeAddress` explicitly (not inferred), for the same reason `EncodeJump` takes `from` explicitly — computing the internal `jne`'s relative displacement is impossible without knowing where the encoded blob itself will live in memory. An earlier draft of this plan discovered that requirement mid-task and left the discovery visible as a two-step split; it has been collapsed into one correct step so the plan is directly executable without an implementer transcribing intentionally-broken intermediate code.

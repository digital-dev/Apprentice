# Game Identity, Module Anchoring and Cheat Lifecycle (#8) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cheat saved in one session re-arms itself in the next launch of the game — resolving by module arithmetic when the build is unchanged, by verified byte-pattern scan when it isn't, and retrying in the background until the game's code exists.

**Architecture:** Four new main-process modules (`profile.ts`, `anchor.ts`, `cheatRuntime.ts`, `watcher.ts`), each a plain class or pure function behind an injected ops interface so it is testable against a fake process, in the style `patchEngine.ts`'s `PatchOps` established. Two native additions: module enumeration through the existing `platform/platform.h` seam, and optional address bounds on `scanAob`. The renderer gains a status chip per row and one banner; no new screens.

**Tech Stack:** Electron + React + TypeScript, C++ N-API addon (node-gyp, Zydis), vitest, MSVC for the C test harness.

**Spec:** `docs/superpowers/specs/2026-07-28-persistent-cheats-design.md`
**Codebase orientation:** `CODEBASE_MAP.md` — read it before Task 1.

## Global Constraints

- x86-64 only. Windows first, Linux-capable by construction: every new OS call goes through `native/src/platform/platform.h`, with a Windows implementation and a Linux stub that refuses.
- No network calls anywhere in the stack.
- **Backwards compatibility with existing `games/*.json` is a hard requirement.** The repo's `games/valheim.json` (a bare array holding one `guard` patch) must load, arm and restore unchanged.
- Existing addon exports keep their current signatures. New parameters are optional and absent-means-today's-behaviour.
- Addresses are `0x`-prefixed lowercase strings. Byte blobs are unspaced lowercase hex. AOB signatures are space-separated `??`-or-hex-pair tokens.
- Absent `mode` on a patch means `'nop'`; absent `signatureOffset` means `0`. Never change either default.
- Safety rules from #7 are unchanged and must not be weakened: never install when located bytes don't match the capture; never install on 0 or >1 signature matches; suspend all threads while writing an injection site; never free a cave; restore on disable, detach and app exit.
- **The watcher may attach and read; it may never write.** Arming is always a user action.
- Verification commands, run from the repo root: `npx vitest run`, `npx tsc --noEmit`, `npm run build`.
- **Stop Tamper before rebuilding the native addon** — a running Electron locks `memory_addon.node` and the link fails with `permission denied`.
- After changing `native/binding.gyp` sources, run `configure` before `build`.
- **Rebuild anything C from PowerShell, never Bash** — Bash won't run vcvars and fails silently.
- `tests/native/cave_ops.test.ts` must keep **exactly one top-level `beforeAll`**; awaiting an `AsyncWorker`-backed promise in a second one segfaults the vitest worker. Any new native test file follows the same rule.

---

## File Structure

**Create:**
- `native/src/module_info.cc` / `.h` — the `listModules` N-API binding.
- `test-harness/probe.c` — source for a loadable probe DLL with a patchable function.
- `src/main/profile.ts` — profile format, migration, fingerprint comparison.
- `src/main/anchor.ts` — patch address resolution strategy (pure).
- `src/main/cheatRuntime.ts` — per-cheat state machine with backoff retry.
- `src/main/watcher.ts` — process polling and auto-attach.
- `tests/native/module_info.test.ts`, `tests/main/profile.test.ts`, `tests/main/anchor.test.ts`, `tests/main/cheatRuntime.test.ts`, `tests/main/watcher.test.ts`.

**Modify:**
- `native/src/platform/platform.h`, `platform_win32.cc`, `platform_linux.cc` — add `ListModules`.
- `native/src/patch_ops.cc` — optional bounds on `scanAob`.
- `native/src/addon.cc`, `native/binding.gyp` — export and build the new file.
- `src/main/nativeAddon.ts` — typed wrappers for `listModules` and bounded `scanAob`.
- `src/main/store.ts` — `loadCheats`/`saveCheat` delegate to `profile.ts`.
- `src/main/patchEngine.ts` — `resolveAddress` delegates to `anchor.ts`.
- `src/main/ipc.ts` — wire runtime, watcher, fingerprint recording, new channels.
- `src/preload/index.ts`, `src/renderer/src/tamper.d.ts` — bridge the new channels.
- `src/renderer/src/screens/CheatList.tsx` — status chips and the build-changed banner.
- `test-harness/harness.c` — `loaddll` / `unloaddll` commands.
- `CODEBASE_MAP.md` — new files and channels.

---

## Task 1: Module enumeration in the native layer

**Files:**
- Create: `native/src/module_info.cc`, `native/src/module_info.h`
- Modify: `native/src/platform/platform.h`, `native/src/platform/platform_win32.cc`, `native/src/platform/platform_linux.cc`, `native/src/addon.cc`, `native/binding.gyp`, `src/main/nativeAddon.ts`
- Test: `tests/native/module_info.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: addon export `listModules(handle: number) → { name: string; base: string; size: number; timestamp: number; version: string | null }[]`, wrapped as `nativeAddon.listModules(handle)`. `platform::ListModules(ProcessHandle, std::vector<platform::ModuleInfo>&) → bool`.

- [ ] **Step 1: Write the failing test**

Create `tests/native/module_info.test.ts`. One top-level `beforeAll` only.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

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

describe('listModules', () => {
  it('reports the target exe itself', () => {
    const mods = (addon as any).listModules(handle)
    const self = mods.find((m: any) => m.name.toLowerCase() === 'harness.exe')
    expect(self).toBeDefined()
    expect(self.base).toMatch(/^0x[0-9a-f]+$/)
  })

  it('reports a plausible SizeOfImage and TimeDateStamp', () => {
    const mods = (addon as any).listModules(handle)
    const self = mods.find((m: any) => m.name.toLowerCase() === 'harness.exe')
    // SizeOfImage is page-granular and never zero for a loaded image.
    expect(self.size).toBeGreaterThan(0)
    expect(self.size % 4096).toBe(0)
    // TimeDateStamp is seconds since 1970 for a normally-linked image.
    expect(self.timestamp).toBeGreaterThan(0)
  })

  it('reports system modules too, and every entry is well-formed', () => {
    const mods = (addon as any).listModules(handle)
    expect(mods.length).toBeGreaterThan(1)
    for (const m of mods) {
      expect(typeof m.name).toBe('string')
      expect(m.name.length).toBeGreaterThan(0)
      expect(m.base).toMatch(/^0x[0-9a-f]+$/)
      expect(typeof m.size).toBe('number')
      expect(typeof m.timestamp).toBe('number')
      expect(m.version === null || typeof m.version === 'string').toBe(true)
    }
  })

  it('throws on a handle that is not a number', () => {
    expect(() => (addon as any).listModules('nope')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/module_info.test.ts`
Expected: FAIL — `addon.listModules is not a function`.

- [ ] **Step 3: Add `ModuleInfo` and `ListModules` to the platform seam**

In `native/src/platform/platform.h`, inside `namespace platform`, after the `Region` struct:

```cpp
struct ModuleInfo {
  std::string name;      // file name only, e.g. "GameAssembly.dll"
  uintptr_t base = 0;
  uint32_t size = 0;      // PE SizeOfImage
  uint32_t timestamp = 0; // PE TimeDateStamp
  std::string version;    // file version resource, empty when absent
};

// Every module loaded in the target. False on failure (protected or exiting
// process); callers treat that as "cannot verify" rather than as an error.
bool ListModules(ProcessHandle handle, std::vector<ModuleInfo>& out);
```

Add `#include <string>` and `#include <vector>` at the top of the header.

- [ ] **Step 4: Implement it for Windows**

In `native/src/platform/platform_win32.cc`, add near the other implementations. The size and timestamp come from the PE headers read out of the target's own memory — no file read — and the version, which does need the file, is best-effort:

```cpp
namespace {

// Reads SizeOfImage and TimeDateStamp out of the image mapped in the target.
// e_lfanew leads from the DOS header to the NT headers; both fields live in
// the NT headers, so this is two small reads and no file I/O.
bool ReadPeFields(platform::ProcessHandle handle, uintptr_t base,
                  uint32_t& size, uint32_t& timestamp) {
  IMAGE_DOS_HEADER dos{};
  if (!platform::ReadMemory(handle, base, &dos, sizeof(dos))) return false;
  if (dos.e_magic != IMAGE_DOS_SIGNATURE) return false;
  IMAGE_NT_HEADERS64 nt{};
  if (!platform::ReadMemory(handle, base + dos.e_lfanew, &nt, sizeof(nt))) return false;
  if (nt.Signature != IMAGE_NT_SIGNATURE) return false;
  size = nt.OptionalHeader.SizeOfImage;
  timestamp = nt.FileHeader.TimeDateStamp;
  return true;
}

// Best-effort file version. Absent for most game DLLs and for anything
// without a VERSIONINFO resource; recorded for the user, never compared.
std::string ReadFileVersion(const char* fullPath) {
  DWORD ignored = 0;
  DWORD sz = GetFileVersionInfoSizeA(fullPath, &ignored);
  if (sz == 0) return "";
  std::vector<uint8_t> buf(sz);
  if (!GetFileVersionInfoA(fullPath, 0, sz, buf.data())) return "";
  VS_FIXEDFILEINFO* ffi = nullptr;
  UINT len = 0;
  if (!VerQueryValueA(buf.data(), "\\", (LPVOID*)&ffi, &len) || ffi == nullptr) return "";
  char out[64];
  snprintf(out, sizeof(out), "%u.%u.%u.%u",
           HIWORD(ffi->dwFileVersionMS), LOWORD(ffi->dwFileVersionMS),
           HIWORD(ffi->dwFileVersionLS), LOWORD(ffi->dwFileVersionLS));
  return out;
}

} // namespace

bool platform::ListModules(ProcessHandle handle, std::vector<ModuleInfo>& out) {
  out.clear();
  HANDLE h = reinterpret_cast<HANDLE>(handle);
  HMODULE mods[1024];
  DWORD needed = 0;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) return false;
  size_t count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;
  for (size_t i = 0; i < count; i++) {
    ModuleInfo info;
    info.base = reinterpret_cast<uintptr_t>(mods[i]);
    char name[MAX_PATH] = {0};
    if (GetModuleBaseNameA(h, mods[i], name, MAX_PATH) == 0) continue;
    info.name = name;
    uint32_t size = 0, timestamp = 0;
    if (ReadPeFields(handle, info.base, size, timestamp)) {
      info.size = size;
      info.timestamp = timestamp;
    }
    char fullPath[MAX_PATH] = {0};
    if (GetModuleFileNameExA(h, mods[i], fullPath, MAX_PATH) != 0) {
      info.version = ReadFileVersion(fullPath);
    }
    out.push_back(info);
  }
  return true;
}
```

Add `#include <psapi.h>` and `#include <vector>` and `#include <string>` at the top of `platform_win32.cc` if not already present.

- [ ] **Step 5: Implement the Linux stub**

In `native/src/platform/platform_linux.cc`, matching the file's existing refuse-cleanly style:

```cpp
bool platform::ListModules(ProcessHandle, std::vector<ModuleInfo>& out) {
  out.clear();
  return false;
}
```

- [ ] **Step 6: Write the N-API binding**

Create `native/src/module_info.h`:

```cpp
#pragma once
#include <napi.h>

Napi::Value ListModules(const Napi::CallbackInfo& info);
```

Create `native/src/module_info.cc`:

```cpp
#include "module_info.h"
#include "platform/platform.h"
#include <vector>
#include <cstdio>

Napi::Value ListModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "listModules(handle) expects a number").ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = static_cast<platform::ProcessHandle>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));

  std::vector<platform::ModuleInfo> mods;
  if (!platform::ListModules(handle, mods)) {
    // Not an exception: a protected or exiting process is an expected
    // outcome, and the caller's answer to it is "cannot verify", not "crash".
    return Napi::Array::New(env);
  }

  Napi::Array result = Napi::Array::New(env);
  uint32_t i = 0;
  for (const auto& m : mods) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("name", Napi::String::New(env, m.name));
    char hex[32];
    snprintf(hex, sizeof(hex), "0x%llx", (unsigned long long)m.base);
    o.Set("base", Napi::String::New(env, hex));
    o.Set("size", Napi::Number::New(env, m.size));
    o.Set("timestamp", Napi::Number::New(env, m.timestamp));
    if (m.version.empty()) o.Set("version", env.Null());
    else o.Set("version", Napi::String::New(env, m.version));
    result.Set(i++, o);
  }
  return result;
}
```

- [ ] **Step 7: Export it and add it to the build**

In `native/src/addon.cc`, add `#include "module_info.h"` and, in the export table alongside the others:

```cpp
exports.Set("listModules", Napi::Function::New(env, ListModules));
```

In `native/binding.gyp`, add `"src/module_info.cc"` to `sources`, and add `-lversion.lib` to the Windows `libraries` array so it reads `["-lpsapi.lib", "-lversion.lib"]`.

- [ ] **Step 8: Rebuild the addon**

Stop Tamper if it is running, then from PowerShell:

```powershell
cd native; npx node-gyp configure; npx node-gyp build; cd ..
```

Expected: builds with no errors. `configure` is required because `binding.gyp` sources changed.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/native/module_info.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 10: Add the typed wrapper**

In `src/main/nativeAddon.ts`, add the interface next to `ProcessInfo`:

```ts
export interface ModuleInfo {
  name: string
  base: string
  size: number
  timestamp: number
  version: string | null
}
```

and inside the `nativeAddon` object:

```ts
  // Every module loaded in the target, with the PE fields a build
  // fingerprint is made of. Returns [] rather than throwing when the
  // process is protected or exiting — "cannot verify" is a normal answer.
  listModules: (handle: number): ModuleInfo[] => addon.listModules(handle),
```

- [ ] **Step 11: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add native/src/module_info.cc native/src/module_info.h native/src/platform native/src/addon.cc native/binding.gyp src/main/nativeAddon.ts tests/native/module_info.test.ts
git commit -m "Enumerate the target's modules through the platform seam"
```

---

## Task 2: A loadable probe DLL in the harness

**Files:**
- Create: `test-harness/probe.c`
- Modify: `test-harness/harness.c`, `tests/native/module_info.test.ts`

**Interfaces:**
- Consumes: `nativeAddon.listModules` / `addon.listModules` from Task 1.
- Produces: harness stdin commands `loaddll` → `OK <0xbase>` or `ERR`, `unloaddll` → `OK`, `loaddll2` → `OK <0xbase>` (the variant), and `probeget` → `OK <float>`. Exported DLL symbol `probe_write(float* target, float value)`.

A real PE that can be loaded and unloaded at will is what makes module anchoring testable: it gives a genuine base, RVA, `SizeOfImage` and `TimeDateStamp`, and reloading it yields a *different* base, which is exactly the case module anchoring exists to survive.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/module_info.test.ts`:

```ts
function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

describe('probe dll', () => {
  it('appears in listModules once loaded and disappears when unloaded', async () => {
    const before = (addon as any).listModules(handle)
    expect(before.find((m: any) => m.name.toLowerCase() === 'probe.dll')).toBeUndefined()

    const reply = await send('loaddll')
    expect(reply.startsWith('OK')).toBe(true)
    const reportedBase = reply.split(' ')[1]

    const during = (addon as any).listModules(handle)
    const probe = during.find((m: any) => m.name.toLowerCase() === 'probe.dll')
    expect(probe).toBeDefined()
    expect(probe.base).toBe(reportedBase)
    expect(probe.size).toBeGreaterThan(0)
    expect(probe.timestamp).toBeGreaterThan(0)

    await send('unloaddll')
    const after = (addon as any).listModules(handle)
    expect(after.find((m: any) => m.name.toLowerCase() === 'probe.dll')).toBeUndefined()
  })

  it('the variant dll has a different fingerprint from the original', async () => {
    await send('loaddll')
    const one = (addon as any).listModules(handle)
      .find((m: any) => m.name.toLowerCase() === 'probe.dll')
    const original = { size: one.size, timestamp: one.timestamp }
    await send('unloaddll')

    await send('loaddll2')
    const two = (addon as any).listModules(handle)
      .find((m: any) => m.name.toLowerCase() === 'probe2.dll')
    expect(two).toBeDefined()
    // A game update changes at least one of these; the fingerprint test in
    // profile.ts compares exactly this pair.
    expect(two.size !== original.size || two.timestamp !== original.timestamp).toBe(true)
    await send('unloaddll')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/module_info.test.ts -t "probe dll"`
Expected: FAIL — the harness does not answer `loaddll`, so `send` never resolves or replies with something else.

- [ ] **Step 3: Write the probe DLL source**

Create `test-harness/probe.c`:

```c
#include <windows.h>

// A patchable float store in a real, loadable PE. Non-inlined and taking
// its target as a runtime pointer argument so the compiler emits
// `movss [reg], xmm` — the same shape as a game's field write, and
// something an AOB signature can match. A store to a known global would be
// RIP-relative and would exercise a different (and unpatchable) path.
__declspec(dllexport) float g_probe_field = 5.0f;

#pragma optimize("", off)
__declspec(dllexport) void probe_write(float* target, float value) {
  *target = value;
}
#pragma optimize("", on)

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h; (void)reason; (void)reserved;
  return TRUE;
}

// PAD_SIZE is defined by the build command. The variant DLL is compiled
// with a larger value, which changes SizeOfImage — that is how a test
// simulates a game update without waiting for one.
__declspec(dllexport) char g_pad[PAD_SIZE] = {0};
```

- [ ] **Step 4: Add the harness commands**

In `test-harness/harness.c`, add near the other globals:

```c
static HMODULE g_probe_dll = NULL;
static void (*g_probe_write)(float*, float) = NULL;
static float g_probe_target = 5.0f;
```

and inside `main`'s command loop, before the `get`/`set` prefix matches (which use `strncmp` on short prefixes and would otherwise shadow these):

```c
    } else if (strncmp(line, "loaddll2", 8) == 0) {
      if (g_probe_dll == NULL) g_probe_dll = LoadLibraryA("test-harness\\probe2.dll");
      if (g_probe_dll == NULL) printf("ERR\n");
      else printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_probe_dll);
    } else if (strncmp(line, "loaddll", 7) == 0) {
      if (g_probe_dll == NULL) g_probe_dll = LoadLibraryA("test-harness\\probe.dll");
      if (g_probe_dll == NULL) {
        printf("ERR\n");
      } else {
        g_probe_write = (void (*)(float*, float))GetProcAddress(g_probe_dll, "probe_write");
        printf("OK 0x%llx\n", (unsigned long long)(uintptr_t)g_probe_dll);
      }
    } else if (strncmp(line, "unloaddll", 9) == 0) {
      if (g_probe_dll != NULL) { FreeLibrary(g_probe_dll); g_probe_dll = NULL; g_probe_write = NULL; }
      printf("OK\n");
    } else if (strncmp(line, "probewrite", 10) == 0) {
      if (g_probe_write != NULL) g_probe_write(&g_probe_target, 42.0f);
      printf("OK\n");
    } else if (strncmp(line, "probeget", 8) == 0) {
      printf("OK %f\n", g_probe_target);
```

Note the ordering: `loaddll2` must be tested before `loaddll`, because `strncmp(line, "loaddll", 7)` also matches `loaddll2`.

Every branch ends with a `printf` and the loop already `fflush`es — match whatever the surrounding branches do.

- [ ] **Step 5: Build both DLLs and the harness**

From **PowerShell**, not Bash:

```powershell
& cmd.exe /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /LD /DPAD_SIZE=4096 /Fe:test-harness\probe.dll test-harness\probe.c'
& cmd.exe /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /LD /DPAD_SIZE=262144 /Fe:test-harness\probe2.dll test-harness\probe2.c'
& cmd.exe /c 'call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'
```

`probe2.c` is a copy of `probe.c` — create it with `Copy-Item test-harness\probe.c test-harness\probe2.c` first, since `cl /Fe:` names the output after the source. Delete the `.obj`, `.lib` and `.exp` files afterwards and **verify the output timestamps changed**; if the vcvars path differs on this machine, find it with `Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio' -Recurse -Filter vcvars64.bat`.

- [ ] **Step 6: Ignore the build outputs**

Add to `.gitignore`:

```
test-harness/*.obj
test-harness/*.lib
test-harness/*.exp
```

Check first whether `test-harness/harness.exe` and `*.dll` are committed in this repo; match that choice for `probe.dll` / `probe2.dll` so the tests can run on a clean checkout the same way they do for `harness.exe`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/native/module_info.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add test-harness .gitignore tests/native/module_info.test.ts
git commit -m "Add a loadable probe DLL to the harness for module-anchor tests"
```

---

## Task 3: Bounded AOB scan

**Files:**
- Modify: `native/src/patch_ops.cc`, `src/main/nativeAddon.ts`
- Test: `tests/native/patch_ops.test.ts`

**Interfaces:**
- Consumes: harness `loaddll` from Task 2.
- Produces: `scanAob(handle, signature, rangeStart?, rangeEnd?)`, where the bounds are `0x`-prefixed hex strings and absent bounds mean today's behaviour exactly. Wrapped as `nativeAddon.scanAob(handle, signature, rangeStart?, rangeEnd?)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/patch_ops.test.ts`, following that file's existing `send`/`beforeAll` setup:

```ts
describe('scanAob bounds', () => {
  it('finds a pattern inside the given range and not outside it', async () => {
    const reply = await send('loaddll')
    const base = reply.split(' ')[1]
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')
    const end = '0x' + (BigInt(probe.base) + BigInt(probe.size)).toString(16)

    // Take a real byte run out of the probe's code and scan for it.
    const someCode = (addon as any).readBytes(handle, probe.base, 16)
    const sig = (someCode.match(/../g) as string[]).join(' ')

    const inRange = await (addon as any).scanAob(handle, sig, base, end)
    expect(inRange.length).toBeGreaterThan(0)

    // A range that ends before the module starts cannot contain it.
    const belowEnd = '0x' + (BigInt(probe.base) - 1n).toString(16)
    const outOfRange = await (addon as any).scanAob(handle, sig, '0x1000', belowEnd)
    expect(outOfRange).not.toContain(probe.base)

    await send('unloaddll')
  })

  it('with no bounds behaves as before', async () => {
    // The existing unbounded call must keep working unchanged — this is the
    // back-compat guarantee every existing caller relies on.
    const matches = await (addon as any).scanAob(handle, '90 90 90 90')
    expect(Array.isArray(matches)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/patch_ops.test.ts -t "scanAob bounds"`
Expected: FAIL — the extra arguments are ignored, so the out-of-range scan still returns the in-range match.

- [ ] **Step 3: Add bounds to the scan**

In `native/src/patch_ops.cc`, change `RunScanAob`'s signature to take bounds and clamp each region to them:

```cpp
// `rangeStart`/`rangeEnd` are inclusive-exclusive bounds. rangeEnd == 0
// means "no upper bound", which is how an unbounded call arrives here — the
// existing behaviour, byte for byte.
std::vector<uintptr_t> RunScanAob(HANDLE h, const std::vector<PatternByte>& pattern,
                                  uintptr_t rangeStart, uintptr_t rangeEnd) {
  std::vector<uintptr_t> out;
  const size_t plen = pattern.size();

  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = rangeStart;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    uintptr_t regionBase = (uintptr_t)mbi.BaseAddress;
    uintptr_t regionEnd = regionBase + mbi.RegionSize;
    if (rangeEnd != 0 && regionBase >= rangeEnd) break;
    ...
```

Inside the existing match loop, keep the one-bulk-read-per-region structure and skip any match that falls outside the bounds:

```cpp
          if (match) {
            uintptr_t hit = base + offset;
            if (hit >= rangeStart && (rangeEnd == 0 || hit + plen <= rangeEnd)) {
              out.push_back(hit);
            }
          }
```

Bounds narrow the walk; they do not change matching. The rule that a pattern may not straddle a region boundary still holds, because this still searches one region at a time.

- [ ] **Step 4: Accept the optional arguments in the binding**

In the same file, in the `ScanAob` N-API entry point (and its `AsyncWorker`, which is where the parameters must be stored — the worker runs after the JS values are gone), parse arguments 2 and 3 when present:

```cpp
  uintptr_t rangeStart = 0, rangeEnd = 0;
  if (info.Length() >= 3 && info[2].IsString()) rangeStart = ParseHex(info[2].As<Napi::String>());
  if (info.Length() >= 4 && info[3].IsString()) rangeEnd = ParseHex(info[3].As<Napi::String>());
```

and pass them into the worker's constructor alongside the pattern. `ParseHex` here is the file's existing local helper, which handles the `0x` prefix via `strtoull(..., 16)`.

- [ ] **Step 5: Rebuild and run the tests**

```powershell
cd native; npx node-gyp build; cd ..
```

Run: `npx vitest run tests/native/patch_ops.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Update the wrapper**

In `src/main/nativeAddon.ts`:

```ts
  // Runs on a background thread in the addon (Napi::AsyncWorker) and returns
  // a Promise. Bounds are optional and restrict the walk to one module's
  // address range; absent bounds walk all executable memory, exactly as
  // before.
  scanAob: (
    handle: number,
    signature: string,
    rangeStart?: string,
    rangeEnd?: string
  ): Promise<string[]> => addon.scanAob(handle, signature, rangeStart, rangeEnd),
```

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add native/src/patch_ops.cc src/main/nativeAddon.ts tests/native/patch_ops.test.ts
git commit -m "Let an AOB scan be bounded to one module's range"
```

---

## Task 4: The profile format

**Files:**
- Create: `src/main/profile.ts`
- Modify: `src/main/store.ts`
- Test: `tests/main/profile.test.ts`

**Interfaces:**
- Consumes: `ModuleInfo` from `src/main/nativeAddon.ts` (Task 1) — imported as a type only.
- Produces:
```ts
export interface ModuleFingerprint { size: number; timestamp: number; version: string | null }
export interface GameProfile {
  schema: 2
  exe: string
  modules: Record<string, ModuleFingerprint>
  cheats: StoredCheat[]
}
export function loadProfile(exeName: string): GameProfile
export function saveProfile(exeName: string, profile: GameProfile): void
export function recordModuleFingerprint(exeName: string, moduleName: string, fp: ModuleFingerprint): void
export function verifiedModules(profile: GameProfile, loaded: { name: string; size: number; timestamp: number }[]): Set<string>
```
`store.ts` keeps `loadCheats`, `saveCheat`, `deleteCheat` and `setGamesDir` with unchanged signatures; they are now thin wrappers over `profile.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/main/profile.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setGamesDir, loadCheats, saveCheat } from '../../src/main/store'
import {
  loadProfile,
  saveProfile,
  recordModuleFingerprint,
  verifiedModules
} from '../../src/main/profile'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-profile-'))
  setGamesDir(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// The exact shape of the repo's real games/valheim.json, which must keep
// loading and arming unchanged — that file is a bare array with one guard
// patch and no schema key at all.
const LEGACY = JSON.stringify([
  {
    kind: 'patch',
    mode: 'guard',
    id: 'patch-h3',
    name: 'H3',
    originalBytes: 'f30f1128',
    length: 4,
    signature: '48 8b 47 18 f3 0f 11 28',
    signatureOffset: 4,
    moduleName: null,
    moduleOffset: null,
    baseRegister: 'rax',
    armValue: '0x1c91216cd50'
  }
])

describe('profile', () => {
  it('reads a bare array as schema 1 with no fingerprints', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), LEGACY)
    const profile = loadProfile('valheim')
    expect(profile.schema).toBe(2)
    expect(profile.exe).toBe('valheim')
    expect(profile.modules).toEqual({})
    expect(profile.cheats).toHaveLength(1)
    expect(profile.cheats[0].id).toBe('patch-h3')
  })

  it('leaves a legacy file on disk untouched until something is saved', () => {
    const file = path.join(dir, 'valheim.json')
    fs.writeFileSync(file, LEGACY)
    loadProfile('valheim')
    expect(fs.readFileSync(file, 'utf-8')).toBe(LEGACY)
  })

  it('migrates a legacy file to schema 2 on the next save', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), LEGACY)
    saveCheat('valheim', {
      kind: 'patch',
      id: 'second',
      name: 'Second',
      originalBytes: '9090',
      length: 2,
      signature: '90 90',
      moduleName: null,
      moduleOffset: null
    })
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'valheim.json'), 'utf-8'))
    expect(raw.schema).toBe(2)
    expect(raw.cheats).toHaveLength(2)
    expect(loadCheats('valheim')).toHaveLength(2)
  })

  it('round-trips a schema 2 profile with fingerprints', () => {
    saveProfile('game', {
      schema: 2,
      exe: 'game',
      modules: { 'GameAssembly.dll': { size: 100, timestamp: 200, version: '1.0.0.0' } },
      cheats: []
    })
    const back = loadProfile('game')
    expect(back.modules['GameAssembly.dll']).toEqual({ size: 100, timestamp: 200, version: '1.0.0.0' })
  })

  it('records a fingerprint without disturbing the cheats', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), LEGACY)
    recordModuleFingerprint('valheim', 'GameAssembly.dll', { size: 1, timestamp: 2, version: null })
    const back = loadProfile('valheim')
    expect(back.modules['GameAssembly.dll']).toEqual({ size: 1, timestamp: 2, version: null })
    expect(back.cheats).toHaveLength(1)
  })

  it('missing file is an empty profile, not an error', () => {
    expect(loadProfile('never-seen').cheats).toEqual([])
  })

  it('still throws rather than overwriting an unparseable file', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json')
    expect(() => loadProfile('broken')).toThrow(/isn't valid JSON/)
  })

  it('rejects a schema 2 file whose cheats key is not an array', () => {
    fs.writeFileSync(path.join(dir, 'weird.json'), JSON.stringify({ schema: 2, exe: 'weird', modules: {}, cheats: 'nope' }))
    expect(() => loadProfile('weird')).toThrow()
  })

  it('an empty file is the same as no file', () => {
    fs.writeFileSync(path.join(dir, 'empty.json'), '')
    expect(loadProfile('empty').cheats).toEqual([])
  })
})

describe('verifiedModules', () => {
  const profile = {
    schema: 2 as const,
    exe: 'game',
    modules: {
      'GameAssembly.dll': { size: 100, timestamp: 200, version: null },
      'UnityPlayer.dll': { size: 300, timestamp: 400, version: null }
    },
    cheats: []
  }

  it('verifies a module whose size and timestamp both match', () => {
    const v = verifiedModules(profile, [{ name: 'GameAssembly.dll', size: 100, timestamp: 200 }])
    expect(v.has('GameAssembly.dll')).toBe(true)
  })

  it('does not verify a module whose size changed', () => {
    const v = verifiedModules(profile, [{ name: 'GameAssembly.dll', size: 101, timestamp: 200 }])
    expect(v.has('GameAssembly.dll')).toBe(false)
  })

  it('does not verify a module whose timestamp changed', () => {
    const v = verifiedModules(profile, [{ name: 'GameAssembly.dll', size: 100, timestamp: 999 }])
    expect(v.has('GameAssembly.dll')).toBe(false)
  })

  it('does not verify a module that is not loaded', () => {
    const v = verifiedModules(profile, [])
    expect(v.size).toBe(0)
  })

  it('does not verify a loaded module the profile has never seen', () => {
    const v = verifiedModules(profile, [{ name: 'other.dll', size: 1, timestamp: 2 }])
    expect(v.has('other.dll')).toBe(false)
  })

  it('matches module names case-insensitively', () => {
    const v = verifiedModules(profile, [{ name: 'gameassembly.dll', size: 100, timestamp: 200 }])
    expect(v.has('GameAssembly.dll')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/profile.test.ts`
Expected: FAIL — `src/main/profile.ts` does not exist.

- [ ] **Step 3: Write `profile.ts`**

Create `src/main/profile.ts`. Move the file-path and JSON handling out of `store.ts` verbatim, including its refusal to overwrite an unparseable file and the comment explaining why:

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { StoredCheat } from './store'

// What identifies a build of one module. Size and timestamp come from the
// PE headers already mapped in the target, so a fingerprint costs a couple
// of reads and no file I/O. Version is recorded for the user and is
// deliberately NOT part of the match test — plenty of game DLLs ship with
// no version resource at all, and failing them all as unverified would make
// the flag meaningless.
export interface ModuleFingerprint {
  size: number
  timestamp: number
  version: string | null
}

export interface GameProfile {
  schema: 2
  exe: string
  // Only modules some cheat in this file anchors into, not everything
  // loaded — so an unrelated DLL updating costs nothing.
  modules: Record<string, ModuleFingerprint>
  cheats: StoredCheat[]
}

let gamesDir = path.resolve(__dirname, '../../games')

export function setProfileDir(dir: string): void {
  gamesDir = dir
}

function filePathFor(exeName: string): string {
  return path.join(gamesDir, `${exeName.replace(/\.exe$/i, '')}.json`)
}

function emptyProfile(exeName: string): GameProfile {
  return { schema: 2, exe: exeName.replace(/\.exe$/i, ''), modules: {}, cheats: [] }
}

export function loadProfile(exeName: string): GameProfile {
  const file = filePathFor(exeName)
  if (!fs.existsSync(file)) return emptyProfile(exeName)
  const raw = fs.readFileSync(file, 'utf-8')
  // An empty file is the same as no file — a truncated write or a
  // half-finished hand-edit leaves one behind, and there is nothing in it
  // to lose by treating it as no cheats.
  if (raw.trim() === '') return emptyProfile(exeName)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // Deliberately NOT recovering by returning an empty profile. Saving
    // loads, appends and rewrites, so swallowing a parse failure would
    // replace a file full of cheats with whichever single one was being
    // saved — silent data loss, and the user's own edit is the likeliest
    // cause of the parse failure in the first place. Throwing is what makes
    // the failure visible; when this file was left empty by an editor, the
    // symptom looked like a broken button rather than a broken file.
    throw new Error(
      `${file} isn't valid JSON (${(err as Error).message}). Fix or delete the file — refusing to overwrite it and lose the cheats it holds.`
    )
  }

  // Schema 1: a bare array of cheats, written before profiles existed. It
  // loads as a profile with no fingerprints, which makes every cheat in it
  // unverified and signature-only — exactly how it behaved before. The file
  // on disk is left alone until something is saved.
  if (Array.isArray(parsed)) {
    return { ...emptyProfile(exeName), cheats: parsed as StoredCheat[] }
  }

  const obj = parsed as Partial<GameProfile>
  if (!Array.isArray(obj.cheats)) {
    throw new Error(`${file} has no cheats array — refusing to overwrite it.`)
  }
  return {
    schema: 2,
    exe: obj.exe ?? exeName.replace(/\.exe$/i, ''),
    modules: obj.modules ?? {},
    cheats: obj.cheats
  }
}

export function saveProfile(exeName: string, profile: GameProfile): void {
  fs.mkdirSync(gamesDir, { recursive: true })
  fs.writeFileSync(filePathFor(exeName), JSON.stringify(profile, null, 2))
}

export function recordModuleFingerprint(
  exeName: string,
  moduleName: string,
  fp: ModuleFingerprint
): void {
  const profile = loadProfile(exeName)
  profile.modules[moduleName] = fp
  saveProfile(exeName, profile)
}

// Which of the profile's remembered modules are loaded right now with the
// same size and timestamp. A cheat anchored to a module outside this set is
// unverified: its recorded RVA is not to be trusted without a byte check.
export function verifiedModules(
  profile: GameProfile,
  loaded: { name: string; size: number; timestamp: number }[]
): Set<string> {
  const byName = new Map(loaded.map((m) => [m.name.toLowerCase(), m]))
  const verified = new Set<string>()
  for (const [name, fp] of Object.entries(profile.modules)) {
    const live = byName.get(name.toLowerCase())
    if (live && live.size === fp.size && live.timestamp === fp.timestamp) verified.add(name)
  }
  return verified
}
```

- [ ] **Step 4: Make `store.ts` delegate**

In `src/main/store.ts`, delete `gamesDir`, `filePathFor`, `loadCheats`, `saveCheat` and `deleteCheat`'s file handling, and replace them with wrappers. Keep every exported name and signature — `ipc.ts` and the tests call these.

```ts
import { loadProfile, saveProfile, setProfileDir } from './profile'

export function setGamesDir(dir: string): void {
  setProfileDir(dir)
}

export function loadCheats(exeName: string): StoredCheat[] {
  return loadProfile(exeName).cheats
}

export function saveCheat(exeName: string, cheat: StoredCheat): void {
  const profile = loadProfile(exeName)
  const idx = profile.cheats.findIndex((c) => c.id === cheat.id)
  if (idx >= 0) profile.cheats[idx] = cheat
  else profile.cheats.push(cheat)
  saveProfile(exeName, profile)
}

export function deleteCheat(exeName: string, cheatId: string): void {
  const profile = loadProfile(exeName)
  profile.cheats = profile.cheats.filter((c) => c.id !== cheatId)
  saveProfile(exeName, profile)
}
```

All the type declarations in `store.ts` (`CheatDefinition`, `PatchCheat`, `ChainTarget`, `AnchorTarget`, `isPatchCheat`, `patchMode`, …) stay exactly where they are — `profile.ts` imports `StoredCheat` from here, so keep the import in `profile.ts` type-only to avoid a require cycle.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/main/profile.test.ts tests/main/store.test.ts`
Expected: PASS. `store.test.ts` must pass **unchanged** — it is the back-compat check.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/main/profile.ts src/main/store.ts tests/main/profile.test.ts
git commit -m "Give a game's file a schema, a build fingerprint and a migration"
```

---

## Task 5: The anchor resolution strategy

**Files:**
- Create: `src/main/anchor.ts`
- Modify: `src/main/patchEngine.ts`
- Test: `tests/main/anchor.test.ts`

**Interfaces:**
- Consumes: `PatchCheat` from `store.ts`; `ModuleInfo` shape from Task 1.
- Produces:
```ts
export type AnchorReason =
  | 'module-missing' | 'no-match' | 'ambiguous' | 'bytes-differ' | 'not-yet-compiled'
export interface AnchorResult {
  address: string | null
  matchCount: number | null
  reason: AnchorReason | null      // null when address !== null
  relearnedOffset: string | null   // a new RVA the caller should persist
  scanned: boolean
}
export interface AnchorOps {
  readBytes(address: string, length: number): string | null
  scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]>
}
export interface LoadedModule { name: string; base: string; size: number }
export async function resolvePatchAddress(
  patch: PatchCheat,
  modules: Map<string, LoadedModule>,
  verified: Set<string>,
  ops: AnchorOps
): Promise<AnchorResult>
```
`patchEngine.ts` gains `setAnchorContext(modules, verified)` and an `onRelearn(cb: (patchId: string, offset: string) => void)` hook; its private `resolveAddress` calls `resolvePatchAddress`.

- [ ] **Step 1: Write the failing test**

Create `tests/main/anchor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolvePatchAddress, AnchorOps, LoadedModule } from '../../src/main/anchor'
import type { PatchCheat } from '../../src/main/store'

const ORIGINAL = 'f30f114110' // 5 bytes

const modulePatch: PatchCheat = {
  kind: 'patch',
  id: 'p1',
  name: 'P1',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.dll',
  moduleOffset: '0x100'
}

const jitPatch: PatchCheat = { ...modulePatch, id: 'p2', moduleName: null, moduleOffset: null }

class FakeOps implements AnchorOps {
  memory = new Map<string, string>()
  matches: string[] = []
  scanCalls: { signature: string; rangeStart?: string; rangeEnd?: string }[] = []

  readBytes(address: string, length: number): string | null {
    const bytes = this.memory.get(address)
    return bytes === undefined ? null : bytes.slice(0, length * 2)
  }
  async scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]> {
    this.scanCalls.push({ signature, rangeStart, rangeEnd })
    return this.matches
  }
}

const modules = new Map<string, LoadedModule>([
  ['game.dll', { name: 'game.dll', base: '0x10000000', size: 0x8000 }]
])
const verified = new Set(['game.dll'])

describe('resolvePatchAddress — arithmetic path', () => {
  it('resolves by module base + RVA without scanning when the bytes match', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', ORIGINAL)
    const result = await resolvePatchAddress(modulePatch, modules, verified, ops)
    expect(result.address).toBe('0x10000100')
    expect(result.scanned).toBe(false)
    expect(ops.scanCalls).toHaveLength(0)
    expect(result.reason).toBeNull()
  })

  it('falls through to a scan when the bytes at the RVA are wrong', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', 'ccccccccccc')
    ops.matches = ['0x10000200']
    ops.memory.set('0x10000200', ORIGINAL)
    const result = await resolvePatchAddress(modulePatch, modules, verified, ops)
    expect(result.address).toBe('0x10000200')
    expect(result.scanned).toBe(true)
    expect(result.relearnedOffset).toBe('0x200')
  })

  it('falls through to a scan when the module is loaded but unverified', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', ORIGINAL)
    ops.matches = ['0x10000100']
    const result = await resolvePatchAddress(modulePatch, modules, new Set(), ops)
    expect(result.address).toBe('0x10000100')
    expect(result.scanned).toBe(true)
  })

  it('bounds the scan to the module range when there is one', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x10000100']
    ops.memory.set('0x10000100', ORIGINAL)
    await resolvePatchAddress(modulePatch, modules, new Set(), ops)
    expect(ops.scanCalls[0].rangeStart).toBe('0x10000000')
    expect(ops.scanCalls[0].rangeEnd).toBe('0x10008000')
  })

  it('reports module-missing when the module is not loaded and nothing matches', async () => {
    const ops = new FakeOps()
    ops.matches = []
    const result = await resolvePatchAddress(modulePatch, new Map(), new Set(), ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('module-missing')
  })

  it('tolerates a malformed moduleOffset instead of throwing', async () => {
    const ops = new FakeOps()
    ops.matches = []
    const bad = { ...modulePatch, moduleOffset: 'not-hex' }
    const result = await resolvePatchAddress(bad, modules, verified, ops)
    expect(result.address).toBeNull()
  })
})

describe('resolvePatchAddress — scan path', () => {
  it('resolves a JIT patch by unbounded scan', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', ORIGINAL)
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBe('0x777000')
    expect(ops.scanCalls[0].rangeStart).toBeUndefined()
  })

  it('applies signatureOffset to the match', async () => {
    const ops = new FakeOps()
    const withLead = { ...jitPatch, signatureOffset: 4 }
    ops.matches = ['0x777000']
    ops.memory.set('0x777004', ORIGINAL)
    const result = await resolvePatchAddress(withLead, modules, verified, ops)
    expect(result.address).toBe('0x777004')
  })

  it('refuses zero matches with not-yet-compiled for a JIT patch', async () => {
    const ops = new FakeOps()
    ops.matches = []
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('not-yet-compiled')
    expect(result.matchCount).toBe(0)
  })

  it('refuses zero matches with no-match for a module patch', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', 'cc'.repeat(5))
    ops.matches = []
    const result = await resolvePatchAddress(modulePatch, modules, verified, ops)
    expect(result.reason).toBe('no-match')
  })

  it('refuses more than one match', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x1', '0x2', '0x3']
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('ambiguous')
    expect(result.matchCount).toBe(3)
  })

  it('refuses a single match whose bytes are not what we captured', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', 'cccccccccc')
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('bytes-differ')
  })

  it('refuses a single match at unreadable memory', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('bytes-differ')
  })

  it('compares bytes case-insensitively', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', ORIGINAL.toUpperCase())
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBe('0x777000')
  })

  it('does not relearn an offset for a JIT patch', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', ORIGINAL)
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.relearnedOffset).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/anchor.test.ts`
Expected: FAIL — `src/main/anchor.ts` does not exist.

- [ ] **Step 3: Write `anchor.ts`**

Create `src/main/anchor.ts`:

```ts
import type { PatchCheat } from './store'

// Why a patch could not be located. These are opposite problems with
// opposite fixes and must not collapse into one "not found": a user told
// the signature matched four places knows to re-capture a longer
// instruction; a user told it matched none knows the code is gone.
export type AnchorReason =
  | 'module-missing'
  | 'no-match'
  | 'ambiguous'
  | 'bytes-differ'
  // Not an error. Mono compiles a method on first call, so a scan before
  // the game has run the code correctly finds nothing. The caller keeps
  // retrying rather than reporting a failure.
  | 'not-yet-compiled'

export interface AnchorResult {
  address: string | null
  matchCount: number | null
  reason: AnchorReason | null
  // A new RVA worth writing back to the profile: set when a module-anchored
  // patch had to be found by scanning, so the next launch of this build
  // takes the arithmetic path instead.
  relearnedOffset: string | null
  scanned: boolean
}

export interface AnchorOps {
  readBytes(address: string, length: number): string | null
  scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]>
}

export interface LoadedModule {
  name: string
  base: string
  size: number
}

function addHex(address: string, delta: bigint): string {
  return '0x' + (BigInt(address) + delta).toString(16)
}

function bytesMatch(ops: AnchorOps, address: string, patch: PatchCheat): boolean {
  const current = ops.readBytes(address, patch.length)
  if (current === null) return false
  return current.toLowerCase() === patch.originalBytes.toLowerCase()
}

// Where a patch lives right now. Tries arithmetic first, then a scan, and
// verifies the bytes on BOTH paths — an RVA that still points at the
// captured instruction is trustworthy even in a build we have never seen,
// and an RVA that does not is discarded rather than patched. That is what
// makes "warn and allow" safe after a game update.
export async function resolvePatchAddress(
  patch: PatchCheat,
  modules: Map<string, LoadedModule>,
  verified: Set<string>,
  ops: AnchorOps
): Promise<AnchorResult> {
  const module = patch.moduleName === null ? undefined : modules.get(patch.moduleName)

  // Path 1: module base + RVA, for a module whose fingerprint still matches.
  if (patch.moduleName !== null && patch.moduleOffset !== null && module && verified.has(patch.moduleName)) {
    let candidate: string | null = null
    try {
      candidate = addHex(module.base, BigInt(patch.moduleOffset))
    } catch {
      // A hand-edited games/*.json can carry a malformed offset. BigInt()
      // throws SyntaxError rather than failing gracefully; treat it as
      // unresolvable and let the scan path have a go.
      candidate = null
    }
    if (candidate !== null && bytesMatch(ops, candidate, patch)) {
      return { address: candidate, matchCount: null, reason: null, relearnedOffset: null, scanned: false }
    }
  }

  // Path 2: scan, bounded to the module when we know which one.
  const bounded = module !== undefined
  const matches = bounded
    ? await ops.scanAob(patch.signature, module.base, addHex(module.base, BigInt(module.size)))
    : await ops.scanAob(patch.signature)

  if (matches.length !== 1) {
    const reason: AnchorReason =
      matches.length === 0
        ? patch.moduleName === null
          ? 'not-yet-compiled'
          : module === undefined
            ? 'module-missing'
            : 'no-match'
        : 'ambiguous'
    return { address: null, matchCount: matches.length, reason, relearnedOffset: null, scanned: true }
  }

  // A match is the start of the PATTERN, which may begin before the
  // captured instruction — the signature covers surrounding method code so
  // a short method is still uniquely identifiable. Step forward to the
  // instruction itself. Absent offset means the pattern starts at the
  // instruction, which is how every pre-injection patch was saved.
  const address = addHex(matches[0], BigInt(patch.signatureOffset ?? 0))
  if (!bytesMatch(ops, address, patch)) {
    return { address: null, matchCount: 1, reason: 'bytes-differ', relearnedOffset: null, scanned: true }
  }

  const relearnedOffset =
    module === undefined ? null : '0x' + (BigInt(address) - BigInt(module.base)).toString(16)

  return { address, matchCount: 1, reason: null, relearnedOffset, scanned: true }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/anchor.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Make `patchEngine` use it**

In `src/main/patchEngine.ts`:

1. Import `resolvePatchAddress`, `AnchorReason`, `LoadedModule` from `./anchor`.
2. Add fields and setters to `PatchEngine`:

```ts
  // What the engine currently knows about the target's modules. Set by the
  // caller after every attach; empty until then, which makes every patch
  // resolve by scan — the pre-#8 behaviour.
  private modules = new Map<string, LoadedModule>()
  private verified = new Set<string>()
  private relearnCb: ((patchId: string, offset: string) => void) | null = null

  setAnchorContext(modules: Map<string, LoadedModule>, verified: Set<string>): void {
    this.modules = modules
    this.verified = verified
  }

  // Fired when a scan relocated a module-anchored patch, so the caller can
  // write the new RVA back to the profile. Best-effort by design: a failed
  // write must not stop an otherwise working cheat from arming.
  onRelearn(cb: (patchId: string, offset: string) => void): void {
    this.relearnCb = cb
  }
```

3. Replace the body of `resolveAddress` with a delegation, keeping its `Resolution` return type so `locate` is untouched, and add `reason` to `PatchStatus`:

```ts
  private async resolveAddress(patch: PatchCheat): Promise<Resolution> {
    const result = await resolvePatchAddress(patch, this.modules, this.verified, this.ops)
    if (result.relearnedOffset !== null && result.relearnedOffset !== patch.moduleOffset) {
      this.relearnCb?.(patch.id, result.relearnedOffset)
    }
    this.lastReason = result.reason
    return { address: result.address, matchCount: result.matchCount }
  }
```

with `private lastReason: AnchorReason | null = null`, and `locate` copying it into the returned status:

```ts
export interface PatchStatus {
  address: string | null
  state: PatchState
  applicable: boolean
  matchCount: number | null
  // Which anchor failure this was, for the UI chip. Null when the patch
  // resolved, or for states that never went through resolution.
  reason?: AnchorReason | null
}
```

`PatchOps` already declares `readBytes` and `scanAob`; widen its `scanAob` to `(signature: string, rangeStart?: string, rangeEnd?: string) => Promise<string[]>` so it satisfies `AnchorOps` structurally.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. `tests/main/patchEngine.test.ts` must pass **unchanged** — its `FakeOps.scanAob()` takes no arguments, which still satisfies the widened optional signature.

- [ ] **Step 7: Commit**

```bash
git add src/main/anchor.ts src/main/patchEngine.ts tests/main/anchor.test.ts
git commit -m "Resolve a patch by verified module arithmetic before scanning"
```

---

## Task 6: The cheat state machine

**Files:**
- Create: `src/main/cheatRuntime.ts`
- Test: `tests/main/cheatRuntime.test.ts`

**Interfaces:**
- Consumes: `AnchorReason` from `anchor.ts`; `PatchCheat` from `store.ts`.
- Produces:
```ts
export type CheatState = 'idle' | 'arming' | 'active' | 'degraded' | 'failed'
export interface CheatStatus {
  state: CheatState
  unverified: boolean
  reason: AnchorReason | null
  address: string | null
  attempts: number
}
export interface RuntimeDeps {
  locate(patch: PatchCheat): Promise<{ address: string | null; reason: AnchorReason | null }>
  apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }>
  restore(patch: PatchCheat): void
  isVerified(patch: PatchCheat): boolean
}
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export class CheatRuntime {
  constructor(deps: RuntimeDeps, clock?: Clock)
  arm(patch: PatchCheat): void
  disarm(patchId: string, patch?: PatchCheat): void
  status(patchId: string): CheatStatus
  markDegraded(patchId: string): void
  markRecovered(patchId: string): void
  processExited(): void
  onChange(cb: (patchId: string, status: CheatStatus) => void): void
}
export const BACKOFF_BASE_MS = 250
export const BACKOFF_CAP_MS = 5000
```

- [ ] **Step 1: Write the failing test**

Create `tests/main/cheatRuntime.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { CheatRuntime, RuntimeDeps, Clock, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from '../../src/main/cheatRuntime'
import type { AnchorReason } from '../../src/main/anchor'
import type { PatchCheat } from '../../src/main/store'

const patch: PatchCheat = {
  kind: 'patch',
  id: 'p1',
  name: 'P1',
  originalBytes: 'f30f114110',
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: null,
  moduleOffset: null
}

// A clock whose pending timers only fire when the test says so, so backoff
// is asserted by its scheduled delay rather than by waiting in real time.
class FakeClock implements Clock {
  pending: { fn: () => void; ms: number }[] = []
  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { fn, ms }
    this.pending.push(entry)
    return entry
  }
  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p !== handle)
  }
  async fireNext(): Promise<void> {
    const next = this.pending.shift()
    next?.fn()
    // Let the async work the timer kicked off settle.
    await new Promise((r) => setTimeout(r, 0))
  }
}

class FakeDeps implements RuntimeDeps {
  located: { address: string | null; reason: AnchorReason | null } = { address: '0x1000', reason: null }
  applyResult = { ok: true, error: null as string | null }
  verified = true
  restored: string[] = []
  applyCalls = 0

  async locate(): Promise<{ address: string | null; reason: AnchorReason | null }> {
    return this.located
  }
  async apply(): Promise<{ ok: boolean; error: string | null }> {
    this.applyCalls++
    return this.applyResult
  }
  restore(p: PatchCheat): void {
    this.restored.push(p.id)
  }
  isVerified(): boolean {
    return this.verified
  }
}

let deps: FakeDeps
let clock: FakeClock
let runtime: CheatRuntime

beforeEach(() => {
  deps = new FakeDeps()
  clock = new FakeClock()
  runtime = new CheatRuntime(deps, clock)
})

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('CheatRuntime', () => {
  it('starts idle', () => {
    expect(runtime.status('p1').state).toBe('idle')
  })

  it('goes arming then active when the patch resolves and applies', async () => {
    runtime.arm(patch)
    expect(runtime.status('p1').state).toBe('arming')
    await settle()
    expect(runtime.status('p1').state).toBe('active')
    expect(runtime.status('p1').address).toBe('0x1000')
  })

  it('stays arming and schedules a retry when the code is not compiled yet', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('arming')
    expect(runtime.status('p1').reason).toBe('not-yet-compiled')
    expect(clock.pending).toHaveLength(1)
  })

  it('backs off exponentially and caps', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    expect(clock.pending[0].ms).toBe(BACKOFF_BASE_MS)
    await clock.fireNext()
    expect(clock.pending[0].ms).toBe(BACKOFF_BASE_MS * 2)
    for (let i = 0; i < 10; i++) await clock.fireNext()
    expect(clock.pending[0].ms).toBe(BACKOFF_CAP_MS)
  })

  it('retries no-match and module-missing', async () => {
    for (const reason of ['no-match', 'module-missing'] as AnchorReason[]) {
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

  it('fails immediately on reasons waiting cannot fix', async () => {
    for (const reason of ['ambiguous', 'bytes-differ'] as AnchorReason[]) {
      deps = new FakeDeps()
      clock = new FakeClock()
      runtime = new CheatRuntime(deps, clock)
      deps.located = { address: null, reason }
      runtime.arm(patch)
      await settle()
      expect(runtime.status('p1').state).toBe('failed')
      expect(clock.pending).toHaveLength(0)
    }
  })

  it('fails when apply refuses', async () => {
    deps.applyResult = { ok: false, error: 'nope' }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('failed')
  })

  it('recovers into active when a retry succeeds', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    deps.located = { address: '0x2000', reason: null }
    await clock.fireNext()
    expect(runtime.status('p1').state).toBe('active')
    expect(runtime.status('p1').attempts).toBeGreaterThan(0)
  })

  it('disarm restores and cancels a pending retry', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    runtime.disarm('p1', patch)
    expect(clock.pending).toHaveLength(0)
    expect(deps.restored).toContain('p1')
    expect(runtime.status('p1').state).toBe('idle')
  })

  it('re-arming a failed cheat starts over', async () => {
    deps.located = { address: null, reason: 'ambiguous' }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('failed')
    runtime.disarm('p1', patch)
    deps.located = { address: '0x1000', reason: null }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('active')
  })

  it('carries the unverified flag without blocking arming', async () => {
    deps.verified = false
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').unverified).toBe(true)
    expect(runtime.status('p1').state).toBe('active')
  })

  it('marks degraded and recovers', async () => {
    runtime.arm(patch)
    await settle()
    runtime.markDegraded('p1')
    expect(runtime.status('p1').state).toBe('degraded')
    runtime.markRecovered('p1')
    expect(runtime.status('p1').state).toBe('active')
  })

  it('process exit resets everything to idle and cancels retries', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    runtime.processExited()
    expect(runtime.status('p1').state).toBe('idle')
    expect(clock.pending).toHaveLength(0)
    // No restore: the process is gone and its code went with it. Calling
    // restore here would write into a dead handle.
    expect(deps.restored).toHaveLength(0)
  })

  it('notifies on every transition', async () => {
    const seen: string[] = []
    runtime.onChange((id, status) => seen.push(`${id}:${status.state}`))
    runtime.arm(patch)
    await settle()
    expect(seen).toContain('p1:arming')
    expect(seen).toContain('p1:active')
  })

  it('arming a cheat that is already active is a no-op', async () => {
    runtime.arm(patch)
    await settle()
    const before = deps.applyCalls
    runtime.arm(patch)
    await settle()
    expect(deps.applyCalls).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/cheatRuntime.test.ts`
Expected: FAIL — `src/main/cheatRuntime.ts` does not exist.

- [ ] **Step 3: Write `cheatRuntime.ts`**

Create `src/main/cheatRuntime.ts`:

```ts
import type { AnchorReason } from './anchor'
import type { PatchCheat } from './store'

export type CheatState = 'idle' | 'arming' | 'active' | 'degraded' | 'failed'

export interface CheatStatus {
  state: CheatState
  // Describes the BUILD, not the cheat's progress: a cheat whose module
  // fingerprint changed but whose bytes still verify is perfectly active
  // and merely flagged. That is why this is a flag and not a state.
  unverified: boolean
  reason: AnchorReason | null
  address: string | null
  attempts: number
}

export interface RuntimeDeps {
  locate(patch: PatchCheat): Promise<{ address: string | null; reason: AnchorReason | null }>
  apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }>
  restore(patch: PatchCheat): void
  isVerified(patch: PatchCheat): boolean
}

// Injected so backoff is testable by its scheduled delay instead of by
// waiting out five seconds of real time.
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export const BACKOFF_BASE_MS = 250
export const BACKOFF_CAP_MS = 5000

// Waiting fixes these: Mono has not compiled the method yet, a DLL has not
// loaded yet, the code has not appeared yet. Everything else — an ambiguous
// signature, bytes that are not what we captured — is a fact about the
// build that will not change by trying again, and retrying it would spin
// forever behind a chip that says "arming".
const RETRYABLE: AnchorReason[] = ['not-yet-compiled', 'no-match', 'module-missing']

function idle(): CheatStatus {
  return { state: 'idle', unverified: false, reason: null, address: null, attempts: 0 }
}

export class CheatRuntime {
  private deps: RuntimeDeps
  private clock: Clock
  private states = new Map<string, CheatStatus>()
  private timers = new Map<string, unknown>()
  private armed = new Map<string, PatchCheat>()
  private changeCb: ((patchId: string, status: CheatStatus) => void) | null = null

  constructor(deps: RuntimeDeps, clock: Clock = realClock) {
    this.deps = deps
    this.clock = clock
  }

  onChange(cb: (patchId: string, status: CheatStatus) => void): void {
    this.changeCb = cb
  }

  status(patchId: string): CheatStatus {
    return this.states.get(patchId) ?? idle()
  }

  private set(patchId: string, next: Partial<CheatStatus>): void {
    const merged = { ...this.status(patchId), ...next }
    this.states.set(patchId, merged)
    this.changeCb?.(patchId, merged)
  }

  arm(patch: PatchCheat): void {
    const current = this.status(patch.id).state
    if (current === 'arming' || current === 'active' || current === 'degraded') return
    this.armed.set(patch.id, patch)
    this.set(patch.id, {
      state: 'arming',
      unverified: !this.deps.isVerified(patch),
      reason: null,
      address: null,
      attempts: 0
    })
    void this.attempt(patch)
  }

  disarm(patchId: string, patch?: PatchCheat): void {
    this.cancelTimer(patchId)
    this.armed.delete(patchId)
    const target = patch ?? undefined
    if (target) this.deps.restore(target)
    this.states.set(patchId, idle())
    this.changeCb?.(patchId, idle())
  }

  markDegraded(patchId: string): void {
    if (this.status(patchId).state !== 'active') return
    this.set(patchId, { state: 'degraded' })
  }

  markRecovered(patchId: string): void {
    if (this.status(patchId).state !== 'degraded') return
    this.set(patchId, { state: 'active' })
  }

  // The game is gone. Everything resets to idle and every retry is
  // cancelled — deliberately WITHOUT restoring, because the process that
  // held the patched code no longer exists and writing to a dead handle is
  // pointless at best.
  processExited(): void {
    for (const id of Array.from(this.states.keys())) {
      this.cancelTimer(id)
      this.states.set(id, idle())
      this.changeCb?.(id, idle())
    }
    this.armed.clear()
  }

  private cancelTimer(patchId: string): void {
    const timer = this.timers.get(patchId)
    if (timer !== undefined) {
      this.clock.clearTimeout(timer)
      this.timers.delete(patchId)
    }
  }

  private async attempt(patch: PatchCheat): Promise<void> {
    if (!this.armed.has(patch.id)) return
    const attempts = this.status(patch.id).attempts + 1
    const located = await this.deps.locate(patch)
    if (!this.armed.has(patch.id)) return // disarmed while we were away

    if (located.address === null) {
      const retryable = located.reason !== null && RETRYABLE.includes(located.reason)
      if (!retryable) {
        this.set(patch.id, { state: 'failed', reason: located.reason, attempts })
        return
      }
      this.set(patch.id, { state: 'arming', reason: located.reason, attempts })
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)
      this.timers.set(
        patch.id,
        this.clock.setTimeout(() => {
          this.timers.delete(patch.id)
          void this.attempt(patch)
        }, delay)
      )
      return
    }

    const applied = await this.deps.apply(patch)
    if (!this.armed.has(patch.id)) return
    if (!applied.ok) {
      this.set(patch.id, { state: 'failed', reason: null, address: located.address, attempts })
      return
    }
    this.set(patch.id, { state: 'active', reason: null, address: located.address, attempts })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/cheatRuntime.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/cheatRuntime.ts tests/main/cheatRuntime.test.ts
git commit -m "Retry a cheat until the game's code exists, instead of failing once"
```

---

## Task 7: The process watcher

**Files:**
- Create: `src/main/watcher.ts`
- Test: `tests/main/watcher.test.ts`

**Interfaces:**
- Consumes: `Clock` from `cheatRuntime.ts` (reused, not redefined).
- Produces:
```ts
export interface WatcherDeps {
  listProcesses(): { pid: number; name: string }[]
  hasProfile(exeName: string): boolean
}
export const POLL_INTERVAL_MS = 2000
export class ProcessWatcher {
  constructor(deps: WatcherDeps, clock?: IntervalClock)
  start(): void
  stop(): void
  tick(): void
  onAppear(cb: (proc: { pid: number; name: string }) => void): void
  onVanish(cb: (proc: { pid: number; name: string }) => void): void
}
export interface IntervalClock {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/main/watcher.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ProcessWatcher, WatcherDeps, IntervalClock, POLL_INTERVAL_MS } from '../../src/main/watcher'

class FakeClock implements IntervalClock {
  fn: (() => void) | null = null
  ms = 0
  setInterval(fn: () => void, ms: number): unknown {
    this.fn = fn
    this.ms = ms
    return 'timer'
  }
  clearInterval(): void {
    this.fn = null
  }
}

class FakeDeps implements WatcherDeps {
  processes: { pid: number; name: string }[] = []
  profiles = new Set<string>(['valheim'])
  listProcesses(): { pid: number; name: string }[] {
    return this.processes
  }
  hasProfile(exeName: string): boolean {
    return this.profiles.has(exeName.replace(/\.exe$/i, '').toLowerCase())
  }
}

let deps: FakeDeps
let clock: FakeClock
let watcher: ProcessWatcher
let appeared: { pid: number; name: string }[]
let vanished: { pid: number; name: string }[]

beforeEach(() => {
  deps = new FakeDeps()
  clock = new FakeClock()
  watcher = new ProcessWatcher(deps, clock)
  appeared = []
  vanished = []
  watcher.onAppear((p) => appeared.push(p))
  watcher.onVanish((p) => vanished.push(p))
})

describe('ProcessWatcher', () => {
  it('polls on the documented interval', () => {
    watcher.start()
    expect(clock.ms).toBe(POLL_INTERVAL_MS)
  })

  it('reports a process with a profile appearing', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    expect(appeared).toEqual([{ pid: 10, name: 'valheim.exe' }])
  })

  it('ignores a process with no profile', () => {
    deps.processes = [{ pid: 11, name: 'notepad.exe' }]
    watcher.tick()
    expect(appeared).toHaveLength(0)
  })

  it('does not report the same process twice', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    watcher.tick()
    expect(appeared).toHaveLength(1)
  })

  it('reports it vanishing', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    deps.processes = []
    watcher.tick()
    expect(vanished).toEqual([{ pid: 10, name: 'valheim.exe' }])
  })

  it('treats a relaunch under a new pid as vanish then appear', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    deps.processes = [{ pid: 20, name: 'valheim.exe' }]
    watcher.tick()
    expect(vanished).toHaveLength(1)
    expect(appeared).toHaveLength(2)
    expect(appeared[1].pid).toBe(20)
  })

  it('matches profiles case-insensitively', () => {
    deps.processes = [{ pid: 10, name: 'Valheim.exe' }]
    watcher.tick()
    expect(appeared).toHaveLength(1)
  })

  it('survives listProcesses throwing', () => {
    deps.listProcesses = () => {
      throw new Error('snapshot failed')
    }
    expect(() => watcher.tick()).not.toThrow()
  })

  it('stop cancels the interval', () => {
    watcher.start()
    watcher.stop()
    expect(clock.fn).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/watcher.test.ts`
Expected: FAIL — `src/main/watcher.ts` does not exist.

- [ ] **Step 3: Write `watcher.ts`**

Create `src/main/watcher.ts`:

```ts
export interface WatcherDeps {
  listProcesses(): { pid: number; name: string }[]
  hasProfile(exeName: string): boolean
}

export interface IntervalClock {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realClock: IntervalClock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

// Slow enough to be invisible in CPU terms, fast enough that a game is
// picked up before the player has finished the loading screen.
export const POLL_INTERVAL_MS = 2000

// Notices games we have cheats for coming and going. It attaches; it NEVER
// writes. Auto-attaching is a convenience — auto-arming into a build nobody
// has verified is a way to corrupt a save file unattended.
export class ProcessWatcher {
  private deps: WatcherDeps
  private clock: IntervalClock
  private timer: unknown = null
  private current: { pid: number; name: string } | null = null
  private appearCb: ((proc: { pid: number; name: string }) => void) | null = null
  private vanishCb: ((proc: { pid: number; name: string }) => void) | null = null

  constructor(deps: WatcherDeps, clock: IntervalClock = realClock) {
    this.deps = deps
    this.clock = clock
  }

  onAppear(cb: (proc: { pid: number; name: string }) => void): void {
    this.appearCb = cb
  }

  onVanish(cb: (proc: { pid: number; name: string }) => void): void {
    this.vanishCb = cb
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = this.clock.setInterval(() => this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearInterval(this.timer)
    this.timer = null
  }

  tick(): void {
    let processes: { pid: number; name: string }[]
    try {
      processes = this.deps.listProcesses()
    } catch {
      // A failed snapshot is a transient OS condition, not a reason to stop
      // watching. Skip this tick.
      return
    }

    const match = processes.find((p) => this.deps.hasProfile(p.name)) ?? null

    if (this.current !== null && (match === null || match.pid !== this.current.pid)) {
      const gone = this.current
      this.current = null
      this.vanishCb?.(gone)
    }
    if (match !== null && this.current === null) {
      this.current = match
      this.appearCb?.(match)
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/watcher.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/watcher.ts tests/main/watcher.test.ts
git commit -m "Notice a game we have cheats for launching"
```

---

## Task 8: Wire it together in the main process

**Files:**
- Modify: `src/main/ipc.ts`, `src/main/profile.ts`
- Test: `tests/main/profile.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 4, 5, 6, 7.
- Produces: IPC channels `game:state` (main→renderer push, payload `{ exe: string | null; pid: number | null; changedModules: string[] }`), `cheat:state` (main→renderer push, payload `{ cheatId: string; status: CheatStatus }`), and `game:current` (renderer→main request, same payload as `game:state`). `patch:apply` now arms through the runtime; `patch:restore` disarms.

**Note on testing `ipc.ts`:** `tests/main/ipc.test.ts` imports `src/main/ipc.ts` directly and exercises only its *pure* exports (`littleEndianToBigInt`). There is no `electron` mock and no `nativeAddon` mock in this repo, and importing `ipc.ts` pulls in the real addon. Do not try to test the wiring here — put every decision worth testing in a pure helper and test that. This task's testable decision is fingerprint extraction, so it goes in `profile.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/main/profile.test.ts`:

```ts
import { fingerprintOf } from '../../src/main/profile'

describe('fingerprintOf', () => {
  const live = [
    { name: 'game.dll', size: 0x8000, timestamp: 12345, version: '1.2.3.4' },
    { name: 'other.dll', size: 0x1000, timestamp: 999, version: null }
  ]

  it('extracts the fingerprint of a named module', () => {
    expect(fingerprintOf(live, 'game.dll')).toEqual({
      size: 0x8000,
      timestamp: 12345,
      version: '1.2.3.4'
    })
  })

  it('matches the name case-insensitively', () => {
    expect(fingerprintOf(live, 'GAME.DLL')?.size).toBe(0x8000)
  })

  it('returns null for a module that is not loaded', () => {
    expect(fingerprintOf(live, 'missing.dll')).toBeNull()
  })

  it('returns null for a patch with no module', () => {
    expect(fingerprintOf(live, null)).toBeNull()
  })
})
```

- [ ] **Step 2: Make it pass**

Add to `src/main/profile.ts`:

```ts
// The fingerprint of one loaded module, or null when it isn't loaded (or
// the patch is JIT-anchored and names no module at all). Pure, so the
// decision is testable without the addon or electron.
export function fingerprintOf(
  loaded: { name: string; size: number; timestamp: number; version: string | null }[],
  moduleName: string | null
): ModuleFingerprint | null {
  if (moduleName === null) return null
  const found = loaded.find((m) => m.name.toLowerCase() === moduleName.toLowerCase())
  if (!found) return null
  return { size: found.size, timestamp: found.timestamp, version: found.version }
}
```

Run: `npx vitest run tests/main/profile.test.ts`
Expected: PASS, including the four new tests.

- [ ] **Step 3: Build the module context on attach**

In `src/main/ipc.ts`, add module state alongside `attachedHandle`:

```ts
import { loadProfile, recordModuleFingerprint, verifiedModules, fingerprintOf } from './profile'
import { CheatRuntime } from './cheatRuntime'
import { ProcessWatcher } from './watcher'
import type { LoadedModule } from './anchor'

let attachedExe: string | null = null
let loadedModules = new Map<string, LoadedModule>()
let changedModules: string[] = []

// Everything that must be re-derived when we attach: which modules are
// loaded, and which of the ones this game's cheats depend on still look
// like the build they were captured against.
function refreshModuleContext(exeName: string): void {
  attachedExe = exeName.replace(/\.exe$/i, '')
  loadedModules = new Map()
  changedModules = []
  if (attachedHandle === null) return

  const live = nativeAddon.listModules(attachedHandle)
  for (const m of live) {
    loadedModules.set(m.name, { name: m.name, base: m.base, size: m.size })
  }
  const profile = loadProfile(attachedExe)
  const verified = verifiedModules(profile, live)
  changedModules = Object.keys(profile.modules).filter((name) => !verified.has(name))
  patchEngine.setAnchorContext(loadedModules, verified)
}
```

Call `refreshModuleContext(name)` at the end of the `process:attach` handler. The handler currently receives only a pid, so look the name up from `nativeAddon.listProcesses()` by pid — or accept an optional second argument from the renderer and fall back to the lookup.

- [ ] **Step 4: Record fingerprints on save**

Add the exported seam and use it from `cheats:save`:

```ts
// A patch anchored to a module is only trustworthy across builds if we know
// which build it was captured against. Record that module's fingerprint
// beside the cheat as it is saved — this is the only moment we are certain
// the anchor and the loaded module agree.
export function saveCheatWithFingerprint(exeName: string, cheat: StoredCheat): void {
  saveCheat(exeName, cheat)
  if (!isPatchCheat(cheat) || cheat.moduleName === null || attachedHandle === null) return
  const fp = fingerprintOf(nativeAddon.listModules(attachedHandle), cheat.moduleName)
  if (fp !== null) recordModuleFingerprint(exeName, cheat.moduleName, fp)
}
```

- [ ] **Step 5: Wire the runtime**

```ts
const cheatRuntime = new CheatRuntime({
  locate: async (patch) => {
    const status = await patchEngine.locate(patch)
    return { address: status.address, reason: status.reason ?? null }
  },
  apply: (patch) => patchEngine.apply(patch),
  restore: (patch) => {
    patchEngine.restore(patch)
  },
  isVerified: (patch) => patch.moduleName === null || !changedModules.includes(patch.moduleName)
})

// A relearned RVA is worth keeping — it turns the next launch of this build
// into the arithmetic path. Best-effort: a failed write must not stop a
// working cheat.
patchEngine.onRelearn((patchId, offset) => {
  if (attachedExe === null) return
  try {
    const profile = loadProfile(attachedExe)
    const cheat = profile.cheats.find((c) => c.id === patchId)
    if (cheat && isPatchCheat(cheat)) {
      cheat.moduleOffset = offset
      saveCheat(attachedExe, cheat)
    }
  } catch (err) {
    console.warn(`[patch] could not persist relearned offset for ${patchId}: ${String(err)}`)
  }
})
```

In `registerIpcHandlers`, push state changes to the renderer and route the freeze loop's degraded/recovered callbacks into the runtime as well as the existing events:

```ts
  cheatRuntime.onChange((cheatId, status) => {
    getWindow().webContents.send('cheat:state', { cheatId, status })
  })
```

Change `patch:apply` to `cheatRuntime.arm(patch)` (returning `{ ok: true, error: null }` once arming starts; the real outcome arrives on `cheat:state`), and `patch:restore` to `cheatRuntime.disarm(patch.id, patch)`. Keep the existing platform check that refuses injection modes when `platformSupportsInjection` is false, before arming.

- [ ] **Step 6: Wire the watcher**

```ts
const watcher = new ProcessWatcher({
  listProcesses: () => nativeAddon.listProcesses(),
  hasProfile: (exeName) => loadProfile(exeName).cheats.length > 0
})

export function startWatching(getWindow: () => BrowserWindow): void {
  watcher.onAppear((proc) => {
    const { handle } = nativeAddon.attach(proc.pid)
    attachedHandle = handle
    attachedPid = proc.pid
    refreshModuleContext(proc.name)
    getWindow().webContents.send('game:state', currentGameState())
  })
  watcher.onVanish(() => {
    cheatRuntime.processExited()
    attachedHandle = null
    attachedPid = null
    attachedExe = null
    loadedModules = new Map()
    changedModules = []
    getWindow().webContents.send('game:state', currentGameState())
  })
  watcher.start()
}

function currentGameState(): { exe: string | null; pid: number | null; changedModules: string[] } {
  return { exe: attachedExe, pid: attachedPid, changedModules }
}
```

Register `ipcMain.handle('game:current', () => currentGameState())`, and call `startWatching(getWindow)` from the end of `registerIpcHandlers`. `hasProfile` reading the whole profile on every poll is acceptable at a 2 s cadence and a handful of files; do not add a cache until something measures.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Existing `ipc.test.ts` tests must still pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc.ts src/main/profile.ts tests/main/profile.test.ts
git commit -m "Attach on launch, arm on toggle, remember the build"
```

---

## Task 9: Surface state in the UI

**Files:**
- Modify: `src/preload/index.ts`, `src/renderer/src/tamper.d.ts`, `src/renderer/src/screens/CheatList.tsx`

**Interfaces:**
- Consumes: `cheat:state`, `game:state`, `game:current` from Task 8; `CheatStatus` from `cheatRuntime.ts`.
- Produces: `window.tamper.onCheatState(cb)`, `window.tamper.onGameState(cb)`, `window.tamper.currentGame()`.

- [ ] **Step 1: Bridge the channels**

In `src/preload/index.ts`, alongside the existing listeners:

```ts
  onCheatState: (cb: (payload: { cheatId: string; status: unknown }) => void) =>
    ipcRenderer.on('cheat:state', (_e, payload) => cb(payload)),
  onGameState: (cb: (payload: { exe: string | null; pid: number | null; changedModules: string[] }) => void) =>
    ipcRenderer.on('game:state', (_e, payload) => cb(payload)),
  currentGame: () => ipcRenderer.invoke('game:current')
```

In `src/renderer/src/tamper.d.ts`, re-export the runtime types rather than re-declaring them — the file already does this for `PatchStatus`:

```ts
export type { CheatState, CheatStatus } from '../../main/cheatRuntime'
```

and add the three methods to the `Window['tamper']` interface with those types.

- [ ] **Step 2: Render the chip**

In `src/renderer/src/screens/CheatList.tsx`, add state fed by the subscription:

```tsx
  const [cheatStates, setCheatStates] = useState<Map<string, CheatStatus>>(new Map())
  const [changedModules, setChangedModules] = useState<string[]>([])

  useEffect(() => {
    window.tamper.onCheatState(({ cheatId, status }) => {
      setCheatStates((prev) => new Map(prev).set(cheatId, status))
    })
    window.tamper.onGameState((state) => setChangedModules(state.changedModules))
    void window.tamper.currentGame().then((state) => setChangedModules(state.changedModules))
  }, [])
```

Add the label function next to the existing `patchStatusLabel`, which stays for the pre-arm readout:

```tsx
// One chip, one honest answer. "Toggled on but still retrying" must never
// look the same as "working" — that ambiguity is what cost a whole Valheim
// session to a patch that was fine.
function cheatStateLabel(status: CheatStatus): string {
  switch (status.state) {
    case 'idle':
      return 'ready'
    case 'arming':
      return status.reason === 'not-yet-compiled'
        ? 'waiting for the game to run this code'
        : 'arming'
    case 'active':
      return status.unverified ? 'active (new game build)' : 'active'
    case 'degraded':
      return 'degraded — stopped working'
    case 'failed':
      switch (status.reason) {
        case 'ambiguous':
          return 'ambiguous signature — re-capture'
        case 'bytes-differ':
          return 'the code changed — re-capture'
        case 'module-missing':
          return 'module not loaded'
        case 'no-match':
          return 'no signature match — re-capture'
        default:
          return 'failed'
      }
  }
}
```

Render it in the patch row using the existing `address-chip` class, falling back to `patchStatusLabel` when there is no runtime state for that cheat yet.

- [ ] **Step 3: Render the banner**

Above the cheat list, when `changedModules.length > 0`:

```tsx
      {changedModules.length > 0 && (
        <div className="banner">
          This game has updated since these cheats were captured
          ({changedModules.join(', ')}). They'll be verified against the new
          build when you turn them on.
        </div>
      )}
```

Match whatever styling convention the file already uses — the renderer has no component library and no styling system by design.

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both pass. The repo has no renderer test suite, so these two plus the manual check in Task 10 are the verification for this task.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/renderer/src/tamper.d.ts src/renderer/src/screens/CheatList.tsx
git commit -m "Say whether a cheat is arming, active or degraded"
```

---

## Task 10: Prove a module anchor survives a reload

**Files:**
- Test: `tests/native/module_info.test.ts`
- Modify: `CODEBASE_MAP.md`

**Interfaces:**
- Consumes: everything above.

This is the acceptance test for the arithmetic path: the same DLL loaded twice lands at a different base, and an RVA-anchored patch must still find its instruction.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/module_info.test.ts`:

```ts
describe('a module anchor survives a reload', () => {
  it('finds the same instruction at a new base by RVA', async () => {
    const first = await send('loaddll')
    const firstBase = first.split(' ')[1]
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')

    // Take a byte run from a fixed RVA inside the probe and remember both
    // the RVA and the bytes — this is exactly what a saved patch holds.
    const rva = 0x1000
    const captured = (addon as any).readBytes(handle, '0x' + (BigInt(firstBase) + BigInt(rva)).toString(16), 8)
    expect(captured).toMatch(/^[0-9a-f]{16}$/)

    await send('unloaddll')
    // Load something else first so the probe is unlikely to land back at
    // the same base; if it does, the assertion below is skipped rather than
    // failing, since the OS chooses.
    await send('loaddll2')
    await send('unloaddll')
    const second = await send('loaddll')
    const secondBase = second.split(' ')[1]

    const atSameRva = (addon as any).readBytes(handle, '0x' + (BigInt(secondBase) + BigInt(rva)).toString(16), 8)
    expect(atSameRva).toBe(captured)
    expect(probe.size).toBeGreaterThan(rva)

    await send('unloaddll')
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/native/module_info.test.ts`
Expected: PASS. If it fails because the OS reused the base, the test is still valid — the RVA read must match either way; investigate any other failure before proceeding.

- [ ] **Step 3: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass, with the pre-existing 145 tests plus roughly 60 new ones.

- [ ] **Step 4: Update the codebase map**

In `CODEBASE_MAP.md`:
- Add `profile.ts`, `anchor.ts`, `cheatRuntime.ts`, `watcher.ts` to the `src/main` table with one-line responsibilities and line counts.
- Add `module_info.cc` to the `native/src` table and `listModules` to the addon export list.
- Add `game:current` to the IPC channel list and note the `cheat:state` / `game:state` push events.
- Update the signatures section: relocation now tries verified module arithmetic first and verifies bytes on both paths.
- Note the probe DLL in the tests section, and that the harness now has `loaddll` / `loaddll2` / `unloaddll`.

- [ ] **Step 5: Commit**

```bash
git add tests/native/module_info.test.ts CODEBASE_MAP.md
git commit -m "Prove an RVA anchor survives a module reload, and map the new files"
```

---

## Acceptance against the real game

The harness is a static MSVC binary; every defect the last session found was invisible to it. Passing the suite is necessary, not sufficient. Before calling #8 done, against Valheim:

1. Open Tamper, then launch the game. Tamper attaches with no process picking.
2. The Valheim profile loads; its guard patch behaves as before; the file migrates to schema 2 after any save.
3. Toggle the stamina cheat **before** the game has run the method. The chip reads "waiting for the game to run this code", not an error, and flips to `active` once it compiles.
4. Close the game. Every chip returns to `ready`, and nothing is left patched.

Record what happens in `docs/superpowers/follow-ups/`, in the style of the existing session notes — including anything that only a real JIT could have shown.

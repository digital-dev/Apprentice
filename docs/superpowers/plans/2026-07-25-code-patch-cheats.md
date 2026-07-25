# Code-Patch Cheats (#6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "patch the instruction" cheats to Tamper — take an instruction caught by Find-What-Writes (#5), overwrite it with NOPs so the game's own write never executes, restore the original bytes on disable/detach/quit, and re-locate it after a restart by module+offset or by AOB signature scan.

**Architecture:** Three new native primitives (`readBytes`, `writeBytes`, `scanAob`) do the byte-level work, including the `VirtualProtectEx` → `WriteProcessMemory` → `FlushInstructionCache` dance needed to write executable pages of a live process. A new main-process `PatchEngine` owns locate/apply/restore and an in-memory applied-set that is authoritative for what must be restored; it takes its native calls through an injected `PatchOps` interface so it is unit-testable without a real process (same injection style as `FreezeLoop`). Storage gains a second cheat kind (`kind: 'patch'`) in the same per-game JSON array, with absent `kind` meaning the existing value cheat. Patches never enter the freeze loop — they are apply-once / restore-once.

**Tech Stack:** Existing — Electron + electron-vite, React + TypeScript, Node N-API via `node-addon-api` + `node-gyp` (C++17), Vitest. New Win32 surface — `VirtualProtectEx`, `FlushInstructionCache`, `VirtualQueryEx` over `PAGE_EXECUTE_*` regions.

## Global Constraints

- Windows only. No network calls anywhere in the stack.
- **Safety (non-negotiable):** never write NOPs to an address whose current bytes do not match the captured original (or the signature). Always restore original bytes on disable and on detach/app-exit. If relocation is ambiguous (AOB scan yields 0 or >1 match), mark the patch "can't relocate" rather than patching a guess.
- NOP-fill only. No custom byte patches, no code caves, no trampolines.
- The native addon has a confirmed toolchain quirk: `Init()` must keep its warm-up `Napi::Number::New(env, 0.0)` call (already present in `native/src/addon.cc`) — do not remove it.
- After editing `binding.gyp` sources you must run `npx node-gyp configure` before `npx node-gyp build` (a stale vcxproj otherwise fails to link the new sources).
- The dev server / any running Electron or node process locks `native/build/Release/memory_addon.node`; stop them before rebuilding the addon (`taskkill`/Stop-Process on electron+node).
- One capture session at a time (unchanged from #5).
- Hex string conventions, matching the rest of the addon: addresses are `0x`-prefixed lowercase (`0x7ff6a1b20000`); **byte blobs (`originalBytes`, `readBytes` output, `writeBytes` input) are unprefixed, unspaced, lowercase hex** (`4883ec20`); **AOB signatures are space-separated tokens**, each either two lowercase hex chars or `??` (`89 51 10 ?? ??`) — this is exactly the format `CaughtInstruction.signature` already produces in `native/src/write_watch.cc`.
- `PatchCheat` shape (used across store → ipc → preload → renderer):
  `{ kind: 'patch', id: string, name: string, originalBytes: string, length: number, signature: string, moduleName: string | null, moduleOffset: string | null }`

---

## File Structure

```
native/
  src/
    patch_ops.h             # ReadBytes / WriteBytes / ScanAob N-API exports
    patch_ops.cc            # byte read, protected write + icache flush, AOB scan worker
    addon.cc                # + wire the three exports
  binding.gyp               # + src/patch_ops.cc
test-harness/
  harness.c                 # + drainloop/stopdrain/getcount/setcount commands
src/
  main/
    nativeAddon.ts          # + readBytes/writeBytes/scanAob typed wrappers
    store.ts                # + PatchCheat, StoredCheat union, isPatchCheat
    patchEngine.ts          # locate/apply/restore/restoreAll + applied-set
    ipc.ts                  # + PatchEngine wiring, patch:* handlers, restore on re-attach
    index.ts                # + restore-all on app quit
  preload/index.ts          # + locatePatch/applyPatch/restorePatch bridge methods
  renderer/src/
    tamper.d.ts             # + PatchCheat/PatchStatus types + window.tamper methods
    screens/Scanner.tsx     # "Create patch" button becomes active
    screens/CheatList.tsx   # patch cheat rows: status chip, toggle, delete
tests/
  native/patch_ops.test.ts  # NOP a live drain instruction, restore it, AOB-relocate it
  main/patchEngine.test.ts  # locate/apply/restore logic against a fake PatchOps
  main/store.test.ts        # + mixed value/patch array round-trip
```

---

### Task 1: Test harness gains a drain loop to patch

The native tests need a real, continuously-executing store instruction they can NOP and watch stop. `watchloop` (from #5) writes an ever-increasing value, which makes "did the write stop?" awkward to assert. A monotonically decreasing counter with a `getcount` readout makes it trivial: sample twice, compare.

**Files:**
- Modify: `test-harness/harness.c`
- Rebuild: `test-harness/harness.exe`

**Interfaces:**
- Consumes: nothing.
- Produces: harness stdin commands `drainloop`, `stopdrain`, `setcount <int>`, `getcount` (replies `OK <int>`). Used by Tasks 2 and 3.

- [ ] **Step 1: Add the drain counter, its store instruction, and its thread**

In `test-harness/harness.c`, after the existing `g_watch_running` declaration and before `write_stamina`, add:

```c
static volatile int g_drain_running = 0;

// The instruction under test for code patching. Non-inlined and taking the
// counter as a runtime pointer argument, so the compiler emits a real
// memory read-modify-write through a general-purpose register (e.g.
// `sub dword ptr [rcx], 1`) — the same shape as a game's stamina-drain
// store, and something an AOB signature can match. A RIP-relative store to
// a known global would not exercise the register-based path.
#pragma optimize("", off)
static void drain_step(volatile int* counter) {
  *counter -= 1;
}
#pragma optimize("", on)
```

Then add the counter as a global next to `g_stamina`:

```c
volatile int g_drain_count = 1000000; // patch_ops.test.ts drains and NOPs this
```

- [ ] **Step 2: Add the drain thread**

Add next to `watch_thread` (inside the same `#pragma optimize("", off)` block that already wraps it, i.e. before the closing `#pragma optimize("", on)`):

```c
static unsigned __stdcall drain_thread(void* arg) {
  (void)arg;
  while (g_drain_running) {
    drain_step(&g_drain_count);
    Sleep(1);
  }
  return 0;
}
```

- [ ] **Step 3: Add the four commands**

In `main`'s command loop, add these branches before the final `else`:

```c
    } else if (sscanf(line, "setcount %d", &val) == 1) {
      g_drain_count = val; // lets the test narrow the scan to this exact global
      printf("OK\n");
    } else if (strncmp(line, "getcount", 8) == 0) {
      printf("OK %d\n", g_drain_count);
    } else if (strncmp(line, "drainloop", 9) == 0) {
      if (!g_drain_running) {
        g_drain_running = 1;
        _beginthreadex(NULL, 0, drain_thread, NULL, 0, NULL);
      }
      printf("OK\n");
    } else if (strncmp(line, "stopdrain", 9) == 0) {
      g_drain_running = 0;
      printf("OK\n");
```

Note the ordering constraint: `setcount` must be tested before the existing `set %d` branch would ever see it — it will not, because `sscanf(line, "set %d", &val)` fails on `"setcount 5"` (the literal `set` matches but `count 5` is not a number), so appending these branches is safe.

- [ ] **Step 4: Rebuild the harness**

From a Developer PowerShell / VS build environment at the repo root:

```
cl.exe /Fe:test-harness\harness.exe test-harness\harness.c
```

Then delete the stray `harness.obj`. Expected: rebuilt with no errors.

- [ ] **Step 5: Verify the commands by hand**

```bash
printf 'setcount 500\ngetcount\ndrainloop\ngetcount\nstopdrain\nq\n' | ./test-harness/harness.exe
```

Expected: `PID <n>`, then `OK`, `OK 500`, `OK`, `OK <a value at or below 500>`, `OK`. The counter must be visibly decreasing across repeated `getcount` calls while the drain runs.

- [ ] **Step 6: Commit**

```bash
git add test-harness/harness.c test-harness/harness.exe
git commit -m "Add drainloop harness commands for code-patch tests"
```

---

### Task 2: Native readBytes and writeBytes

**Files:**
- Create: `native/src/patch_ops.h`, `native/src/patch_ops.cc`
- Modify: `native/binding.gyp`, `native/src/addon.cc`
- Test: `tests/native/patch_ops.test.ts`

**Interfaces:**
- Consumes: harness `drainloop`/`stopdrain`/`getcount`/`setcount` (Task 1); existing `attach`, `scanFirst`, `scanNext`, `startWriteWatch`/`pollWriteWatch`/`stopWriteWatch`.
- Produces (native exports, consumed by Task 4's TS wrappers):
  - `readBytes(handle: number, addressHex: string, length: number): string` — unspaced lowercase hex, throws if the read fails.
  - `writeBytes(handle: number, addressHex: string, hexBytes: string): boolean` — returns false if the write fails.

- [ ] **Step 1: Write the failing test**

Create `tests/native/patch_ops.test.ts`:

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

async function count(): Promise<number> {
  const reply = await send('getcount')
  return Number(reply.split(' ')[1])
}

// Find the drain counter's address by scanning for its initial value and
// narrowing to exactly one via setcount, then catch the instruction that
// writes it with the #5 write-watch — that is where a real patch cheat's
// bytes/length/signature come from, so the test starts from the same input.
async function catchDrainInstruction(): Promise<{
  instructionAddress: string
  bytes: string
  length: number
  signature: string
}> {
  let candidates = await (addon as any).scanFirst(handle, 'int32', 1000000)
  await send('setcount 424242')
  candidates = (addon as any).scanNext(handle, candidates, 'int32', {
    mode: 'exact',
    value: 424242
  })
  expect(candidates.length).toBe(1)
  const address = candidates[0].address

  ;(addon as any).startWriteWatch(harness.pid, address)
  await send('drainloop')
  let list: any[] = []
  for (let i = 0; i < 40 && list.length === 0; i++) {
    await sleep(50)
    list = (addon as any).pollWriteWatch()
  }
  await send('stopdrain')
  const final = (addon as any).stopWriteWatch()
  expect(final.length).toBeGreaterThan(0)
  return final[0]
}

describe('readBytes / writeBytes', () => {
  it('NOPs a live drain instruction and restores it', async () => {
    const insn = await catchDrainInstruction()

    // readBytes agrees with what the capture recorded.
    const original = (addon as any).readBytes(handle, insn.instructionAddress, insn.length)
    expect(original).toBe(insn.bytes)

    // NOP it while the drain runs: the counter must stop moving.
    const nops = '90'.repeat(insn.length)
    expect((addon as any).writeBytes(handle, insn.instructionAddress, nops)).toBe(true)
    expect((addon as any).readBytes(handle, insn.instructionAddress, insn.length)).toBe(nops)

    await send('drainloop')
    await sleep(150)
    const a = await count()
    await sleep(300)
    const b = await count()
    expect(b).toBe(a) // patched: the write never executes

    // Restore: the drain must resume.
    expect((addon as any).writeBytes(handle, insn.instructionAddress, original)).toBe(true)
    await sleep(300)
    const c = await count()
    expect(c).toBeLessThan(b)

    await send('stopdrain')
  }, 30000)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/native/patch_ops.test.ts
```

Expected: FAIL — `addon.readBytes is not a function`.

- [ ] **Step 3: Create the header**

Create `native/src/patch_ops.h`:

```cpp
#pragma once
#include <napi.h>

Napi::Value ReadBytes(const Napi::CallbackInfo& info);
Napi::Value WriteBytes(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: Implement readBytes and writeBytes**

Create `native/src/patch_ops.cc`:

```cpp
#include "patch_ops.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string BytesToHex(const uint8_t* data, size_t len) {
  std::string out;
  char hb[4];
  for (size_t i = 0; i < len; i++) {
    snprintf(hb, sizeof(hb), "%02x", data[i]);
    out += hb;
  }
  return out;
}

// Unspaced hex ("4883ec20") -> bytes. Returns false on odd length or any
// non-hex character, so a malformed patch never reaches WriteProcessMemory.
bool HexToBytes(const std::string& hex, std::vector<uint8_t>& out) {
  if (hex.size() % 2 != 0 || hex.empty()) return false;
  out.clear();
  for (size_t i = 0; i < hex.size(); i += 2) {
    char buf[3] = {hex[i], hex[i + 1], 0};
    char* end = nullptr;
    unsigned long v = strtoul(buf, &end, 16);
    if (end != buf + 2) return false;
    out.push_back(static_cast<uint8_t>(v));
  }
  return true;
}

} // namespace

Napi::Value ReadBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  size_t length = static_cast<size_t>(info[2].As<Napi::Number>().Uint32Value());

  if (length == 0 || length > 64) {
    Napi::Error::New(env, "readBytes length must be 1..64").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uint8_t> buffer(length);
  SIZE_T read = 0;
  if (!ReadProcessMemory(h, (LPCVOID)address, buffer.data(), length, &read) || read != length) {
    Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, BytesToHex(buffer.data(), length));
}

// Writing into a live process's CODE, which normally sits on read-execute
// pages: temporarily make the page writable, write, put the original
// protection back, then flush the target's instruction cache so the CPU
// doesn't keep executing a stale cached copy of the bytes we just changed.
Napi::Value WriteBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  std::string hex = info[2].As<Napi::String>().Utf8Value();

  std::vector<uint8_t> bytes;
  if (!HexToBytes(hex, bytes)) return Napi::Boolean::New(env, false);

  DWORD oldProtect = 0;
  if (!VirtualProtectEx(h, (LPVOID)address, bytes.size(), PAGE_EXECUTE_READWRITE, &oldProtect))
    return Napi::Boolean::New(env, false);

  SIZE_T written = 0;
  bool ok = WriteProcessMemory(h, (LPVOID)address, bytes.data(), bytes.size(), &written) &&
            written == bytes.size();

  // Restore protection regardless of whether the write succeeded — leaving
  // a game's code page permanently writable is exactly the kind of residue
  // this feature promises never to leave behind.
  DWORD ignored = 0;
  VirtualProtectEx(h, (LPVOID)address, bytes.size(), oldProtect, &ignored);
  FlushInstructionCache(h, (LPCVOID)address, bytes.size());

  return Napi::Boolean::New(env, ok);
}
```

- [ ] **Step 5: Wire into the build and the addon**

In `native/binding.gyp`, add `"src/patch_ops.cc"` to `sources` (after `"src/write_watch.cc"`).

In `native/src/addon.cc`, add the include next to the others:

```cpp
#include "patch_ops.h"
```

and the exports next to the write-watch ones in `Init`:

```cpp
  exports.Set("readBytes", Napi::Function::New(env, ReadBytes));
  exports.Set("writeBytes", Napi::Function::New(env, WriteBytes));
```

- [ ] **Step 6: Configure and build**

Stop any running Electron/node first (they lock the `.node` file), then:

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
```

Expected: `gyp info ok`, `native/build/Release/memory_addon.node` produced.

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run tests/native/patch_ops.test.ts
```

Expected: PASS — the counter freezes while NOPped and resumes after restore.

- [ ] **Step 8: Commit**

```bash
git add native/src/patch_ops.h native/src/patch_ops.cc native/src/addon.cc native/binding.gyp tests/native/patch_ops.test.ts
git commit -m "Add readBytes/writeBytes with protect+flush for live code patching"
```

---

### Task 3: Native scanAob (relocate by signature)

**Files:**
- Modify: `native/src/patch_ops.h`, `native/src/patch_ops.cc`, `native/src/addon.cc`
- Test: `tests/native/patch_ops.test.ts`

**Interfaces:**
- Consumes: `readBytes`/`writeBytes` (Task 2), harness drain commands (Task 1).
- Produces: `scanAob(handle: number, signature: string): Promise<string[]>` — signature is space-separated `??`-or-hex-pair tokens; returns `0x`-prefixed lowercase addresses of every match in committed, readable-executable memory.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/patch_ops.test.ts`:

```ts
describe('scanAob', () => {
  it('relocates the drain instruction by signature and patches it there', async () => {
    const insn = await catchDrainInstruction()
    const original = (addon as any).readBytes(handle, insn.instructionAddress, insn.length)

    const matches: string[] = await (addon as any).scanAob(handle, insn.signature)
    // The signature may legitimately match more than once (short
    // instruction encodings recur), but it must find the real one.
    expect(matches).toContain(insn.instructionAddress)

    // Patching at the SCANNED address (not the captured one) must have the
    // same effect — this is the path a patch takes after a game restart.
    const found = matches.find((m) => m === insn.instructionAddress) as string
    const nops = '90'.repeat(insn.length)
    expect((addon as any).writeBytes(handle, found, nops)).toBe(true)

    await send('drainloop')
    await sleep(150)
    const a = await count()
    await sleep(300)
    const b = await count()
    expect(b).toBe(a)

    expect((addon as any).writeBytes(handle, found, original)).toBe(true)
    await sleep(300)
    expect(await count()).toBeLessThan(b)
    await send('stopdrain')
  }, 30000)

  it('returns an empty list for a signature that matches nothing', async () => {
    const matches: string[] = await (addon as any).scanAob(
      handle,
      'de ad be ef de ad be ef de ad be ef'
    )
    expect(matches).toEqual([])
  })

  it('rejects a malformed signature', async () => {
    await expect((addon as any).scanAob(handle, 'zz 11')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/native/patch_ops.test.ts -t scanAob
```

Expected: FAIL — `addon.scanAob is not a function`.

- [ ] **Step 3: Declare the export**

In `native/src/patch_ops.h`, add:

```cpp
Napi::Value ScanAob(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: Implement the scan**

In `native/src/patch_ops.cc`, add to the anonymous namespace (after `HexToBytes`):

```cpp
std::string ToHexAddr(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

// A parsed AOB pattern: one entry per byte. `wildcard` entries match any
// byte ("??" in the signature text).
struct PatternByte {
  uint8_t value;
  bool wildcard;
};

bool ParseSignature(const std::string& sig, std::vector<PatternByte>& out) {
  out.clear();
  size_t i = 0;
  while (i < sig.size()) {
    if (sig[i] == ' ') { i++; continue; }
    if (i + 1 >= sig.size()) return false;
    if (sig[i] == '?' && sig[i + 1] == '?') {
      out.push_back({0, true});
    } else {
      char buf[3] = {sig[i], sig[i + 1], 0};
      char* end = nullptr;
      unsigned long v = strtoul(buf, &end, 16);
      if (end != buf + 2) return false;
      out.push_back({static_cast<uint8_t>(v), false});
    }
    i += 2;
  }
  return !out.empty();
}

// Walk committed executable memory looking for the pattern. Only
// executable regions are searched: a code patch targets an instruction, and
// skipping the (much larger) data regions keeps this fast. Bare
// PAGE_EXECUTE is excluded because it isn't readable, so ReadProcessMemory
// would fail on it anyway. One bulk read per region, same as the value
// scanner — a per-address read is what made earlier scans look hung.
std::vector<uintptr_t> RunScanAob(HANDLE h, const std::vector<PatternByte>& pattern) {
  std::vector<uintptr_t> out;
  const size_t plen = pattern.size();

  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool executable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) &&
        !(mbi.Protect & PAGE_GUARD);

    if (executable && mbi.RegionSize >= plen) {
      std::vector<uint8_t> buffer(mbi.RegionSize);
      SIZE_T bytesRead = 0;
      if (ReadProcessMemory(h, mbi.BaseAddress, buffer.data(), mbi.RegionSize, &bytesRead) &&
          bytesRead >= plen) {
        uintptr_t base = (uintptr_t)mbi.BaseAddress;
        for (SIZE_T offset = 0; offset + plen <= bytesRead; offset++) {
          bool match = true;
          for (size_t k = 0; k < plen; k++) {
            if (pattern[k].wildcard) continue;
            if (buffer[offset + k] != pattern[k].value) { match = false; break; }
          }
          if (match) out.push_back(base + offset);
        }
      }
    }

    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }
  return out;
}

// Same reasoning as ScanFirstWorker in scanner.cc: this walks a real game's
// whole executable memory, so it runs on a libuv worker thread rather than
// blocking the entire Electron app.
class ScanAobWorker : public Napi::AsyncWorker {
 public:
  ScanAobWorker(Napi::Env env, HANDLE handle, std::vector<PatternByte> pattern)
      : Napi::AsyncWorker(env),
        handle_(handle),
        pattern_(std::move(pattern)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override { results_ = RunScanAob(handle_, pattern_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      result.Set((uint32_t)i, Napi::String::New(env, ToHexAddr(results_[i])));
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  std::vector<PatternByte> pattern_;
  std::vector<uintptr_t> results_;
  Napi::Promise::Deferred deferred_;
};
```

Then add the exported function at the end of the file:

```cpp
Napi::Value ScanAob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string signature = info[1].As<Napi::String>().Utf8Value();

  std::vector<PatternByte> pattern;
  if (!ParseSignature(signature, pattern)) {
    Napi::Error::New(env, "malformed AOB signature").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto* worker = new ScanAobWorker(env, h, std::move(pattern));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}
```

Note: `ParseSignature`, `RunScanAob` and `ScanAobWorker` must be declared inside the existing anonymous `namespace { ... }` block, above its closing `} // namespace`, while `ScanAob` itself goes after it (same layout `scanner.cc` uses).

The malformed-signature case throws synchronously rather than rejecting; the test uses `rejects.toThrow()`, which also passes for a synchronous throw inside an `await`ed expression only if the throw happens during the awaited call — it does, because `expect(...).rejects` receives the thrown error via the `await`. If that assertion proves brittle in practice, change the test to `expect(() => (addon as any).scanAob(handle, 'zz 11')).toThrow()` and keep the implementation as-is.

- [ ] **Step 5: Wire the export**

In `native/src/addon.cc`, in `Init`:

```cpp
  exports.Set("scanAob", Napi::Function::New(env, ScanAob));
```

- [ ] **Step 6: Build**

```bash
cd native && npx node-gyp build && cd ..
```

Expected: build succeeds. (`configure` is only needed when `binding.gyp` changed, which it did in Task 2 — no source list change here.)

- [ ] **Step 7: Run the tests**

```bash
npx vitest run tests/native/patch_ops.test.ts
```

Expected: PASS, all four tests.

- [ ] **Step 8: Commit**

```bash
git add native/src/patch_ops.h native/src/patch_ops.cc native/src/addon.cc tests/native/patch_ops.test.ts
git commit -m "Add scanAob signature scan over executable memory"
```

---

### Task 4: Typed wrappers and the patch cheat storage kind

**Files:**
- Modify: `src/main/nativeAddon.ts`, `src/main/store.ts`
- Test: `tests/main/store.test.ts`

**Interfaces:**
- Consumes: native `readBytes`/`writeBytes`/`scanAob` (Tasks 2–3).
- Produces:
  - `nativeAddon.readBytes(handle, address, length): string`, `nativeAddon.tryReadBytes(handle, address, length): string | null`, `nativeAddon.writeBytes(handle, address, hexBytes): boolean`, `nativeAddon.scanAob(handle, signature): Promise<string[]>`
  - `store.PatchCheat`, `store.StoredCheat = CheatDefinition | PatchCheat`, `store.isPatchCheat(c): c is PatchCheat`
  - `loadCheats(exeName): StoredCheat[]`, `saveCheat(exeName, cheat: StoredCheat)`, `deleteCheat` unchanged.

- [ ] **Step 1: Write the failing store tests**

Append to `tests/main/store.test.ts` (and extend its import line to `import { loadCheats, saveCheat, deleteCheat, setGamesDir, isPatchCheat, PatchCheat } from '../../src/main/store'`):

```ts
describe('store — patch cheats', () => {
  const patch: PatchCheat = {
    kind: 'patch',
    id: 'no-stamina-drain',
    name: 'No Stamina Drain',
    originalBytes: 'f30f114110',
    length: 5,
    signature: 'f3 0f 11 41 10',
    moduleName: 'valheim.exe',
    moduleOffset: '0x1234'
  }

  it('saves and loads a patch cheat alongside a value cheat', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
      value: 999
    })
    saveCheat('valheim.exe', patch)

    const cheats = loadCheats('valheim.exe')
    expect(cheats).toHaveLength(2)
    expect(cheats.filter(isPatchCheat)).toHaveLength(1)
    expect(cheats.filter(isPatchCheat)[0].originalBytes).toBe('f30f114110')
  })

  it('treats a cheat with no kind field as a value cheat (backward compatible)', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
      value: 999
    })
    const cheats = loadCheats('valheim.exe')
    expect(isPatchCheat(cheats[0])).toBe(false)
  })

  it('deletes a patch cheat by id', () => {
    saveCheat('valheim.exe', patch)
    deleteCheat('valheim.exe', 'no-stamina-drain')
    expect(loadCheats('valheim.exe')).toEqual([])
  })

  it('supports a JIT patch with no module (relocated by signature only)', () => {
    saveCheat('valheim.exe', { ...patch, moduleName: null, moduleOffset: null })
    const loaded = loadCheats('valheim.exe').filter(isPatchCheat)[0]
    expect(loaded.moduleName).toBeNull()
    expect(loaded.signature).toBe('f3 0f 11 41 10')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/main/store.test.ts
```

Expected: FAIL — `isPatchCheat` is not exported.

- [ ] **Step 3: Add the patch kind to the store**

In `src/main/store.ts`, add `kind?: 'value'` to `CheatDefinition` (as its first field) and append after it:

```ts
// A code patch: NOP out the instruction the game uses to write a value,
// instead of fighting that write by freezing the value. Stored in the same
// per-game array as value cheats and told apart by `kind` — an absent
// `kind` means a value cheat, which keeps every existing games/*.json file
// loading unchanged.
export interface PatchCheat {
  kind: 'patch'
  id: string
  name: string
  originalBytes: string // captured instruction bytes, unspaced lowercase hex
  length: number // bytes to NOP == instruction length
  signature: string // AOB with ?? wildcards, for relocating JIT code
  moduleName: string | null // named module, or null for JIT/anonymous code
  moduleOffset: string | null // hex offset within that module
}

export type StoredCheat = CheatDefinition | PatchCheat

export function isPatchCheat(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
}
```

Then widen the three functions' types: `loadCheats(exeName: string): StoredCheat[]` (cast `JSON.parse(raw) as StoredCheat[]`) and `saveCheat(exeName: string, cheat: StoredCheat): void`. `deleteCheat` needs no change.

- [ ] **Step 4: Run the store tests**

```bash
npx vitest run tests/main/store.test.ts
```

Expected: PASS (all old and new tests).

- [ ] **Step 5: Add the native wrappers**

In `src/main/nativeAddon.ts`, add to the `nativeAddon` object after `writeValue`:

```ts
  readBytes: (handle: number, address: string, length: number): string =>
    addon.readBytes(handle, address, length),
  // Verify-before-patch treats "can't read there" as a normal outcome (the
  // module moved, the JIT code is gone), not an error, so it uses this
  // non-throwing form — same split as readValue/tryReadValue.
  tryReadBytes: (handle: number, address: string, length: number): string | null => {
    try {
      return addon.readBytes(handle, address, length)
    } catch {
      return null
    }
  },
  writeBytes: (handle: number, address: string, hexBytes: string): boolean =>
    addon.writeBytes(handle, address, hexBytes),
  // Runs on a background thread in the addon (Napi::AsyncWorker) and returns
  // a Promise — it walks all executable memory of the target.
  scanAob: (handle: number, signature: string): Promise<string[]> =>
    addon.scanAob(handle, signature),
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors. If `src/main/ipc.ts` or the renderer complain about `loadCheats` now returning a union, leave them for Tasks 6–8 only if the error is about the renderer's `CheatList`; any error inside `src/main/ipc.ts` must be fixed here by typing the `cheats:load`/`cheats:save` handler parameters as `StoredCheat` (import it alongside `CheatDefinition`).

- [ ] **Step 7: Commit**

```bash
git add src/main/store.ts src/main/nativeAddon.ts src/main/ipc.ts tests/main/store.test.ts
git commit -m "Add PatchCheat storage kind and byte-level native wrappers"
```

---

### Task 5: PatchEngine — locate, apply, restore

**Files:**
- Create: `src/main/patchEngine.ts`
- Test: `tests/main/patchEngine.test.ts`

**Interfaces:**
- Consumes: `PatchCheat` (Task 4).
- Produces:
  ```ts
  export interface PatchOps {
    getModuleBase(moduleName: string): string | null
    readBytes(address: string, length: number): string | null
    writeBytes(address: string, hexBytes: string): boolean
    scanAob(signature: string): Promise<string[]>
  }
  export type PatchState = 'original' | 'applied' | 'not-found' | 'mismatch'
  export interface PatchStatus { address: string | null; state: PatchState; applicable: boolean }
  export function nopHex(length: number): string
  export class PatchEngine {
    constructor(ops: PatchOps)
    locate(patch: PatchCheat): Promise<PatchStatus>
    apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }>
    restore(patch: PatchCheat): boolean
    restoreAll(): void
    isApplied(id: string): boolean
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/main/patchEngine.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PatchEngine, PatchOps, nopHex } from '../../src/main/patchEngine'
import type { PatchCheat } from '../../src/main/store'

const ORIGINAL = 'f30f114110' // 5 bytes
const NOPS = '9090909090'

const modulePatch: PatchCheat = {
  kind: 'patch',
  id: 'no-drain',
  name: 'No Drain',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.exe',
  moduleOffset: '0x100'
}

const jitPatch: PatchCheat = { ...modulePatch, id: 'jit-drain', moduleName: null, moduleOffset: null }

// A fake target process: a map of address -> current bytes, plus a module
// table. Lets every locate/apply/restore path be driven deterministically
// without a real process or the native addon.
class FakeOps implements PatchOps {
  memory = new Map<string, string>()
  modules = new Map<string, string>()
  aobMatches: string[] = []
  writeShouldFail = false
  writes: { address: string; bytes: string }[] = []

  getModuleBase(moduleName: string): string | null {
    return this.modules.get(moduleName) ?? null
  }
  readBytes(address: string, length: number): string | null {
    const bytes = this.memory.get(address)
    if (bytes === undefined) return null
    return bytes.slice(0, length * 2)
  }
  writeBytes(address: string, hexBytes: string): boolean {
    if (this.writeShouldFail) return false
    this.memory.set(address, hexBytes)
    this.writes.push({ address, bytes: hexBytes })
    return true
  }
  async scanAob(): Promise<string[]> {
    return this.aobMatches
  }
}

let ops: FakeOps
let engine: PatchEngine

beforeEach(() => {
  ops = new FakeOps()
  ops.modules.set('game.exe', '0x400000')
  ops.memory.set('0x400100', ORIGINAL) // module base + 0x100
  engine = new PatchEngine(ops)
})

describe('nopHex', () => {
  it('produces two hex chars of 0x90 per byte', () => {
    expect(nopHex(5)).toBe(NOPS)
  })
})

describe('PatchEngine.locate', () => {
  it('resolves a module-anchored patch to base + offset with original bytes', async () => {
    const status = await engine.locate(modulePatch)
    expect(status).toEqual({ address: '0x400100', state: 'original', applicable: true })
  })

  it('reports not-found when the module is not loaded', async () => {
    ops.modules.clear()
    const status = await engine.locate(modulePatch)
    expect(status).toEqual({ address: null, state: 'not-found', applicable: false })
  })

  it('reports applied when the bytes there are already NOPs', async () => {
    ops.memory.set('0x400100', NOPS)
    const status = await engine.locate(modulePatch)
    expect(status.state).toBe('applied')
    expect(status.applicable).toBe(true)
  })

  it('reports mismatch when the bytes are neither the original nor NOPs', async () => {
    ops.memory.set('0x400100', 'cccccccccc'.slice(0, 10))
    const status = await engine.locate(modulePatch)
    expect(status.state).toBe('mismatch')
    expect(status.applicable).toBe(false)
  })

  it('relocates a JIT patch by signature when the scan finds exactly one match', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    const status = await engine.locate(jitPatch)
    expect(status).toEqual({ address: '0x7ff000001000', state: 'original', applicable: true })
  })

  it('refuses to guess when the signature scan finds several matches', async () => {
    ops.aobMatches = ['0x7ff000001000', '0x7ff000002000']
    const status = await engine.locate(jitPatch)
    expect(status).toEqual({ address: null, state: 'not-found', applicable: false })
  })

  it('refuses when the signature scan finds nothing', async () => {
    ops.aobMatches = []
    const status = await engine.locate(jitPatch)
    expect(status.applicable).toBe(false)
  })
})

describe('PatchEngine.apply / restore', () => {
  it('writes NOPs at the located address and reports it applied', async () => {
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(NOPS)
    expect(engine.isApplied('no-drain')).toBe(true)
  })

  it('restores the original bytes and forgets the patch', async () => {
    await engine.apply(modulePatch)
    expect(engine.restore(modulePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
    expect(engine.isApplied('no-drain')).toBe(false)
  })

  it('refuses to patch when the bytes do not match the original', async () => {
    ops.memory.set('0x400100', 'cccccccccc')
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("don't match")
    expect(ops.writes).toHaveLength(0)
    expect(engine.isApplied('no-drain')).toBe(false)
  })

  it('refuses to patch when it cannot be located', async () => {
    ops.modules.clear()
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('relocate')
    expect(ops.writes).toHaveLength(0)
  })

  it('does not mark a patch applied when the write fails', async () => {
    ops.writeShouldFail = true
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(engine.isApplied('no-drain')).toBe(false)
  })

  it('applying an already-NOPped patch is a no-op success and becomes restorable', async () => {
    ops.memory.set('0x400100', NOPS)
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(true)
    expect(ops.writes).toHaveLength(0) // nothing needed writing
    expect(engine.isApplied('no-drain')).toBe(true)
    // Still restorable, because apply recorded the address and originals.
    expect(engine.restore(modulePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
  })

  it('restoring a patch that was never applied is a harmless no-op', () => {
    expect(engine.restore(modulePatch)).toBe(true)
    expect(ops.writes).toHaveLength(0)
  })

  it('restores at the address it actually patched, not a re-derived one', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    await engine.apply(jitPatch)
    ops.aobMatches = [] // signature would no longer relocate — must not matter
    expect(engine.restore(jitPatch)).toBe(true)
    expect(ops.memory.get('0x7ff000001000')).toBe(ORIGINAL)
  })

  it('restoreAll restores every applied patch and clears the set', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    await engine.apply(modulePatch)
    await engine.apply(jitPatch)

    engine.restoreAll()

    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
    expect(ops.memory.get('0x7ff000001000')).toBe(ORIGINAL)
    expect(engine.isApplied('no-drain')).toBe(false)
    expect(engine.isApplied('jit-drain')).toBe(false)
  })

  it('restoreAll clears the set even when the writes fail (process already gone)', async () => {
    await engine.apply(modulePatch)
    ops.writeShouldFail = true
    engine.restoreAll()
    expect(engine.isApplied('no-drain')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/main/patchEngine.test.ts
```

Expected: FAIL — cannot resolve `../../src/main/patchEngine`.

- [ ] **Step 3: Implement the engine**

Create `src/main/patchEngine.ts`:

```ts
import type { PatchCheat } from './store'

// Everything PatchEngine needs from the target process. Injected rather
// than imported so the engine's locate/apply/restore logic — the part that
// must never write to a wrong or unverified address — can be tested
// exhaustively against a fake process (same style as FreezeLoop's writeFn).
export interface PatchOps {
  getModuleBase(moduleName: string): string | null
  readBytes(address: string, length: number): string | null
  writeBytes(address: string, hexBytes: string): boolean
  scanAob(signature: string): Promise<string[]>
}

export type PatchState = 'original' | 'applied' | 'not-found' | 'mismatch'

export interface PatchStatus {
  address: string | null
  state: PatchState
  // Safe to toggle on: we found it AND its bytes are what we expect.
  applicable: boolean
}

export function nopHex(length: number): string {
  return '90'.repeat(length)
}

interface AppliedPatch {
  address: string
  originalBytes: string
}

export class PatchEngine {
  private ops: PatchOps
  // The source of truth for what must be restored. Authoritative over the
  // stored definition: if the code moved after we patched it, the address
  // we actually wrote to is the only one that matters for putting the
  // original bytes back.
  private applied = new Map<string, AppliedPatch>()

  constructor(ops: PatchOps) {
    this.ops = ops
  }

  isApplied(id: string): boolean {
    return this.applied.has(id)
  }

  async locate(patch: PatchCheat): Promise<PatchStatus> {
    const address = await this.resolveAddress(patch)
    if (address === null) return { address: null, state: 'not-found', applicable: false }

    const current = this.ops.readBytes(address, patch.length)
    if (current === null) return { address: null, state: 'not-found', applicable: false }

    const original = patch.originalBytes.toLowerCase()
    if (current.toLowerCase() === original) return { address, state: 'original', applicable: true }
    if (current.toLowerCase() === nopHex(patch.length))
      return { address, state: 'applied', applicable: true }
    // Something else lives there now — another trainer, an update, or a
    // wrong relocation. Never overwrite it.
    return { address, state: 'mismatch', applicable: false }
  }

  async apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }> {
    const status = await this.locate(patch)
    if (status.address === null || status.state === 'not-found') {
      return { ok: false, error: "Can't relocate this instruction in the running game." }
    }
    if (status.state === 'mismatch') {
      return {
        ok: false,
        error: "The bytes at that address don't match what was captured — not patching."
      }
    }

    if (status.state === 'original') {
      if (!this.ops.writeBytes(status.address, nopHex(patch.length))) {
        return { ok: false, error: 'Write failed — the patch was not applied.' }
      }
    }
    // 'applied' falls through: the NOPs are already there (e.g. we
    // re-attached to a process we had patched), so nothing needs writing —
    // but we must still record it so it gets restored.
    this.applied.set(patch.id, {
      address: status.address,
      originalBytes: patch.originalBytes
    })
    return { ok: true, error: null }
  }

  restore(patch: PatchCheat): boolean {
    const entry = this.applied.get(patch.id)
    if (!entry) return true // never applied — nothing to undo
    const ok = this.ops.writeBytes(entry.address, entry.originalBytes)
    if (ok) this.applied.delete(patch.id)
    return ok
  }

  // Detach / app quit: put every patched instruction back. A failed write
  // here is ignored — it means the process is already gone, and its code
  // went with it. The set is cleared either way so a later attach starts
  // from a clean slate.
  restoreAll(): void {
    for (const entry of this.applied.values()) {
      this.ops.writeBytes(entry.address, entry.originalBytes)
    }
    this.applied.clear()
  }

  private async resolveAddress(patch: PatchCheat): Promise<string | null> {
    if (patch.moduleName !== null && patch.moduleOffset !== null) {
      const base = this.ops.getModuleBase(patch.moduleName)
      if (base === null) return null
      return '0x' + (BigInt(base) + BigInt(patch.moduleOffset)).toString(16)
    }
    // JIT / anonymous code: only a signature can find it again. Anything
    // other than exactly one match is ambiguous, and a guess here means
    // NOPping an unknown instruction.
    const matches = await this.ops.scanAob(patch.signature)
    if (matches.length !== 1) return null
    return matches[0]
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/main/patchEngine.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/patchEngine.ts tests/main/patchEngine.test.ts
git commit -m "Add PatchEngine: locate, verify-before-write, apply, restore"
```

---

### Task 6: Wire patches through IPC, preload, and app lifecycle

**Files:**
- Modify: `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/tamper.d.ts`

**Interfaces:**
- Consumes: `PatchEngine`, `PatchOps`, `PatchStatus` (Task 5); `nativeAddon.readBytes/tryReadBytes/writeBytes/scanAob` (Task 4); `PatchCheat`, `StoredCheat` (Task 4).
- Produces:
  - IPC channels `patch:locate`, `patch:apply`, `patch:restore`.
  - `restoreAllPatches(): void` exported from `src/main/ipc.ts` (called on app quit).
  - `window.tamper.locatePatch(patch): Promise<PatchStatus>`, `window.tamper.applyPatch(patch): Promise<{ ok: boolean; error: string | null }>`, `window.tamper.restorePatch(patch): Promise<boolean>`.

- [ ] **Step 1: Build the engine's ops in ipc.ts**

In `src/main/ipc.ts`, extend the imports:

```ts
import { loadCheats, saveCheat, deleteCheat, CheatDefinition, ChainTarget, StoredCheat, PatchCheat } from './store'
import { PatchEngine, PatchOps } from './patchEngine'
```

and add after the `freezeLoop` construction (`freezeLoop.start()`):

```ts
// The engine's view of the target process. Each call reads the CURRENT
// attachedHandle rather than capturing one, so the engine keeps working
// across a re-attach without being rebuilt. Reads are the non-throwing
// form: "can't read there" is an expected outcome for a patch whose code
// has moved, not an error.
const patchOps: PatchOps = {
  getModuleBase: (moduleName) =>
    attachedHandle === null ? null : nativeAddon.getModuleBase(attachedHandle, moduleName),
  readBytes: (address, length) =>
    attachedHandle === null ? null : nativeAddon.tryReadBytes(attachedHandle, address, length),
  writeBytes: (address, hexBytes) =>
    attachedHandle === null ? false : nativeAddon.writeBytes(attachedHandle, address, hexBytes),
  scanAob: async (signature) =>
    attachedHandle === null ? [] : nativeAddon.scanAob(attachedHandle, signature)
}

const patchEngine = new PatchEngine(patchOps)

// Called on app quit (from index.ts) so Tamper never leaves a game's code
// modified after it closes.
export function restoreAllPatches(): void {
  patchEngine.restoreAll()
}
```

- [ ] **Step 2: Restore before switching processes**

In the `process:attach` handler, restore patches applied to the process we're leaving before the handle is replaced — otherwise the old process keeps NOPs we can no longer address. Replace the handler body with:

```ts
  ipcMain.handle('process:attach', (_e, pid: number) => {
    // Attaching elsewhere means letting go of the current process — put its
    // code back first, while its handle is still valid.
    if (attachedHandle !== null && attachedPid !== pid) patchEngine.restoreAll()
    const { handle, baseAddress } = nativeAddon.attach(pid)
    attachedHandle = handle
    attachedBase = baseAddress
    attachedPid = pid
    return { handle, baseAddress }
  })
```

- [ ] **Step 3: Widen the cheat handlers and add the patch channels**

Change the `cheats:save` handler's parameter type from `CheatDefinition` to `StoredCheat` (the renderer now saves both kinds), and add these handlers next to the write-watch ones:

```ts
  ipcMain.handle('patch:locate', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) throw new Error('not attached')
    return patchEngine.locate(patch)
  })

  ipcMain.handle('patch:apply', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) throw new Error('not attached')
    return patchEngine.apply(patch)
  })

  ipcMain.handle('patch:restore', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) return true // process gone; its code went with it
    return patchEngine.restore(patch)
  })
```

Also make deletion safe: in the `cheats:delete` handler, a patch cheat being deleted while applied must be restored first. Replace its body with:

```ts
  ipcMain.handle('cheats:delete', (_e, exeName: string, cheatId: string) => {
    freezeLoop.disable(cheatId)
    // A deleted patch must not stay in the game's code — restore it while
    // we still have its recorded address and original bytes.
    if (patchEngine.isApplied(cheatId)) {
      const stored = loadCheats(exeName).find((c) => c.id === cheatId)
      if (stored && stored.kind === 'patch') patchEngine.restore(stored)
    }
    deleteCheat(exeName, cheatId)
  })
```

- [ ] **Step 4: Restore on app quit**

In `src/main/index.ts`, extend the import and add the handler:

```ts
import { registerIpcHandlers, restoreAllPatches } from './ipc'
```

```ts
// Never leave a game running with Tamper's NOPs in its code.
app.on('before-quit', () => restoreAllPatches())
```

Place it next to the existing `app.on('window-all-closed', ...)` line.

- [ ] **Step 5: Expose the bridge methods**

In `src/preload/index.ts`, extend the type import and add the three methods after `stopWriteWatch`:

```ts
import type { StoredCheat, PatchCheat } from '../main/store'
```

```ts
  locatePatch: (patch: PatchCheat) => ipcRenderer.invoke('patch:locate', patch),
  applyPatch: (patch: PatchCheat) => ipcRenderer.invoke('patch:apply', patch),
  restorePatch: (patch: PatchCheat) => ipcRenderer.invoke('patch:restore', patch)
```

Also change `saveCheat`'s parameter type from `CheatDefinition` to `StoredCheat` (keep the `CheatDefinition` import too — `toggleFreeze`, `oneShot`, and `verifyCheat` still take it).

- [ ] **Step 6: Declare the renderer types**

In `src/renderer/src/tamper.d.ts`, extend the import and add the types plus the three methods:

```ts
import type { CheatDefinition, StoredCheat, PatchCheat } from '../../main/store'
```

```ts
export type PatchState = 'original' | 'applied' | 'not-found' | 'mismatch'

export interface PatchStatus {
  address: string | null
  state: PatchState
  applicable: boolean
}
```

Inside the `tamper` interface, change `loadCheats` to `(exeName: string) => Promise<StoredCheat[]>` and `saveCheat` to `(exeName: string, cheat: StoredCheat) => Promise<void>`, then add:

```ts
      locatePatch: (patch: PatchCheat) => Promise<PatchStatus>
      applyPatch: (patch: PatchCheat) => Promise<{ ok: boolean; error: string | null }>
      restorePatch: (patch: PatchCheat) => Promise<boolean>
```

- [ ] **Step 7: Typecheck and run the full suite**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: `tsc` may report errors only in `src/renderer/src/screens/CheatList.tsx`, because `loadCheats` now returns a union that its `CheatDefinition[]` state can't hold — that file is Task 8. Fix any error outside that file here. All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/src/tamper.d.ts
git commit -m "Wire patch locate/apply/restore through IPC and app lifecycle"
```

---

### Task 7: "Create patch" in the capture panel

**Files:**
- Modify: `src/renderer/src/screens/Scanner.tsx`

**Interfaces:**
- Consumes: `CaughtInstruction` (existing), `PatchCheat` (Task 4), `window.tamper.saveCheat` (Task 6).
- Produces: a saved `PatchCheat` from a caught instruction; no new exports.

- [ ] **Step 1: Add the create-patch handler**

In `src/renderer/src/screens/Scanner.tsx`, extend the store type import to
`import type { CheatDefinition, ChainTarget, CheatMode, DataType, PatchCheat } from '../../../main/store'`
and add this function directly after `createCheatFromInstruction`:

```ts
  // Turn a caught instruction into a code patch. Unlike the pointer-cheat
  // path this needs no base register and no chain — only the instruction's
  // own bytes, length, signature and module anchor — so it works for
  // rip-relative and otherwise-undecoded writes too.
  async function createPatchFromInstruction(insn: CaughtInstruction) {
    if (!captureName) return
    setCaptureError(null)
    const patch: PatchCheat = {
      kind: 'patch',
      id: captureName.toLowerCase().replace(/\s+/g, '-'),
      name: captureName,
      originalBytes: insn.bytes,
      length: insn.length,
      signature: insn.signature,
      moduleName: insn.moduleName,
      moduleOffset: insn.moduleOffset
    }
    await window.tamper.saveCheat(exeName, patch)
    onSaved()
  }
```

- [ ] **Step 2: Activate the button**

Replace the disabled placeholder button:

```tsx
                <button disabled title="Coming in the AOB update">Create patch</button>
```

with:

```tsx
                <button
                  disabled={!captureName || insn.length === 0}
                  title="Replace this instruction with no-ops so the write never happens"
                  onClick={() => createPatchFromInstruction(insn)}
                >
                  Create patch
                </button>
```

- [ ] **Step 3: Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no errors from `Scanner.tsx`; the renderer bundle builds. (`CheatList.tsx` errors are expected until Task 8.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/screens/Scanner.tsx
git commit -m "Enable Create patch in the capture panel"
```

---

### Task 8: Patch cheats in the cheat list

**Files:**
- Modify: `src/renderer/src/screens/CheatList.tsx`

**Interfaces:**
- Consumes: `StoredCheat`, `PatchCheat` types (Task 4); `window.tamper.locatePatch/applyPatch/restorePatch` (Task 6).
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Split value and patch cheats in state**

In `src/renderer/src/screens/CheatList.tsx`, change the imports:

```ts
import type { CheatDefinition, StoredCheat, PatchCheat } from '../../../main/store'
import type { TargetStatus, PatchStatus } from '../tamper.d'
```

and add this local guard above the component:

```ts
// Deliberately re-declared here instead of importing store.ts's
// isPatchCheat: that would be a VALUE import from the main process into the
// renderer bundle, dragging node:fs/node:path in with it. The renderer only
// ever gets these objects over IPC, so a one-line local guard is the right
// boundary.
function isPatch(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
}
```

Replace the `cheats` state declaration with two lists plus patch state:

```ts
  const [cheats, setCheats] = useState<CheatDefinition[]>([])
  const [patches, setPatches] = useState<PatchCheat[]>([])
  // Where each patch currently sits and whether it's safe to toggle on.
  // Checked once on attach and refreshed after each toggle.
  const [patchStatuses, setPatchStatuses] = useState<Map<string, PatchStatus>>(new Map())
  const [patchEnabled, setPatchEnabled] = useState<Set<string>>(new Set())
  const [patchError, setPatchError] = useState<Map<string, string>>(new Map())
```

- [ ] **Step 2: Load both kinds and locate the patches**

In the `loadAndRevalidate` function inside `useEffect`, replace its first two lines
(`const loaded = await window.tamper.loadCheats(exeName)` and `setCheats(loaded)`) with:

```ts
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      const loaded = all.filter((c): c is CheatDefinition => !isPatch(c))
      const loadedPatches = all.filter(isPatch)
      setCheats(loaded)
      setPatches(loadedPatches)

      // A patch's address is only meaningful against the running process, so
      // resolve each one on attach: module+offset for module code, an AOB
      // scan for JIT code. This drives the located / can't-relocate chip.
      for (const patch of loadedPatches) {
        try {
          const status = await window.tamper.locatePatch(patch)
          setPatchStatuses((prev) => new Map(prev).set(patch.id, status))
          // Re-attaching to a process we already patched: reflect reality.
          if (status.state === 'applied') {
            setPatchEnabled((prev) => new Set(prev).add(patch.id))
          }
        } catch {
          // not attached / transient — leave this patch without a readout
        }
      }
```

The rest of `loadAndRevalidate` (the `for (const cheat of loaded)` verify loop) is unchanged and now runs over value cheats only, which is what `verifyCheat` expects.

- [ ] **Step 3: Add toggle and delete for patches**

Add these functions after the existing `remove` function:

```ts
  async function togglePatch(patch: PatchCheat) {
    const next = !patchEnabled.has(patch.id)
    setPatchError((prev) => {
      const copy = new Map(prev)
      copy.delete(patch.id)
      return copy
    })

    if (next) {
      const result = await window.tamper.applyPatch(patch)
      if (!result.ok) {
        // Stays off: an un-locatable or mismatched patch is never written.
        setPatchError((prev) => new Map(prev).set(patch.id, result.error ?? 'Patch failed'))
        return
      }
      setPatchEnabled((prev) => new Set(prev).add(patch.id))
    } else {
      const ok = await window.tamper.restorePatch(patch)
      if (!ok) {
        setPatchError((prev) => new Map(prev).set(patch.id, 'Restore failed'))
        return
      }
      setPatchEnabled((prev) => {
        const copy = new Set(prev)
        copy.delete(patch.id)
        return copy
      })
    }

    try {
      const status = await window.tamper.locatePatch(patch)
      setPatchStatuses((prev) => new Map(prev).set(patch.id, status))
    } catch {
      // leave the previous readout
    }
  }

  async function removePatch(patch: PatchCheat) {
    // Main restores an applied patch as part of deletion, so the game's code
    // is clean regardless of the toggle state here.
    await window.tamper.deleteCheat(exeName, patch.id)
    setPatches((prev) => prev.filter((p) => p.id !== patch.id))
    setPatchEnabled((prev) => {
      const copy = new Set(prev)
      copy.delete(patch.id)
      return copy
    })
  }
```

- [ ] **Step 4: Render the patch rows**

Insert this block immediately after the closing `</ul>` of the existing cheat list and before the `{cheats.length === 0 && ...}` line:

```tsx
      {patches.length > 0 && (
        <ul>
          {patches.map((patch) => {
            const status = patchStatuses.get(patch.id)
            const error = patchError.get(patch.id)
            return (
              <li key={patch.id} style={{ flexWrap: 'wrap' }}>
                <span>{patch.name}</span>
                <AddressChip
                  label={
                    patch.moduleName
                      ? `${patch.moduleName}+${patch.moduleOffset}`
                      : `AOB ${patch.length}b`
                  }
                  pulsing={patchEnabled.has(patch.id)}
                />
                <span className="address-chip">code patch</span>
                {status && (
                  <span
                    className="address-chip"
                    style={{ color: status.applicable ? 'var(--muted)' : 'var(--error)' }}
                  >
                    {status.applicable ? `located ${status.address}` : "can't relocate"}
                  </span>
                )}
                <Toggle
                  enabled={patchEnabled.has(patch.id)}
                  onChange={() => togglePatch(patch)}
                />
                <button onClick={() => removePatch(patch)}>Delete</button>
                {error && (
                  <span style={{ color: 'var(--error)', flexBasis: '100%' }}>{error}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
```

- [ ] **Step 5: Fix the empty state**

Replace the empty-state line so it accounts for both kinds:

```tsx
      {cheats.length === 0 && patches.length === 0 && (
        <p>No cheats yet for {exeName}. Scan for one to get started.</p>
      )}
```

- [ ] **Step 6: Typecheck, build, full test run**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```

Expected: zero type errors anywhere, renderer + main + preload bundles build, all tests pass (native `patch_ops`, `write_watch`, `scanner`, `pointer`, `memory_ops`, `addon_smoke`; main `store`, `freezeLoop`, `patchEngine`).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/screens/CheatList.tsx
git commit -m "Show patch cheats in the cheat list with locate status and toggle"
```

---

## Manual validation (Valheim)

Automated coverage stops at the harness; the renderer screens have no automated tests (consistent with the rest of the app). Do this pass before considering #6 done:

1. Launch Valheim, attach in Tamper, scan for stamina, narrow to one candidate.
2. "Find what writes this", drain stamina in-game, stop the capture.
3. Type a name, click **Create patch** on a caught instruction.
4. In the cheat list, confirm the patch shows a `located 0x…` chip.
5. Toggle it on — stamina must stop draining, and the game must stay stable.
6. Toggle it off — stamina drains again.
7. Toggle on again, then quit Tamper while the game runs; re-attach with a fresh Tamper and confirm the patch reads as no longer applied (`original`), proving the quit-time restore ran.
8. Restart the game, re-attach, and confirm a module-anchored patch still locates (relocation by module+offset) — and that a JIT-code patch either locates via AOB or honestly reports "can't relocate" rather than patching a guess.

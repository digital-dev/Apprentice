# Code Injection and Persistent Anchors (#7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cheats survive a game restart — redirect a captured instruction through a code cave that either forces a constant into the field or records the object's base pointer, both re-found after a restart by byte-pattern scan.

**Architecture:** Six new native primitives (allocate a cave near an address, decode a displaceable run, encode a store, encode a capture, suspend/resume threads) plus a hand-encoded 5-byte jump. `PatchEngine` composes them in TypeScript over its existing injected `PatchOps` boundary, so every decision — including every refusal — stays testable against a fake process. The existing NOP patch becomes one `mode` of the same cheat kind, and value cheats gain a target type anchored to a captured pointer.

**Tech Stack:** Existing — Electron + electron-vite, React + TypeScript, N-API via `node-addon-api` + `node-gyp` (C++17), Vitest, vendored Zydis (decoder **and** encoder). New Win32 surface — `VirtualAllocEx`, `VirtualQueryEx` over free regions, `SuspendThread`/`ResumeThread`.

## Global Constraints

- Windows only, x86-64. No network calls anywhere in the stack.
- **Safety (non-negotiable):**
  - Never install an injection whose displaced run contains a RIP-relative instruction **or a relative branch** (`jmp`/`jcc`/`call rel32`). Both compute their target from where they sit; moving them to a cave silently changes where they go.
  - Never install when the located bytes don't match the capture, or when relocation is ambiguous (0 or >1 signature matches).
  - Suspend every thread in the target while writing or restoring an injection site.
  - Never free a cave while the process lives.
  - Restore every installed injection on disable, on detach, and on app exit.
- Absent `mode` on a stored patch means `'nop'` — every patch saved by #6 keeps working through the code path it already uses.
- The addon's `Init()` warm-up `Napi::Number::New(env, 0.0)` stays.
- After editing `binding.gyp` sources, run `npx node-gyp configure` before `npx node-gyp build`.
- Stop any running Electron before rebuilding the addon — it locks `memory_addon.node`.
- Rebuild the harness from **PowerShell**, never Bash (Bash silently fails to run vcvars):
  `& cmd.exe /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'`
  then delete the stray `harness.obj` and **verify the timestamp changed** before trusting it.
- Hex conventions: addresses `0x`-prefixed lowercase; byte blobs unspaced lowercase; AOB signatures space-separated `??`-or-hex-pair tokens.

---

## File Structure

```
native/
  src/
    cave_ops.h / cave_ops.cc    # allocateCave, decodeRun, encodeStore,
                                # encodeCapture, encodeJump, suspend/resume
    addon.cc                    # + wire the new exports
  binding.gyp                   # + src/cave_ops.cc
test-harness/
  harness.c                     # + forceloop/stopforce/getforce/setforce
src/
  main/
    nativeAddon.ts              # + typed wrappers
    store.ts                    # + mode/force fields, AnchorTarget union
    patchEngine.ts              # + cave assembly, install/restore per mode
    ipc.ts                      # + anchor resolution for value cheats
  renderer/src/
    tamper.d.ts                 # + new types
    screens/Scanner.tsx         # + mode choice, value box, anchor creation
    screens/CheatList.tsx       # + anchor-backed target display
tests/
  native/cave_ops.test.ts       # primitives + end-to-end force/capture
  main/patchEngine.test.ts      # + install/restore/refusal paths
  main/store.test.ts            # + mode + anchor round-trips
```

---

# STAGE 1 — Cave engine and `force`

### Task 1: Harness gains a forcible field

**Files:**
- Modify: `test-harness/harness.c`
- Rebuild: `test-harness/harness.exe`

**Interfaces:**
- Consumes: nothing.
- Produces: commands `forceloop`, `stopforce`, `setforce <float>`, `getforce` (replies `OK <float>`). Used by Tasks 2, 3, 8, 12.

- [ ] **Step 1: Add the field and its writer**

The existing `wideloop`/`watchloop` writers are unsuitable: an injection test needs a field whose value the test can *read back* to prove a constant was forced. Add next to the other globals:

```c
float g_force_value = 10.0f; // cave_ops.test.ts forces a constant into this
static volatile int g_force_running = 0;
```

and, inside a `#pragma optimize("", off)` block:

```c
// Writes through a runtime pointer argument so the store is
// `movss [reg+disp], xmm` — the shape a real game object write has, and
// the shape an injection displaces. A RIP-relative store to a known
// global would be refused by decodeRun and could never be injected.
static void force_write(float* p, float v) {
  *p = v;
}
static unsigned __stdcall force_thread(void* arg) {
  (void)arg;
  float v = 0.0f;
  while (g_force_running) {
    force_write(&g_force_value, v);
    v += 1.0f;
    Sleep(10);
  }
  return 0;
}
```

- [ ] **Step 2: Add the commands**

In `main`'s command chain, before the generic `else`. Note `setforce`/`getforce` must precede any shorter prefix that could swallow them — `set %d`/`setf %f`/`setp %f` all fail to parse `setforce 5`, and `get` is checked later in the chain, so appending here is safe:

```c
    } else if (sscanf(line, "setforce %f", &fval) == 1) {
      g_force_value = fval;
      printf("OK\n");
    } else if (strncmp(line, "getforce", 8) == 0) {
      printf("OK %f\n", g_force_value);
    } else if (strncmp(line, "forceloop", 9) == 0) {
      if (!g_force_running) {
        g_force_running = 1;
        _beginthreadex(NULL, 0, force_thread, NULL, 0, NULL);
      }
      printf("OK\n");
    } else if (strncmp(line, "stopforce", 9) == 0) {
      g_force_running = 0;
      printf("OK\n");
```

- [ ] **Step 3: Rebuild and verify by hand**

Rebuild per the Global Constraints command, then:

```bash
printf 'getforce\nforceloop\ngetforce\nstopforce\nq\n' | ./test-harness/harness.exe
```

Expected: `OK 10.000000`, `OK`, `OK <a changing value>`, `OK`. Confirm `harness.exe`'s timestamp changed.

- [ ] **Step 4: Commit**

```bash
git add test-harness/harness.c test-harness/harness.exe
git commit -m "Add forceloop harness commands for injection tests"
```

---

### Task 2: allocateCave and decodeRun

**Files:**
- Create: `native/src/cave_ops.h`, `native/src/cave_ops.cc`
- Modify: `native/binding.gyp`, `native/src/addon.cc`
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Consumes: harness `forceloop` (Task 1); existing `attach`, `scanFirst`/`scanNext`, write-watch exports.
- Produces:
  - `allocateCave(handle, nearAddress): string | null` — 4KB `PAGE_EXECUTE_READWRITE` page within ±2GB, or null.
  - `decodeRun(handle, address, minBytes): { length: number, decodable: boolean, relocatable: boolean }` — `length` covers whole instructions totalling ≥ `minBytes`; `relocatable` is false if any instruction in the run is RIP-relative or a relative branch.

- [ ] **Step 1: Write the failing test**

Create `tests/native/cave_ops.test.ts`:

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

// The address of a real instruction in the harness, used as the "near"
// reference for cave allocation and as decode input.
async function anInstructionAddress(): Promise<string> {
  const base = (addon as any).attach(harness.pid).baseAddress
  return base
}

describe('allocateCave', () => {
  it('allocates a page within reach of a 32-bit relative jump', async () => {
    const near = await anInstructionAddress()
    const cave: string | null = (addon as any).allocateCave(handle, near)
    expect(cave).not.toBeNull()

    const distance =
      BigInt(cave as string) > BigInt(near)
        ? BigInt(cave as string) - BigInt(near)
        : BigInt(near) - BigInt(cave as string)
    // rel32 reaches ±2GB; anything further cannot be jumped to.
    expect(distance < 2n ** 31n).toBe(true)
  })

  it('returns a writable, readable page', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    expect((addon as any).writeBytes(handle, cave, '9090909090')).toBe(true)
    expect((addon as any).readBytes(handle, cave, 5)).toBe('9090909090')
  })
})

describe('decodeRun', () => {
  it('covers whole instructions totalling at least the requested bytes', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // Three 2-byte instructions (89 01 = mov [rcx],eax). Asking for 5 bytes
    // must round UP to 6 — a whole number of instructions — because
    // displacing half an instruction is what corrupts a game. Written into
    // scratch memory rather than decoded at some address we hope is code, so
    // the expectation is exact rather than conditional.
    ;(addon as any).writeBytes(handle, scratch, '890189018901')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.length).toBe(6)
  })

  it('reports a relative branch as not relocatable', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    // E9 00 00 00 00 = jmp +0, a relative branch; moving it changes where
    // it goes, so a run containing it must never be displaced.
    const scratch: string = (addon as any).allocateCave(handle, near)
    ;(addon as any).writeBytes(handle, scratch, 'e900000000')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.relocatable).toBe(false)
  })

  it('reports a plain register store as relocatable', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // f3 0f 11 47 10 = movss [rdi+0x10], xmm0 — no RIP, no branch.
    ;(addon as any).writeBytes(handle, scratch, 'f30f114710')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.relocatable).toBe(true)
    expect(result.length).toBe(5)
  })

  it('reports RIP-relative code as not relocatable', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // 48 8b 05 00 00 00 00 = mov rax, [rip+0]
    ;(addon as any).writeBytes(handle, scratch, '488b0500000000')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.relocatable).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/native/cave_ops.test.ts
```

Expected: FAIL — `addon.allocateCave is not a function`.

- [ ] **Step 3: Create the header**

`native/src/cave_ops.h`:

```cpp
#pragma once
#include <napi.h>

Napi::Value AllocateCave(const Napi::CallbackInfo& info);
Napi::Value DecodeRun(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: Implement**

Create `native/src/cave_ops.cc`:

```cpp
#include "cave_ops.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstdio>
#include "Zydis.h"

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)v);
  return buf;
}

constexpr SIZE_T kCaveSize = 4096;
// A 5-byte `jmp rel32` reaches ±2GB. Staying inside that is why the cave has
// to be allocated near the site rather than wherever Windows feels like.
constexpr uintptr_t kJumpReach = 0x7FFF0000;

// Walks free regions outward from `near` and commits the first page that is
// within jump reach. Windows allocates on 64KB granularity, so candidates
// are aligned to that rather than to the page size.
uintptr_t AllocateNear(HANDLE h, uintptr_t near) {
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  const uintptr_t granularity = si.dwAllocationGranularity;

  uintptr_t low = (near > kJumpReach) ? near - kJumpReach : 0;
  uintptr_t high = near + kJumpReach;

  // Search upward first, then downward: either direction is equally valid,
  // and most processes have free space above their modules.
  for (int direction = 0; direction < 2; direction++) {
    uintptr_t addr = near;
    while (addr >= low && addr <= high) {
      MEMORY_BASIC_INFORMATION mbi;
      if (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) != sizeof(mbi)) break;

      if (mbi.State == MEM_FREE && mbi.RegionSize >= kCaveSize) {
        uintptr_t candidate =
            ((uintptr_t)mbi.BaseAddress + granularity - 1) & ~(granularity - 1);
        if (candidate >= low && candidate <= high &&
            candidate + kCaveSize <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize) {
          LPVOID got = VirtualAllocEx(h, (LPVOID)candidate, kCaveSize,
                                      MEM_RESERVE | MEM_COMMIT,
                                      PAGE_EXECUTE_READWRITE);
          if (got) return (uintptr_t)got;
        }
      }

      if (direction == 0) {
        uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
        if (next <= addr) break;
        addr = next;
      } else {
        if ((uintptr_t)mbi.BaseAddress < granularity) break;
        addr = (uintptr_t)mbi.BaseAddress - granularity;
      }
    }
  }
  return 0;
}

// True if this instruction computes anything from where it sits, and would
// therefore mean something different after being moved into a cave.
bool IsPositionDependent(const ZydisDecodedInstruction& insn,
                         const ZydisDecodedOperand* ops) {
  for (int i = 0; i < insn.operand_count; i++) {
    const ZydisDecodedOperand& op = ops[i];
    if (op.type == ZYDIS_OPERAND_TYPE_MEMORY && op.mem.base == ZYDIS_REGISTER_RIP)
      return true;
    // Relative branches encode a displacement from the NEXT instruction, so
    // relocating one silently retargets it. Zydis marks these operands.
    if (op.type == ZYDIS_OPERAND_TYPE_IMMEDIATE && op.imm.is_relative) return true;
  }
  return false;
}

} // namespace

Napi::Value AllocateCave(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t near = ParseHex(info[1].As<Napi::String>().Utf8Value());

  uintptr_t cave = AllocateNear(h, near);
  if (!cave) return env.Null();
  return Napi::String::New(env, ToHex(cave));
}

Napi::Value DecodeRun(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  size_t minBytes = (size_t)info[2].As<Napi::Number>().Uint32Value();

  uint8_t window[64] = {0};
  SIZE_T got = 0;
  ReadProcessMemory(h, (LPCVOID)address, window, sizeof(window), &got);

  ZydisDecoder decoder;
  ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);

  size_t offset = 0;
  bool relocatable = true;
  bool decodable = true;
  while (offset < minBytes) {
    ZydisDecodedInstruction insn;
    ZydisDecodedOperand ops[ZYDIS_MAX_OPERAND_COUNT];
    if (offset >= got ||
        !ZYAN_SUCCESS(ZydisDecoderDecodeFull(&decoder, window + offset,
                                             got - offset, &insn, ops))) {
      decodable = false;
      break;
    }
    if (IsPositionDependent(insn, ops)) relocatable = false;
    offset += insn.length;
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("length", Napi::Number::New(env, (double)offset));
  result.Set("decodable", Napi::Boolean::New(env, decodable));
  result.Set("relocatable", Napi::Boolean::New(env, decodable && relocatable));
  return result;
}
```

- [ ] **Step 5: Wire the build and exports**

Add `"src/cave_ops.cc"` to `binding.gyp` sources. In `addon.cc`, add `#include "cave_ops.h"` and, in `Init`:

```cpp
  exports.Set("allocateCave", Napi::Function::New(env, AllocateCave));
  exports.Set("decodeRun", Napi::Function::New(env, DecodeRun));
```

- [ ] **Step 6: Configure, build, test**

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
npx vitest run tests/native/cave_ops.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add native tests/native/cave_ops.test.ts
git commit -m "Add cave allocation and displaceable-run decoding"
```

---

### Task 3: Instruction encoders

**Files:**
- Modify: `native/src/cave_ops.h`, `native/src/cave_ops.cc`, `native/src/addon.cc`
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Consumes: Task 2's file and build wiring.
- Produces:
  - `encodeStore(baseRegister: string, offset: number, imm32: number): string` — `mov dword ptr [reg+offset], imm32`, unspaced lowercase hex.
  - `encodeJump(from: string, to: string): string` — the 5-byte `jmp rel32`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/native/cave_ops.test.ts`:

```ts
describe('encodeJump', () => {
  it('encodes a 5-byte relative jump', () => {
    // From 0x1000 to 0x1010: rel32 = to - (from + 5) = 0x0b.
    const hex: string = (addon as any).encodeJump('0x1000', '0x1010')
    expect(hex).toBe('e90b000000')
  })

  it('encodes a backward jump', () => {
    // From 0x1010 to 0x1000: rel32 = -0x15 = 0xffffffeb.
    const hex: string = (addon as any).encodeJump('0x1010', '0x1000')
    expect(hex).toBe('e9ebffffff')
  })
})

describe('encodeStore', () => {
  it('encodes mov dword ptr [rdi+offset], imm32', () => {
    // C7 87 <disp32> <imm32> — the canonical encoding for this form.
    const hex: string = (addon as any).encodeStore('rdi', 0x818, 0x43af0000)
    expect(hex).toBe('c78718080000' + '0000af43')
  })

  it('round-trips through the decoder as the instruction we meant', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    const hex: string = (addon as any).encodeStore('rcx', 0x10, 1234)
    ;(addon as any).writeBytes(handle, scratch, hex)
    // It must decode as one whole, relocatable instruction of exactly the
    // length we produced — proof we emitted a real instruction, not bytes
    // that merely look plausible.
    const run = (addon as any).decodeRun(handle, scratch, 1)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown register instead of encoding nonsense', () => {
    expect(() => (addon as any).encodeStore('notareg', 0, 0)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/native/cave_ops.test.ts -t encode
```

Expected: FAIL — `addon.encodeJump is not a function`.

- [ ] **Step 3: Declare**

In `native/src/cave_ops.h`:

```cpp
Napi::Value EncodeStore(const Napi::CallbackInfo& info);
Napi::Value EncodeJump(const Napi::CallbackInfo& info);
```

- [ ] **Step 4: Implement**

Add to `cave_ops.cc`'s anonymous namespace:

```cpp
std::string BytesToHex(const uint8_t* data, size_t len) {
  std::string out;
  char hb[4];
  for (size_t i = 0; i < len; i++) {
    snprintf(hb, sizeof(hb), "%02x", data[i]);
    out += hb;
  }
  return out;
}

// Only the 16 general-purpose 64-bit registers can hold an object pointer,
// so an unknown name is a caller bug, not something to guess at.
ZydisRegister RegisterByName(const std::string& name) {
  static const struct { const char* name; ZydisRegister reg; } kMap[] = {
    {"rax", ZYDIS_REGISTER_RAX}, {"rbx", ZYDIS_REGISTER_RBX},
    {"rcx", ZYDIS_REGISTER_RCX}, {"rdx", ZYDIS_REGISTER_RDX},
    {"rsi", ZYDIS_REGISTER_RSI}, {"rdi", ZYDIS_REGISTER_RDI},
    {"rbp", ZYDIS_REGISTER_RBP}, {"rsp", ZYDIS_REGISTER_RSP},
    {"r8", ZYDIS_REGISTER_R8},   {"r9", ZYDIS_REGISTER_R9},
    {"r10", ZYDIS_REGISTER_R10}, {"r11", ZYDIS_REGISTER_R11},
    {"r12", ZYDIS_REGISTER_R12}, {"r13", ZYDIS_REGISTER_R13},
    {"r14", ZYDIS_REGISTER_R14}, {"r15", ZYDIS_REGISTER_R15},
  };
  for (const auto& e : kMap) if (name == e.name) return e.reg;
  return ZYDIS_REGISTER_NONE;
}
```

and the exported functions after the namespace:

```cpp
// Hand-encoded rather than routed through Zydis: `jmp rel32` is one opcode
// and a signed displacement from the END of the instruction, and encoding it
// directly keeps the arithmetic visible at the one place it matters.
Napi::Value EncodeJump(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uintptr_t from = ParseHex(info[0].As<Napi::String>().Utf8Value());
  uintptr_t to = ParseHex(info[1].As<Napi::String>().Utf8Value());

  int64_t rel = (int64_t)to - (int64_t)(from + 5);
  if (rel > INT32_MAX || rel < INT32_MIN) {
    Napi::Error::New(env, "jump target out of rel32 range")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int32_t rel32 = (int32_t)rel;
  uint8_t bytes[5];
  bytes[0] = 0xE9;
  memcpy(bytes + 1, &rel32, sizeof(rel32));
  return Napi::String::New(env, BytesToHex(bytes, sizeof(bytes)));
}

Napi::Value EncodeStore(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string regName = info[0].As<Napi::String>().Utf8Value();
  int64_t offset = info[1].As<Napi::Number>().Int64Value();
  uint32_t imm = info[2].As<Napi::Number>().Uint32Value();

  ZydisRegister reg = RegisterByName(regName);
  if (reg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown base register").ThrowAsJavaScriptException();
    return env.Null();
  }

  ZydisEncoderRequest req;
  memset(&req, 0, sizeof(req));
  req.mnemonic = ZYDIS_MNEMONIC_MOV;
  req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  req.operand_count = 2;
  req.operands[0].type = ZYDIS_OPERAND_TYPE_MEMORY;
  req.operands[0].mem.base = reg;
  req.operands[0].mem.displacement = offset;
  req.operands[0].mem.size = 4; // dword: int32 and float alike
  req.operands[1].type = ZYDIS_OPERAND_TYPE_IMMEDIATE;
  req.operands[1].imm.u = imm;

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  ZyanUSize len = sizeof(buf);
  if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
    Napi::Error::New(env, "failed to encode store").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, BytesToHex(buf, (size_t)len));
}
```

Add `#include <cstring>` for `memcpy` if not already present.

- [ ] **Step 5: Wire exports, build, test**

In `addon.cc`'s `Init`:

```cpp
  exports.Set("encodeStore", Napi::Function::New(env, EncodeStore));
  exports.Set("encodeJump", Napi::Function::New(env, EncodeJump));
```

```bash
cd native && npx node-gyp build && cd ..
npx vitest run tests/native/cave_ops.test.ts
```

Expected: PASS. If `encodeStore`'s exact bytes differ from the test's expectation (a valid encoder may pick a different but equivalent form), verify the round-trip test passes and update the byte-literal expectation to what Zydis actually emits — the round-trip is the real contract; note the change in the commit message.

- [ ] **Step 6: Commit**

```bash
git add native tests/native/cave_ops.test.ts
git commit -m "Encode the forcing store and the trampoline jump"
```

---

### Task 4: Thread suspension

**Files:**
- Modify: `native/src/cave_ops.h`, `native/src/cave_ops.cc`, `native/src/addon.cc`
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Produces: `suspendThreads(pid): number` (count suspended, throws on failure after resuming whatever it suspended), `resumeThreads(): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/cave_ops.test.ts`:

```ts
describe('suspendThreads / resumeThreads', () => {
  it('freezes the target and lets it run again', async () => {
    await send('forceloop')
    await sleep(100)

    const count: number = (addon as any).suspendThreads(harness.pid)
    expect(count).toBeGreaterThan(0)

    // Frozen: the writer thread cannot advance the value.
    const before = (addon as any).readBytes(handle, forceAddress, 4)
    await sleep(200)
    const during = (addon as any).readBytes(handle, forceAddress, 4)
    expect(during).toBe(before)

    ;(addon as any).resumeThreads()
    await sleep(200)
    const after = (addon as any).readBytes(handle, forceAddress, 4)
    expect(after).not.toBe(during)

    await send('stopforce')
  }, 15000)
})
```

Add above the describe blocks, alongside the other helpers, a cached resolver for the forced field (the same caching reason as `write_watch.test.ts`: the scan keys off the initial value, which the first test to run overwrites):

```ts
let forceAddress: string

beforeAll(async () => {
  let candidates = await (addon as any).scanFirst(handle, 'float', 10.0)
  await send('setforce 4242')
  candidates = (addon as any).scanNext(handle, candidates, 'float', {
    mode: 'exact',
    value: 4242
  })
  expect(candidates.length).toBe(1)
  forceAddress = candidates[0].address
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/native/cave_ops.test.ts -t suspendThreads
```

Expected: FAIL — `addon.suspendThreads is not a function`.

- [ ] **Step 3: Implement**

Declare in `cave_ops.h`:

```cpp
Napi::Value SuspendThreads(const Napi::CallbackInfo& info);
Napi::Value ResumeThreads(const Napi::CallbackInfo& info);
```

In `cave_ops.cc`, add to the anonymous namespace:

```cpp
// Handles of threads suspended by the last SuspendThreads call. A process
// global, matching the addon's existing one-target-at-a-time model: Tamper
// is attached to a single game, and an injection is installed under one
// suspension at a time.
std::vector<HANDLE> g_suspended;
```

and the exports:

```cpp
Napi::Value SuspendThreads(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snap == INVALID_HANDLE_VALUE) {
    Napi::Error::New(env, "CreateToolhelp32Snapshot failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  THREADENTRY32 te{};
  te.dwSize = sizeof(te);
  bool failed = false;
  if (Thread32First(snap, &te)) {
    do {
      if (te.th32OwnerProcessID != pid) continue;
      HANDLE th = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te.th32ThreadID);
      if (!th) { failed = true; break; }
      if (SuspendThread(th) == (DWORD)-1) {
        CloseHandle(th);
        failed = true;
        break;
      }
      g_suspended.push_back(th);
    } while (Thread32Next(snap, &te));
  }
  CloseHandle(snap);

  // All or nothing: a half-suspended target must never be written to, so
  // undo the partial suspension before reporting failure.
  if (failed) {
    for (HANDLE th : g_suspended) { ResumeThread(th); CloseHandle(th); }
    g_suspended.clear();
    Napi::Error::New(env, "failed to suspend every thread")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::Number::New(env, (double)g_suspended.size());
}

Napi::Value ResumeThreads(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  for (HANDLE th : g_suspended) { ResumeThread(th); CloseHandle(th); }
  g_suspended.clear();
  return env.Undefined();
}
```

`<tlhelp32.h>` must be included at the top of `cave_ops.cc`.

- [ ] **Step 4: Wire, build, test**

```cpp
  exports.Set("suspendThreads", Napi::Function::New(env, SuspendThreads));
  exports.Set("resumeThreads", Napi::Function::New(env, ResumeThreads));
```

```bash
cd native && npx node-gyp build && cd ..
npx vitest run tests/native/cave_ops.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native tests/native/cave_ops.test.ts
git commit -m "Add all-or-nothing thread suspension for injection sites"
```

---

### Task 5: Storage modes and typed wrappers

**Files:**
- Modify: `src/main/store.ts`, `src/main/nativeAddon.ts`
- Test: `tests/main/store.test.ts`

**Interfaces:**
- Produces:
  - `PatchCheat` gains `mode?: 'nop' | 'force' | 'capture'`, `baseRegister?`, `fieldOffset?`, `value?`, `dataType?`.
  - `patchMode(patch): 'nop' | 'force' | 'capture'` — absent means `'nop'`.
  - `nativeAddon.allocateCave/decodeRun/encodeStore/encodeJump/suspendThreads/resumeThreads`.

- [ ] **Step 1: Write the failing store tests**

Append to `tests/main/store.test.ts`:

```ts
describe('store — patch modes', () => {
  const forcePatch: PatchCheat = {
    kind: 'patch',
    mode: 'force',
    id: 'patch-stamina',
    name: 'Stamina',
    originalBytes: 'f30f11af18080000',
    length: 8,
    signature: 'f3 0f 11 af 18 08 00 00',
    moduleName: null,
    moduleOffset: null,
    baseRegister: 'rdi',
    fieldOffset: '0x818',
    value: 350,
    dataType: 'float'
  }

  it('round-trips a force patch with its value and register', () => {
    saveCheat('valheim.exe', forcePatch)
    const loaded = loadCheats('valheim.exe').filter(isPatchCheat)[0]
    expect(loaded.mode).toBe('force')
    expect(loaded.baseRegister).toBe('rdi')
    expect(loaded.value).toBe(350)
    expect(loaded.dataType).toBe('float')
  })

  it('treats a patch with no mode as a NOP patch', () => {
    const legacy: PatchCheat = { ...forcePatch, id: 'patch-legacy' }
    delete (legacy as Partial<PatchCheat>).mode
    saveCheat('valheim.exe', legacy)
    const loaded = loadCheats('valheim.exe').filter(isPatchCheat)
      .find((p) => p.id === 'patch-legacy') as PatchCheat
    expect(patchMode(loaded)).toBe('nop')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/main/store.test.ts
```

Expected: FAIL — `patchMode` is not exported.

- [ ] **Step 3: Extend the store**

In `src/main/store.ts`, extend `PatchCheat` and add the helper:

```ts
export interface PatchCheat {
  kind: 'patch'
  // How this patch changes the game. Absent means 'nop': every patch saved
  // before injection existed keeps working through the same code path.
  mode?: 'nop' | 'force' | 'capture'
  id: string
  name: string
  originalBytes: string
  length: number
  signature: string
  moduleName: string | null
  moduleOffset: string | null
  // force and capture: which register held the object at capture time.
  baseRegister?: string
  // force only: where the field sits relative to that register, what to
  // write, and how to turn `value` into the 32 bits that get written.
  fieldOffset?: string
  value?: number
  dataType?: DataType
}

export function patchMode(patch: PatchCheat): 'nop' | 'force' | 'capture' {
  return patch.mode ?? 'nop'
}
```

- [ ] **Step 4: Add the native wrappers**

In `src/main/nativeAddon.ts`, after the existing patch wrappers:

```ts
  allocateCave: (handle: number, nearAddress: string): string | null =>
    addon.allocateCave(handle, nearAddress),
  decodeRun: (
    handle: number,
    address: string,
    minBytes: number
  ): { length: number; decodable: boolean; relocatable: boolean } =>
    addon.decodeRun(handle, address, minBytes),
  encodeStore: (baseRegister: string, offset: number, imm32: number): string =>
    addon.encodeStore(baseRegister, offset, imm32),
  encodeJump: (from: string, to: string): string => addon.encodeJump(from, to),
  suspendThreads: (pid: number): number => addon.suspendThreads(pid),
  resumeThreads: (): void => addon.resumeThreads(),
```

- [ ] **Step 5: Verify**

```bash
npx vitest run tests/main/store.test.ts && npx tsc --noEmit
```

Expected: PASS and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/store.ts src/main/nativeAddon.ts tests/main/store.test.ts
git commit -m "Add patch modes and cave primitives to the TypeScript layer"
```

---

### Task 6: Install and restore an injection

**Files:**
- Modify: `src/main/patchEngine.ts`
- Test: `tests/main/patchEngine.test.ts`

**Interfaces:**
- Consumes: Task 5's storage and wrappers.
- Produces: `PatchOps` gains `allocateCave`, `decodeRun`, `encodeStore`, `encodeJump`, `suspendThreads`, `resumeThreads`. `PatchEngine.apply` installs per mode; `restore` reverses it. `AppliedPatch` gains `caveAddress`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/patchEngine.test.ts`. Extend `FakeOps` with the new operations, modelling a cave as ordinary memory:

```ts
class FakeOps implements PatchOps {
  // ...existing members...
  caves: string[] = []
  nextCave = 0x50000000
  suspended = 0
  resumed = 0
  runLength = 5
  runDecodable = true
  runRelocatable = true

  allocateCave(): string | null {
    const address = '0x' + (this.nextCave += 0x1000).toString(16)
    this.caves.push(address)
    return address
  }
  decodeRun(): { length: number; decodable: boolean; relocatable: boolean } {
    return {
      length: this.runLength,
      decodable: this.runDecodable,
      relocatable: this.runRelocatable
    }
  }
  encodeStore(): string {
    return 'c78718080000' + '0000af43' // mov [rdi+0x818], 350.0f
  }
  encodeJump(): string {
    return 'e900000000'
  }
  suspendThreads(): number {
    this.suspended++
    return 4
  }
  resumeThreads(): void {
    this.resumed++
  }
}

const forcePatch: PatchCheat = {
  kind: 'patch',
  mode: 'force',
  id: 'patch-stamina',
  name: 'Stamina',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.exe',
  moduleOffset: '0x100',
  baseRegister: 'rdi',
  fieldOffset: '0x818',
  value: 350,
  dataType: 'float'
}

describe('PatchEngine — force injection', () => {
  it('writes a jump at the site and leaves the cave holding the original bytes', async () => {
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(true)

    // The site now begins with a jump, padded to the displaced run length.
    const site = ops.memory.get('0x400100') as string
    expect(site.startsWith('e9')).toBe(true)
    expect(site.length / 2).toBe(5)

    // The cave carries the displaced original so the game's own write still
    // happens before ours.
    const cave = ops.memory.get(ops.caves[0]) as string
    expect(cave.includes(ORIGINAL)).toBe(true)
  })

  it('suspends threads around the site write and resumes them', async () => {
    await engine.apply(forcePatch)
    expect(ops.suspended).toBe(1)
    expect(ops.resumed).toBe(1)
  })

  it('refuses when the displaced run cannot be relocated', async () => {
    ops.runRelocatable = false
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('own address')
    expect(ops.writes).toHaveLength(0)
    expect(engine.isApplied('patch-stamina')).toBe(false)
  })

  it('refuses when the run cannot be decoded', async () => {
    ops.runDecodable = false
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses when no cave can be allocated', async () => {
    ops.allocateCave = () => null
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('memory')
    expect(ops.writes).toHaveLength(0)
  })

  it('resumes threads even when the site write fails', async () => {
    // The cave write succeeds, the site write does not: threads must not be
    // left suspended, or the game is frozen forever.
    let writes = 0
    const realWrite = ops.writeBytes.bind(ops)
    ops.writeBytes = (address: string, hex: string) => {
      writes++
      return writes === 1 ? realWrite(address, hex) : false
    }
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(ops.resumed).toBe(1)
    expect(engine.isApplied('patch-stamina')).toBe(false)
  })

  it('restores the original bytes and keeps the cave allocated', async () => {
    await engine.apply(forcePatch)
    expect(engine.restore(forcePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
    // Caves are never freed: a thread suspended inside one must still have
    // valid code to return through.
    expect(ops.caves).toHaveLength(1)
  })

  it('still NOPs when the patch has no mode', async () => {
    const legacy = { ...forcePatch, id: 'patch-legacy' } as PatchCheat
    delete (legacy as Partial<PatchCheat>).mode
    const result = await engine.apply(legacy)
    expect(result.ok).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(NOPS)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/main/patchEngine.test.ts -t "force injection"
```

Expected: FAIL — `ops.allocateCave is not a function` / apply still NOPs.

- [ ] **Step 3: Extend PatchOps and the applied-set**

In `src/main/patchEngine.ts`:

```ts
export interface PatchOps {
  getModuleBase(moduleName: string): string | null
  readBytes(address: string, length: number): string | null
  writeBytes(address: string, hexBytes: string): boolean
  scanAob(signature: string): Promise<string[]>
  allocateCave(nearAddress: string): string | null
  decodeRun(
    address: string,
    minBytes: number
  ): { length: number; decodable: boolean; relocatable: boolean }
  encodeStore(baseRegister: string, offset: number, imm32: number): string
  encodeJump(from: string, to: string): string
  suspendThreads(): number
  resumeThreads(): void
}

interface AppliedPatch {
  address: string
  originalBytes: string
  // Kept for diagnostics and for capture-mode readers; never freed.
  caveAddress: string | null
}
```

- [ ] **Step 4: Implement installation**

Add to `patchEngine.ts`, above the class:

```ts
// A 5-byte `jmp rel32` is the smallest redirect that reaches anywhere in
// range, so the site must give up at least that many bytes — always whole
// instructions, which is what decodeRun computes.
const JUMP_LENGTH = 5

// `value` becomes the exact 32 bits the injected store writes. A float has
// to go through its IEEE-754 bit pattern: 350.0 is 0x43af0000, and writing
// the integer 350 instead would land as a denormal fraction in the game.
export function valueBits(value: number, dataType: DataType): number {
  if (dataType === 'float') {
    const buffer = new ArrayBuffer(4)
    new DataView(buffer).setFloat32(0, value, true)
    return new DataView(buffer).getUint32(0, true)
  }
  return value >>> 0
}
```

and replace the write step inside `apply` (the `status.state === 'original'` branch) with a mode switch:

```ts
    if (status.state === 'original') {
      const mode = patchMode(patch)
      const installed =
        mode === 'nop'
          ? this.installNop(patch, status.address)
          : this.installInjection(patch, status.address)
      if (!installed.ok) return installed
      caveAddress = installed.caveAddress
    }
```

with the helpers as private methods:

```ts
  private installNop(patch: PatchCheat, address: string): InstallResult {
    if (!this.ops.writeBytes(address, nopHex(patch.length))) {
      return { ok: false, error: 'Write failed — the patch was not applied.', caveAddress: null }
    }
    return { ok: true, error: null, caveAddress: null }
  }

  // Build the cave first, while nothing is redirected into it, then swap the
  // site under suspension. Ordering matters: a jump installed before its
  // cave holds valid code sends the game into garbage.
  private installInjection(patch: PatchCheat, address: string): InstallResult {
    const run = this.ops.decodeRun(address, JUMP_LENGTH)
    if (!run.decodable) {
      return {
        ok: false,
        error: "Couldn't read enough whole instructions at that address to redirect it.",
        caveAddress: null
      }
    }
    if (!run.relocatable) {
      return {
        ok: false,
        error:
          "This instruction sits with code that refers to its own address, so moving it would change what it does. Try a different caught instruction.",
        caveAddress: null
      }
    }

    const displaced = this.ops.readBytes(address, run.length)
    if (displaced === null) {
      return { ok: false, error: 'That memory became unreadable.', caveAddress: null }
    }

    const cave = this.ops.allocateCave(address)
    if (cave === null) {
      return {
        ok: false,
        error: "No memory available near the instruction to hold the injected code.",
        caveAddress: null
      }
    }

    // The slot occupies the first 8 bytes so capture mode can find it at a
    // fixed offset; code starts after it in both modes, so the layout is the
    // same whichever mode installed the cave.
    const codeAddress = addHex(cave, 8)
    const effect = this.ops.encodeStore(
      patch.baseRegister as string,
      Number(BigInt(patch.fieldOffset as string)),
      valueBits(patch.value as number, patch.dataType as DataType)
    )
    const returnTo = addHex(address, run.length)
    const jumpBackFrom = addHex(codeAddress, displaced.length / 2 + effect.length / 2)
    const body = displaced + effect + this.ops.encodeJump(jumpBackFrom, returnTo)

    if (!this.ops.writeBytes(codeAddress, body)) {
      return { ok: false, error: 'Failed to write the injected code.', caveAddress: null }
    }

    const jump = this.ops.encodeJump(address, codeAddress)
    const padded = jump + nopHex(run.length - JUMP_LENGTH)

    this.ops.suspendThreads()
    try {
      if (!this.ops.writeBytes(address, padded)) {
        return { ok: false, error: 'Failed to redirect the instruction.', caveAddress: null }
      }
    } finally {
      // Always resume: a target left suspended is a hung game, which is
      // worse than a failed patch.
      this.ops.resumeThreads()
    }
    return { ok: true, error: null, caveAddress: cave }
  }
```

with the supporting type and helper:

```ts
interface InstallResult {
  ok: boolean
  error: string | null
  caveAddress: string | null
}

function addHex(address: string, delta: number): string {
  return '0x' + (BigInt(address) + BigInt(delta)).toString(16)
}
```

`restore` also needs suspension, since it rewrites the same bytes:

```ts
  restore(patch: PatchCheat): boolean {
    const entry = this.applied.get(patch.id)
    if (!entry) return true
    this.ops.suspendThreads()
    let ok: boolean
    try {
      ok = this.ops.writeBytes(entry.address, entry.originalBytes)
    } finally {
      this.ops.resumeThreads()
    }
    if (ok) this.applied.delete(patch.id)
    return ok
  }
```

Import `patchMode` and `DataType` from `./store`. `restoreAll` keeps its existing best-effort behaviour but should suspend once around the whole loop rather than per patch — add that.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/main/patchEngine.test.ts
```

Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add src/main/patchEngine.ts tests/main/patchEngine.test.ts
git commit -m "Install and restore code-cave injections under thread suspension"
```

---

### Task 7: Wire injection through IPC and the capture panel

**Files:**
- Modify: `src/main/ipc.ts`, `src/renderer/src/tamper.d.ts`, `src/renderer/src/screens/Scanner.tsx`

**Interfaces:**
- Consumes: Task 6's engine.
- Produces: `patchOps` supplies the six new operations; the capture panel writes `mode`, `baseRegister`, `fieldOffset`, `value`, `dataType` into saved patches.

- [ ] **Step 1: Supply the new ops**

In `src/main/ipc.ts`, extend the `patchOps` object. Each reads the current `attachedHandle`/`attachedPid` per call, as the existing members do:

```ts
  allocateCave: (nearAddress) =>
    attachedHandle === null ? null : nativeAddon.allocateCave(attachedHandle, nearAddress),
  decodeRun: (address, minBytes) =>
    attachedHandle === null
      ? { length: 0, decodable: false, relocatable: false }
      : nativeAddon.decodeRun(attachedHandle, address, minBytes),
  encodeStore: (baseRegister, offset, imm32) =>
    nativeAddon.encodeStore(baseRegister, offset, imm32),
  encodeJump: (from, to) => nativeAddon.encodeJump(from, to),
  suspendThreads: () => (attachedPid === null ? 0 : nativeAddon.suspendThreads(attachedPid)),
  resumeThreads: () => nativeAddon.resumeThreads()
```

- [ ] **Step 2: Extend the renderer types**

In `src/renderer/src/tamper.d.ts`, nothing new is needed for IPC — patches travel as `PatchCheat`, which already carries the new optional fields through the type re-export from `../../main/store`. Confirm with `npx tsc --noEmit` after Step 3 rather than adding declarations speculatively.

- [ ] **Step 3: Add the mode choice to the capture panel**

In `src/renderer/src/screens/Scanner.tsx`, add state beside `captureName`:

```tsx
  const [patchModeChoice, setPatchModeChoice] = useState<'nop' | 'force'>('nop')
  const [forceValue, setForceValue] = useState('')
```

and replace `createPatchFromInstruction`'s cheat construction so it carries the mode:

```tsx
    const patch: PatchCheat = {
      kind: 'patch',
      mode: patchModeChoice,
      id: `patch-${captureName.toLowerCase().replace(/\s+/g, '-')}`,
      name: captureName,
      originalBytes: insn.bytes,
      length: insn.length,
      signature: insn.signature,
      moduleName: insn.moduleName,
      moduleOffset: insn.moduleOffset,
      ...(patchModeChoice === 'force'
        ? {
            baseRegister: insn.baseRegister,
            fieldOffset: insn.displacement,
            value: Number(forceValue),
            dataType
          }
        : {})
    }
```

In the caught-instruction list, render the mode selector once above the rows:

```tsx
      {caught.length > 0 && (
        <div>
          <select
            value={patchModeChoice}
            onChange={(e) => setPatchModeChoice(e.target.value as 'nop' | 'force')}
          >
            <option value="nop">Disable this write</option>
            <option value="force">Force a value</option>
          </select>
          {patchModeChoice === 'force' && (
            <input
              placeholder={`Value to force (${dataType})`}
              value={forceValue}
              onChange={(e) => setForceValue(e.target.value)}
            />
          )}
        </div>
      )}
```

and extend the Create patch button's `disabled` so force mode requires a value and a base register — a forcing store needs a register to address the field through:

```tsx
                  disabled={
                    !captureName ||
                    insn.length === 0 ||
                    !writesWatchedAddress(insn) ||
                    (patchModeChoice === 'force' &&
                      (forceValue.trim() === '' || !insn.baseRegister))
                  }
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```

Expected: clean typecheck, successful build, all tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/renderer/src/screens/Scanner.tsx src/renderer/src/tamper.d.ts
git commit -m "Offer force mode when creating a patch from a caught instruction"
```

---

### Task 8: Prove a forced value in a live process

**Files:**
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Consumes: every primitive from Tasks 2-4 and the harness from Task 1.
- Produces: the end-to-end proof that an injection makes a value hold.

This is the task the whole stage exists for: not "a write was disabled" but "the value became what I asked and stayed there while the game ran".

- [ ] **Step 1: Write the failing test**

Append to `tests/native/cave_ops.test.ts`:

```ts
describe('force injection — end to end', () => {
  it('pins the value to a constant and releases it on restore', async () => {
    // Catch the instruction that writes the forced field, exactly as the
    // app does — this is the same provenance a real cheat has.
    ;(addon as any).startWriteWatch(harness.pid, forceAddress)
    await send('forceloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    expect(insn.length).toBeGreaterThan(0)
    expect(insn.baseRegister.length).toBeGreaterThan(0)

    const site = insn.instructionAddress
    const run = (addon as any).decodeRun(handle, site, 5)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)

    const displaced = (addon as any).readBytes(handle, site, run.length)
    const cave = (addon as any).allocateCave(handle, site)
    expect(cave).not.toBeNull()

    // 777.0f as raw bits — the same conversion valueBits does in the engine.
    const bits = new DataView(new ArrayBuffer(4))
    bits.setFloat32(0, 777, true)
    const imm = bits.getUint32(0, true)

    const codeAddress = '0x' + (BigInt(cave) + 8n).toString(16)
    const effect = (addon as any).encodeStore(
      insn.baseRegister,
      Number(BigInt(insn.displacement)),
      imm
    )
    const returnTo = '0x' + (BigInt(site) + BigInt(run.length)).toString(16)
    const jumpBackFrom =
      '0x' + (BigInt(codeAddress) + BigInt(displaced.length / 2 + effect.length / 2)).toString(16)
    const body = displaced + effect + (addon as any).encodeJump(jumpBackFrom, returnTo)
    expect((addon as any).writeBytes(handle, codeAddress, body)).toBe(true)

    const jump = (addon as any).encodeJump(site, codeAddress)
    const padded = jump + '90'.repeat(run.length - 5)
    ;(addon as any).suspendThreads(harness.pid)
    expect((addon as any).writeBytes(handle, site, padded)).toBe(true)
    ;(addon as any).resumeThreads()

    // The harness keeps writing an increasing value; the injection must win
    // every time, so every sample reads exactly 777.
    await sleep(200)
    for (let i = 0; i < 3; i++) {
      const reply = await send('getforce')
      expect(parseFloat(reply.split(' ')[1])).toBeCloseTo(777, 3)
      await sleep(100)
    }

    // Restore: the field must start moving again.
    ;(addon as any).suspendThreads(harness.pid)
    expect((addon as any).writeBytes(handle, site, displaced)).toBe(true)
    ;(addon as any).resumeThreads()
    await sleep(300)
    const after = parseFloat((await send('getforce')).split(' ')[1])
    expect(after).not.toBeCloseTo(777, 3)

    await send('stopforce')
  }, 30000)
})
```

- [ ] **Step 2: Run it**

```bash
npx vitest run tests/native/cave_ops.test.ts -t "end to end"
```

Expected: PASS. If the value does not pin, the failure is real and must be diagnosed rather than the assertion loosened — a passing suite with a cheat that doesn't work is the outcome this whole plan exists to avoid. Check in order: the jump's rel32 arithmetic, the cave body's layout, and whether the harness's store was displaced whole.

- [ ] **Step 3: Run the full suite and commit**

```bash
npx vitest run && npx tsc --noEmit && npm run build
```

```bash
git add tests/native/cave_ops.test.ts
git commit -m "Prove a force injection pins a live value and releases it"
```

---

# STAGE 2 — `capture` and anchored value cheats

### Task 9: encodeCapture

**Files:**
- Modify: `native/src/cave_ops.h`, `native/src/cave_ops.cc`, `native/src/addon.cc`
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Produces: `encodeCapture(baseRegister: string, atAddress: string, slotAddress: string): string` — `mov [rip+disp], reg`, assembled for execution at `atAddress` so its RIP-relative displacement reaches `slotAddress`.

- [ ] **Step 1: Write the failing test**

```ts
describe('encodeCapture', () => {
  it('writes the register into the slot when executed', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    const slot = cave
    const code = '0x' + (BigInt(cave) + 8n).toString(16)
    const hex: string = (addon as any).encodeCapture('rcx', code, slot)

    // It must decode as one instruction of exactly the length produced —
    // proof the RIP displacement was folded into a real encoding.
    ;(addon as any).writeBytes(handle, code, hex)
    const run = (addon as any).decodeRun(handle, code, 1)
    expect(run.decodable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown register', () => {
    expect(() => (addon as any).encodeCapture('nope', '0x1000', '0x2000')).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

```bash
npx vitest run tests/native/cave_ops.test.ts -t encodeCapture
```

Declare `Napi::Value EncodeCapture(const Napi::CallbackInfo& info);` in the header and implement:

```cpp
// `mov [rip+disp], reg` — the displacement is relative to the END of the
// instruction, whose length depends on the displacement's own encoding, so
// encode once with a placeholder to learn the length, then again with the
// real value. Assembling for a known cave address is what makes a
// RIP-relative instruction safe here: unlike a displaced one, it is built
// for exactly where it will execute and never moves afterwards.
Napi::Value EncodeCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string regName = info[0].As<Napi::String>().Utf8Value();
  uintptr_t at = ParseHex(info[1].As<Napi::String>().Utf8Value());
  uintptr_t slot = ParseHex(info[2].As<Napi::String>().Utf8Value());

  ZydisRegister reg = RegisterByName(regName);
  if (reg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown base register").ThrowAsJavaScriptException();
    return env.Null();
  }

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  ZyanUSize len = 0;
  int64_t disp = 0;

  for (int pass = 0; pass < 2; pass++) {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MOV;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_MEMORY;
    req.operands[0].mem.base = ZYDIS_REGISTER_RIP;
    req.operands[0].mem.displacement = disp;
    req.operands[0].mem.size = 8;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[1].reg.value = reg;

    len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode capture").ThrowAsJavaScriptException();
      return env.Null();
    }
    disp = (int64_t)slot - (int64_t)(at + len);
  }

  return Napi::String::New(env, BytesToHex(buf, (size_t)len));
}
```

Wire `exports.Set("encodeCapture", ...)`, rebuild, and confirm the test passes.

- [ ] **Step 3: Commit**

```bash
git add native tests/native/cave_ops.test.ts
git commit -m "Encode a RIP-relative capture store for the cave slot"
```

---

### Task 10: Capture mode in the engine

**Files:**
- Modify: `src/main/patchEngine.ts`, `src/main/nativeAddon.ts`, `src/main/ipc.ts`
- Test: `tests/main/patchEngine.test.ts`

**Interfaces:**
- Produces: `PatchOps.encodeCapture`; `apply` installs capture mode; `PatchEngine.slotAddress(id): string | null` returns the cave slot of an installed capture patch; IPC channel `patch:slot`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('PatchEngine — capture injection', () => {
  const capturePatch: PatchCheat = {
    ...forcePatch,
    id: 'patch-player',
    mode: 'capture',
    value: undefined,
    dataType: undefined,
    fieldOffset: undefined
  }

  it('installs a capture and exposes its slot', async () => {
    const result = await engine.apply(capturePatch)
    expect(result.ok).toBe(true)
    // The slot is the start of the cave; code follows it.
    expect(engine.slotAddress('patch-player')).toBe(ops.caves[0])
  })

  it('reports no slot for a patch that is not installed', () => {
    expect(engine.slotAddress('patch-player')).toBeNull()
  })

  it('reports no slot for a force patch', async () => {
    await engine.apply(forcePatch)
    expect(engine.slotAddress('patch-stamina')).toBeNull()
  })
})
```

Add `encodeCapture(): string { return '488905' + '00000000' }` to `FakeOps`.

- [ ] **Step 2: Implement**

`PatchOps` gains `encodeCapture(baseRegister: string, atAddress: string, slotAddress: string): string`. In `installInjection`, choose the effect by mode:

```ts
    const mode = patchMode(patch)
    const effect =
      mode === 'capture'
        ? this.ops.encodeCapture(patch.baseRegister as string, codeAddress, cave)
        : this.ops.encodeStore(
            patch.baseRegister as string,
            Number(BigInt(patch.fieldOffset as string)),
            valueBits(patch.value as number, patch.dataType as DataType)
          )
```

Note the capture effect must be encoded for the address it will execute at — `codeAddress` — because its displacement is RIP-relative. Since the displaced bytes come first, the capture instruction actually executes at `codeAddress + displaced.length / 2`; encode it for that address, not `codeAddress`. Add the corresponding `addHex` call.

Add the accessor and record the mode:

```ts
  // The captured pointer lives in the first 8 bytes of the cave. Only a
  // capture patch has one, and only while it is installed — an uninstalled
  // patch has no memory in the game to read from.
  slotAddress(id: string): string | null {
    const entry = this.applied.get(id)
    if (!entry || entry.mode !== 'capture') return null
    return entry.caveAddress
  }
```

with `mode` added to `AppliedPatch` and set when recording. Add `nativeAddon.encodeCapture`, the `patchOps.encodeCapture` member, and an IPC handler:

```ts
  ipcMain.handle('patch:slot', (_e, patchId: string) => patchEngine.slotAddress(patchId))
```

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/main/patchEngine.test.ts && npx tsc --noEmit
```

```bash
git add src/main tests/main/patchEngine.test.ts
git commit -m "Install capture injections and expose the pointer slot"
```

---

### Task 11: Anchored value-cheat targets

**Files:**
- Modify: `src/main/store.ts`, `src/main/ipc.ts`
- Test: `tests/main/store.test.ts`

**Interfaces:**
- Produces: `AnchorTarget`, `CheatTarget = ChainTarget | AnchorTarget`, `isAnchorTarget`; `writeCheat`/`verifyCheat` resolve anchored targets through the capture patch's slot.

- [ ] **Step 1: Write the failing store test**

```ts
describe('store — anchored targets', () => {
  it('round-trips a cheat targeting a captured pointer', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [{ kind: 'anchor', patchId: 'patch-player', offset: '0x818' }],
      value: 350
    })
    const cheat = loadCheats('valheim.exe').find((c) => c.id === 'stamina') as CheatDefinition
    const target = cheat.targets[0]
    expect(isAnchorTarget(target)).toBe(true)
    if (isAnchorTarget(target)) {
      expect(target.patchId).toBe('patch-player')
      expect(target.offset).toBe('0x818')
    }
  })
})
```

- [ ] **Step 2: Implement the union**

In `src/main/store.ts`:

```ts
// A target reached through a pointer captured by an injection, rather than
// through a chain found by scanning. Scanned chains walk whatever path
// existed in that session and do not survive a restart of a managed runtime;
// a capture patch relocates by byte pattern and records the object's real
// address every time the game touches it, so a cheat anchored to one keeps
// working across restarts.
export interface AnchorTarget {
  kind: 'anchor'
  patchId: string
  offset: string
}

export type CheatTarget = ChainTarget | AnchorTarget

export function isAnchorTarget(target: CheatTarget): target is AnchorTarget {
  return (target as AnchorTarget).kind === 'anchor'
}
```

and change `CheatDefinition.targets` to `CheatTarget[]`.

- [ ] **Step 3: Resolve anchors in ipc.ts**

`writeCheat` and `verifyCheat` currently assume `ChainTarget`. Give each a branch: for an anchored target, read the 8-byte pointer from the capture patch's slot, add `offset`, and read/write there directly — no module base, no chain walk:

```ts
// An anchored target resolves in two reads: the captured pointer, then the
// field. A slot that still reads zero means the game has not executed the
// captured instruction yet this session, which is a not-live target rather
// than an error — the same state a stale chain produces.
function resolveAnchor(handle: number, target: AnchorTarget): string | null {
  const slot = patchEngine.slotAddress(target.patchId)
  if (slot === null) return null
  const pointerHex = nativeAddon.tryReadBytes(handle, slot, 8)
  if (pointerHex === null) return null
  const pointer = littleEndianToBigInt(pointerHex)
  if (pointer === 0n) return null
  return '0x' + (pointer + BigInt(target.offset)).toString(16)
}
```

with a small helper converting the unspaced little-endian hex to a BigInt. Reading and writing the resolved address reuses `nativeAddon.readValue`/`writeValue` with an empty offsets array and the resolved address as the base.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run && npx tsc --noEmit && npm run build
```

```bash
git add src/main tests/main/store.test.ts
git commit -m "Resolve value-cheat targets through captured pointers"
```

---

### Task 12: Create anchored cheats, and prove capture end to end

**Files:**
- Modify: `src/renderer/src/screens/Scanner.tsx`
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a `capture` option in the mode selector, and the end-to-end proof.

- [ ] **Step 1: Add capture to the mode selector**

Extend `patchModeChoice` to `'nop' | 'force' | 'capture'` and add `<option value="capture">Capture this object (for a persistent value cheat)</option>`. Capture mode needs no value box; it does need a base register, so extend the disabled condition to require one for capture as well as force.

- [ ] **Step 2: Write the end-to-end capture test**

Append to `tests/native/cave_ops.test.ts`. It mirrors the force test's setup, but installs a capture and then dereferences the slot:

```ts
describe('capture injection — end to end', () => {
  it('records the object pointer where a value cheat can read it', async () => {
    ;(addon as any).startWriteWatch(harness.pid, forceAddress)
    await send('forceloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    const site = insn.instructionAddress
    const run = (addon as any).decodeRun(handle, site, 5)
    const displaced = (addon as any).readBytes(handle, site, run.length)
    const cave: string = (addon as any).allocateCave(handle, site)

    const codeAddress = '0x' + (BigInt(cave) + 8n).toString(16)
    const captureAt = '0x' + (BigInt(codeAddress) + BigInt(displaced.length / 2)).toString(16)
    const effect = (addon as any).encodeCapture(insn.baseRegister, captureAt, cave)
    const returnTo = '0x' + (BigInt(site) + BigInt(run.length)).toString(16)
    const jumpBackFrom =
      '0x' + (BigInt(captureAt) + BigInt(effect.length / 2)).toString(16)
    const body = displaced + effect + (addon as any).encodeJump(jumpBackFrom, returnTo)
    ;(addon as any).writeBytes(handle, codeAddress, body)

    const padded =
      (addon as any).encodeJump(site, codeAddress) + '90'.repeat(run.length - 5)
    ;(addon as any).suspendThreads(harness.pid)
    ;(addon as any).writeBytes(handle, site, padded)
    ;(addon as any).resumeThreads()

    await sleep(300)
    const slotHex: string = (addon as any).readBytes(handle, cave, 8)
    // Little-endian: reverse the byte pairs to read the pointer.
    const pointer = BigInt(
      '0x' + (slotHex.match(/../g) as string[]).reverse().join('')
    )
    expect(pointer).not.toBe(0n)

    // The captured pointer must actually address the field the harness writes.
    expect('0x' + pointer.toString(16)).toBe(forceAddress)

    ;(addon as any).suspendThreads(harness.pid)
    ;(addon as any).writeBytes(handle, site, displaced)
    ;(addon as any).resumeThreads()
    await send('stopforce')
  }, 30000)
})
```

Note: the harness's `force_write` takes the field's address directly, so the captured register holds the field address itself and the anchor offset is zero. A real game object would capture the object base with a non-zero field offset; the mechanism is identical.

- [ ] **Step 3: Full verification and commit**

```bash
npx vitest run && npx tsc --noEmit && npm run build
```

```bash
git add src tests
git commit -m "Create anchored value cheats and prove capture end to end"
```

---

## Manual validation (Valheim)

The automated suite proves the mechanism against a harness. Only the game proves the feature. Run this before considering #7 done, and expect it to find things — the #6 pass found six defects nothing automated could reach:

1. Scan for stamina, capture the writing instruction, create a **force** patch with value 350.
2. Toggle it on. Stamina should pin at 350 and stay there through sprinting.
3. Toggle off; confirm stamina behaves normally again and the game is stable.
4. **Restart Valheim.** Re-attach. The patch should report `located 0x…` and toggling it on should work again — this is the entire point of the sub-project.
5. Repeat with a **capture** patch plus a value cheat anchored to it, and confirm the value cheat still resolves after a restart.
6. Close Tamper with a patch applied; confirm the game keeps running with its original code restored.

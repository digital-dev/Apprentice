# Native `copy` cave mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth patch mode, `copy`, whose cave effect stores a live
register's value into `[baseRegister+fieldOffset]` instead of a fixed
literal — the encoder `ctImport.ts`'s register-copy Auto Assembler shape
(plan 2) needs to actually install.

**Architecture:** One new native encoder (`EncodeStoreRegister`, sibling to
the existing `EncodeStore`) plus wiring through `PatchOps`/`patchEngine.ts`/
`store.ts`, reusing every existing cave-install safety mechanism (displaced-
run validation, byte verification, thread suspension, restore) unchanged —
only the effect instruction's bytes differ from `force` mode.

**Tech Stack:** C++ (N-API, Zydis encoder), TypeScript (Electron main
process), Vitest, node-gyp.

**Spec:** `docs/superpowers/specs/2026-08-18-ct-table-import-design.md`
(Component 3: native `copy` cave mode)

## Global Constraints

- v1 scope: general-purpose 64-bit registers only, int32 width only. No
  XMM/float source register, no arithmetic on the copied value.
- Cave layout unchanged (`effect + tail + jmpBack`), identical to `force`.
- Every existing safety rule (no RIP-relative/relative-branch/flow-
  terminator in a displaced run; verify captured bytes before install;
  suspend every thread while writing; restore the full displaced run) must
  keep applying to `copy` exactly as it does to `force` — do not special-
  case them away.

---

### Task 1: `EncodeStoreRegister` native encoder

**Files:**
- Modify: `native/src/cave_ops.cc`
- Modify: `native/src/addon.cc`
- Test: `tests/native/cave_ops.test.ts`

**Interfaces:**
- Consumes: `RegisterByName` (existing, `native/src/cave_ops.cc`'s
  anonymous namespace, maps a lowercase register name to a 64-bit
  `ZydisRegister`).
- Produces: JS-callable `addon.encodeStoreRegister(destRegister: string,
  offset: number, sourceRegister: string): string` (unspaced lowercase hex),
  throwing on an unknown register name (either side).

- [ ] **Step 1: Write the failing test**

Add to `tests/native/cave_ops.test.ts`, directly after the existing
`describe('encodeStore', ...)` block (~line 235):

```ts
describe('encodeStoreRegister', () => {
  it('encodes mov dword ptr [rdi+offset], eax', () => {
    // REX.W is not needed for a 32-bit destination write; the ModRM byte
    // for [rdi+disp32] with source EAX is 0x87 (mod=10, reg=000, rm=111).
    const hex: string = (addon as any).encodeStoreRegister('rdi', 0x818, 'rax')
    expect(hex).toBe('8987' + '18080000')
  })

  it('encodes an extended source register (r8d) with the right REX prefix', () => {
    const hex: string = (addon as any).encodeStoreRegister('rcx', 0x10, 'r8')
    // REX.R must be set (source is r8-r15): 44 89 81 <disp32>
    expect(hex).toBe('4489811000' + '0000'.slice(0, 0))
  })

  it('round-trips through the decoder as one whole, relocatable instruction', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    const hex: string = (addon as any).encodeStoreRegister('rcx', 0x10, 'rdx')
    ;(addon as any).writeBytes(handle, scratch, hex)
    const run = (addon as any).decodeRun(handle, scratch, 1)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown destination register', () => {
    expect(() => (addon as any).encodeStoreRegister('notareg', 0, 'rax')).toThrow()
  })

  it('rejects an unknown source register', () => {
    expect(() => (addon as any).encodeStoreRegister('rdi', 0, 'notareg')).toThrow()
  })
})
```

The second test's expected hex is deliberately left to be corrected once
you see the real encoder's output in Step 4 — Zydis's exact byte choice for
an extended-register ModRM/REX combination is easiest to confirm by running
the encoder once and reading back what it produced, rather than hand-
deriving it up front. Replace the placeholder `'4489811000' +
'0000'.slice(0, 0)` (which is just `'4489811000'`) with whatever
`encodeStoreRegister('rcx', 0x10, 'r8')` actually returns, after confirming
in Step 4 that the value decodes correctly (the third test in this block
already proves general round-trip correctness independent of the exact
byte string).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/native/cave_ops.test.ts -t encodeStoreRegister`
Expected: FAIL — `addon.encodeStoreRegister is not a function`.

- [ ] **Step 3: Implement `EncodeStoreRegister` in `cave_ops.cc`**

Add directly after the existing `EncodeStore` function
(`native/src/cave_ops.cc`, after line 286):

```cpp
// mov [destReg+offset], srcReg — a 32-bit register-to-memory store,
// sibling to EncodeStore's register-to-immediate form. `copy` mode's
// entire reason to exist: force mode can only write a literal the
// installer already knew at capture time; this writes whatever the game
// itself is holding in a register at the moment the effect runs — the
// "set this field to what that other field/register currently is" shape
// real Auto Assembler scripts use and force mode structurally cannot
// represent.
Napi::Value EncodeStoreRegister(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string destRegName = info[0].As<Napi::String>().Utf8Value();
  int64_t offset = info[1].As<Napi::Number>().Int64Value();
  std::string srcRegName = info[2].As<Napi::String>().Utf8Value();

  ZydisRegister destReg = RegisterByName(destRegName);
  if (destReg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown destination register").ThrowAsJavaScriptException();
    return env.Null();
  }
  ZydisRegister srcReg64 = RegisterByName(srcRegName);
  if (srcReg64 == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown source register").ThrowAsJavaScriptException();
    return env.Null();
  }
  // The destination memory operand is always written as a dword (int32 and
  // float alike, matching EncodeStore's own convention) — the source
  // register must be narrowed to its 32-bit form (eax, not rax) to match.
  ZydisRegister srcReg32 = ZydisRegisterGetLargestEnclosing(
      ZYDIS_MACHINE_MODE_LONG_64, srcReg64);
  // Largest-enclosing of a GPR name always yields the 64-bit form; step
  // back down to 32-bit via the encoder's own width table rather than a
  // second name lookup.
  srcReg32 = static_cast<ZydisRegister>(
      srcReg32 - ZYDIS_REGISTER_RAX + ZYDIS_REGISTER_EAX);

  ZydisEncoderRequest req;
  memset(&req, 0, sizeof(req));
  req.mnemonic = ZYDIS_MNEMONIC_MOV;
  req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
  req.operand_count = 2;
  req.operands[0].type = ZYDIS_OPERAND_TYPE_MEMORY;
  req.operands[0].mem.base = destReg;
  req.operands[0].mem.displacement = offset;
  req.operands[0].mem.size = 4; // dword, matching EncodeStore
  req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
  req.operands[1].reg.value = srcReg32;

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  ZyanUSize len = sizeof(buf);
  if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
    Napi::Error::New(env, "failed to encode register store").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, BytesToHex(buf, (size_t)len));
}
```

Register the export in `native/src/addon.cc`, directly after the existing
`exports.Set("encodeStore", ...)` line (line 81):

```cpp
  exports.Set("encodeStoreRegister", Napi::Function::New(env, EncodeStoreRegister));
```

`EncodeStoreRegister` also needs a forward declaration where `EncodeStore`
is already declared — check `native/src/cave_ops.h` and add
`Napi::Value EncodeStoreRegister(const Napi::CallbackInfo& info);` next to
the existing `EncodeStore` declaration there.

- [ ] **Step 4: Build the native addon**

Stop the running app first if it's open (a running Electron locks
`memory_addon.node`). Run:

```bash
cd native && npx node-gyp configure && npx node-gyp build && cd ..
```

If this fails to link with "permission denied", Tamper/Apprentice is still
running — close it and retry.

- [ ] **Step 5: Confirm the extended-register test's expected bytes, then run tests**

Run: `npx vitest run tests/native/cave_ops.test.ts -t encodeStoreRegister -v`

The second test will fail with a mismatch showing the actual returned hex
in the assertion diff — copy that exact string into the test as the
expected value (replacing the placeholder from Step 1), matching how the
existing `encodeStore` test's exact byte string was itself derived from a
real encoder run, not hand-computed blind.

Run again: `npx vitest run tests/native/cave_ops.test.ts -t encodeStoreRegister -v`
Expected: all 5 tests PASS.

- [ ] **Step 6: Run the full native test suite**

Run: `npx vitest run tests/native`
Expected: PASS (no regressions in the other native encoder tests).

- [ ] **Step 7: Commit**

```bash
git add native/src/cave_ops.cc native/src/cave_ops.h native/src/addon.cc tests/native/cave_ops.test.ts
git commit -m "native: add encodeStoreRegister for copy-mode cave effects"
```

---

### Task 2: `copy` mode in `store.ts` and `patchEngine.ts`

**Files:**
- Modify: `src/main/store.ts`
- Modify: `src/main/patchEngine.ts`
- Test: `tests/main/patchEngine.test.ts`

**Interfaces:**
- Consumes: `PatchOps.encodeStore` (existing) as the pattern to mirror;
  Task 1's `addon.encodeStoreRegister` is NOT consumed here — this task
  adds `encodeStoreRegister` to the `PatchOps` interface as a new required
  method with a fake implementation in tests, wired to the real native call
  in Task 3.
- Produces: `PatchCheat.mode` including `'copy'`; `PatchCheat.sourceRegister
  ?: string`; `PatchOps.encodeStoreRegister(destRegister: string, offset:
  number, sourceRegister: string): string`; `PatchEngine.apply()` installing
  a `copy`-mode patch correctly.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/patchEngine.test.ts`. First, extend `FakeOps` (inside
the `class FakeOps implements PatchOps` block, directly after the existing
`encodeStore(): string { ... }` method around line 99-101):

```ts
  encodeStoreRegisterCalls: { destRegister: string; offset: number; sourceRegister: string }[] = []
  encodeStoreRegister(destRegister: string, offset: number, sourceRegister: string): string {
    this.encodeStoreRegisterCalls.push({ destRegister, offset, sourceRegister })
    return '89870000' + '0000' // fixed stand-in, mirrors encodeStore's fixed-output style
  }
```

Then add a new patch fixture and describe block, after the existing
`describe('PatchEngine — force injection', ...)` block:

```ts
const copyPatch: PatchCheat = {
  kind: 'patch',
  mode: 'copy',
  id: 'patch-copy-durability',
  name: 'Copy Durability',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.exe',
  moduleOffset: '0x100',
  baseRegister: 'rdi',
  fieldOffset: '0x818',
  sourceRegister: 'rax'
}

describe('PatchEngine — copy injection', () => {
  it('writes a jump at the site and installs the register-copy effect in the cave', async () => {
    const result = await engine.apply(copyPatch)
    expect(result.ok).toBe(true)

    const site = ops.memory.get('0x400100') as string
    expect(site.startsWith('e9')).toBe(true)

    expect(ops.encodeStoreRegisterCalls).toEqual([
      { destRegister: 'rdi', offset: 0x818, sourceRegister: 'rax' }
    ])

    const codeAddress = '0x' + (BigInt(ops.caves[0]) + 8n).toString(16)
    const effect = '898700000000' // FakeOps.encodeStoreRegister's fixed output
    const backJump = 'e900000000'
    const cave = ops.memory.get(codeAddress) as string
    expect(cave).toBe(effect + backJump)
    expect(cave).not.toContain(ORIGINAL) // the replaced write must not run
  })

  it('refuses, before allocating a cave, when the patch is missing sourceRegister', async () => {
    const incomplete = { ...copyPatch, id: 'patch-copy-incomplete', sourceRegister: undefined } as PatchCheat
    const result = await engine.apply(incomplete)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it("refuses, before allocating a cave, when the patch's fieldOffset isn't valid hex", async () => {
    const junk = { ...copyPatch, id: 'patch-copy-junk', fieldOffset: 'not-hex' }
    const result = await engine.apply(junk)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses when the recorded length does not match a real instruction boundary', async () => {
    ops.firstInsnLength = 3
    const result = await engine.apply(copyPatch)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/main/patchEngine.test.ts -t "copy injection"`
Expected: FAIL — `Property 'encodeStoreRegister' is missing` (a TypeScript
error, since `FakeOps` won't satisfy `PatchOps` yet) or, once `FakeOps`
compiles, a runtime failure because `patchMode`/the engine don't recognize
`'copy'` (falls through to the `force`-shaped `encodeStore` default branch
today, so `encodeStoreRegisterCalls` stays empty).

- [ ] **Step 3: Add `'copy'` to `store.ts`**

In `src/main/store.ts`, modify the `PatchCheat.mode` field (line 108):

```ts
  mode?: 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy'
```

Add a new field directly after `fieldOffset?: string` (line 177), before
`value?: number`:

```ts
  // copy only: which register's live value to store — the "set this field
  // to whatever that register currently holds" shape force mode cannot
  // represent (force only encodes a fixed 32-bit immediate known at
  // capture/import time).
  sourceRegister?: string
```

Update `patchMode`'s return type (line 208-210) to include `'copy'`:

```ts
export function patchMode(patch: PatchCheat): 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' {
  return patch.mode ?? 'nop'
}
```

- [ ] **Step 4: Wire `copy` mode into `patchEngine.ts`**

Add `encodeStoreRegister` to the `PatchOps` interface
(`src/main/patchEngine.ts`), directly after the existing `encodeStore`
line (line 37):

```ts
  encodeStoreRegister(destRegister: string, offset: number, sourceRegister: string): string
```

Update `AppliedPatch.mode` (line 141):

```ts
  mode: 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy'
```

In the validation block (around line 548), add a `copy` branch alongside
the existing `force` one:

```ts
      if (mode === 'force') {
        if (
          typeof patch.value !== 'number' ||
          !patch.dataType ||
          (patch.dataType !== 'int32' && patch.dataType !== 'float')
        ) {
          throw new Error('missing or unencodable force-mode fields')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
      if (mode === 'copy') {
        if (typeof patch.sourceRegister !== 'string') {
          throw new Error('missing copy-mode source register')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
```

Update the surrounding catch's error message (still around line 563-573)
to cover `copy`:

```ts
    } catch {
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : mode === 'copy'
              ? "This patch is missing the register or offset a copy injection needs, or its offset isn't valid hex — can't compute what to write."
              : "This patch is missing the register, offset, value, or data type a force injection needs, its data type isn't int32/float (the only widths force mode can write), or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
      }
    }
```

Extend the `firstInsn.length` boundary check (around line 594) to also
gate `copy` — it replaces exactly one instruction the same way `force`
does:

```ts
    if (mode === 'force' || mode === 'copy') {
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
    }
```

Add the `copy` branch to the effect ternary (around line 731-748) — insert
before the final `encodeStore` fallback:

```ts
      const effect =
        mode === 'capture'
          ? this.ops.encodeCaptureOnce(patch.baseRegister as string, codeAddress, cave)
          : mode === 'guard'
            ? this.ops.encodeGuardedSkip(
                patch.baseRegister as string,
                codeAddress,
                cave,
                returnTo
              )
            : mode === 'copy'
              ? this.ops.encodeStoreRegister(
                  patch.baseRegister as string,
                  Number(BigInt(patch.fieldOffset as string)),
                  patch.sourceRegister as string
                )
              : this.ops.encodeStore(
                  patch.baseRegister as string,
                  Number(BigInt(patch.fieldOffset as string)),
                  valueBits(patch.value as number, patch.dataType as DataType)
                )
```

The `replay` ternary immediately above (line 725,
`mode === 'capture' || mode === 'guard' ? displaced :
displaced.slice(patch.length * 2)`) needs no change — `copy` already falls
into the `else` branch, which is the correct "replace the write, replay
only whatever tail decodeRun swallowed" shape it shares with `force`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: all PASS, including the new `copy injection` describe block and
every pre-existing test (unchanged).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/store.ts src/main/patchEngine.ts tests/main/patchEngine.test.ts
git commit -m "main: add copy patch mode to store.ts and patchEngine.ts"
```

---

### Task 3: Wire the real native encoder through `nativeAddon.ts` and `ipc.ts`

**Files:**
- Modify: `src/main/nativeAddon.ts`
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: `addon.encodeStoreRegister` (Task 1, native), `PatchOps.
  encodeStoreRegister` (Task 2, TypeScript interface).
- Produces: the live `patchOps` object (`ipc.ts`) satisfying the full
  `PatchOps` interface, so a real `copy`-mode patch can actually install
  against a real attached process.

This task has no dedicated automated test of its own — the existing
convention for this exact kind of wiring (`nativeAddon.ts`'s `encodeStore`/
`encodeCaptureOnce`/`encodeGuardedSkip` wrappers, `ipc.ts`'s `patchOps`
object) has none either; correctness is covered by Task 1's native test
(the encoder itself) and Task 2's fake-ops test (the engine logic that
calls it), and verified here by a full build.

- [ ] **Step 1: Add the wrapper in `nativeAddon.ts`**

In `src/main/nativeAddon.ts`, directly after the existing `encodeStore`
wrapper (line 183-184):

```ts
  encodeStoreRegister: (destRegister: string, offset: number, sourceRegister: string): string =>
    addon.encodeStoreRegister(destRegister, offset, sourceRegister),
```

- [ ] **Step 2: Wire it into `ipc.ts`'s `patchOps`**

In `src/main/ipc.ts`, directly after the existing `encodeStore:` line
(line 345):

```ts
  encodeStoreRegister: (destRegister, offset, sourceRegister) =>
    nativeAddon.encodeStoreRegister(destRegister, offset, sourceRegister),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors — `patchOps` now structurally satisfies the extended
`PatchOps` interface.

- [ ] **Step 4: Full build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS (412+ existing, plus the new ones from Tasks 1-2).

- [ ] **Step 6: Commit**

```bash
git add src/main/nativeAddon.ts src/main/ipc.ts
git commit -m "main: wire encodeStoreRegister through nativeAddon and ipc patchOps"
```

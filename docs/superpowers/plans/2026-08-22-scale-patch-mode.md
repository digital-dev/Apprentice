# Scale Patch Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scale` patch mode that multiplies a live XMM (float) register by a runtime-chosen factor before the game's own store replays, so cheats like "damage x2" can be expressed without a new fixed-immediate hack.

**Architecture:** `scale` joins the patch engine's existing `capture`/`guard` family (replay the whole displaced run; effect runs first) rather than `force`/`copy`'s "replace the instruction" family. Its effect is a new native encoder, `encodeScale(sourceXmmRegister, factorBits)`, emitting `mov eax, factorBits` / `movd xmmScratch, eax` / `mulss sourceXmmRegister, xmmScratch` via the same Zydis-encoder style `encodeStore`/`encodeStoreRegister` already use.

**Tech Stack:** C++ (node-addon-api, Zydis encoder) for the native side; TypeScript/vitest for `patchEngine.ts` and its tests.

**Spec:** `docs/superpowers/specs/2026-08-22-scale-patch-mode-design.md`

## Global Constraints

- `scale` needs neither `baseRegister` nor `fieldOffset` (unlike every other injection mode) — do not add a blanket `baseRegister` requirement that also catches `scale`.
- Reuse existing `PatchCheat` fields rather than inventing new ones: `sourceRegister` (xmm name, e.g. `"xmm5"`) and `value`/`dataType: 'float'` (the multiplier).
- `xmmScratch` is `xmm1` when the source is `xmm0`, otherwise `xmm0`.
- Match the codebase's existing Zydis-encoder style for new native encoders (see `EncodeStore`/`EncodeStoreRegister` in `native/src/cave_ops.cc`) — not the hand-written-byte style reserved for RIP-relative/branching blobs.
- Native rebuild command: `cd native && npx node-gyp configure && npx node-gyp build && cd ..`
- Run TS tests with `npx vitest run <path>`.

---

### Task 1: Native `encodeScale` primitive

**Files:**
- Modify: `native/src/cave_ops.cc` (add `XmmRegisterByName` and `EncodeScale`, near `RegisterByName`/`EncodeStoreRegister`)
- Modify: `native/src/cave_ops.h` (declare `EncodeScale`)
- Modify: `native/src/addon.cc` (export `encodeScale`)
- Test: `tests/native/cave_ops.test.ts` (new `describe('encodeScale', ...)` block)

**Interfaces:**
- Produces: JS-callable `addon.encodeScale(sourceXmmRegister: string, factorBits: number): string` — unspaced lowercase hex, throws on an unrecognized register name.

- [ ] **Step 1: Write the failing tests**

Add to `tests/native/cave_ops.test.ts`, after the `encodeStoreRegister` describe block (around line 269):

```ts
describe('encodeScale', () => {
  it('encodes mov eax,imm32 / movd xmm0,eax / mulss xmm5,xmm0 for a non-xmm0 source', () => {
    // factorBits for 2.0f = 0x40000000
    const hex: string = (addon as any).encodeScale('xmm5', 0x40000000)
    // b8 00000040          mov eax, 0x40000000
    // 66 0f 6e c0          movd xmm0, eax      (scratch = xmm0, source is xmm5)
    // f3 0f 59 e8          mulss xmm5, xmm0
    expect(hex).toBe('b800000040' + '660f6ec0' + 'f30f59e8')
  })

  it('picks xmm1 as scratch when the source itself is xmm0', () => {
    // factorBits for 1.5f = 0x3fc00000
    const hex: string = (addon as any).encodeScale('xmm0', 0x3fc00000)
    // b8 0000c03f          mov eax, 0x3fc00000
    // 66 0f 6e c8          movd xmm1, eax      (scratch = xmm1, source is xmm0)
    // f3 0f 59 c1          mulss xmm0, xmm1
    expect(hex).toBe('b80000c03f' + '660f6ec8' + 'f30f59c1')
  })

  it('round-trips through the decoder as three whole, relocatable instructions', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    const hex: string = (addon as any).encodeScale('xmm3', 0x40000000)
    ;(addon as any).writeBytes(handle, scratch, hex)
    const run = (addon as any).decodeRun(handle, scratch, hex.length / 2)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown source register instead of encoding nonsense', () => {
    expect(() => (addon as any).encodeScale('notareg', 0)).toThrow()
  })

  it('rejects a GPR name — only xmm registers hold a float mid-computation', () => {
    expect(() => (addon as any).encodeScale('rax', 0)).toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/native/cave_ops.test.ts -t encodeScale`
Expected: FAIL — `addon.encodeScale is not a function`

- [ ] **Step 3: Add `XmmRegisterByName` to `native/src/cave_ops.cc`**

Add directly after the existing `RegisterByName` function (which ends around line 147, right before the closing `} // namespace`):

```cpp
// The 16 128-bit XMM registers, for scale mode's floating-point source —
// distinct from RegisterByName because only a GPR can hold an object
// pointer (what every other injection mode's baseRegister needs), but only
// an XMM register can hold a float mid-computation (what scale's
// sourceRegister needs).
ZydisRegister XmmRegisterByName(const std::string& name) {
  static const struct { const char* name; ZydisRegister reg; } kMap[] = {
    {"xmm0", ZYDIS_REGISTER_XMM0},   {"xmm1", ZYDIS_REGISTER_XMM1},
    {"xmm2", ZYDIS_REGISTER_XMM2},   {"xmm3", ZYDIS_REGISTER_XMM3},
    {"xmm4", ZYDIS_REGISTER_XMM4},   {"xmm5", ZYDIS_REGISTER_XMM5},
    {"xmm6", ZYDIS_REGISTER_XMM6},   {"xmm7", ZYDIS_REGISTER_XMM7},
    {"xmm8", ZYDIS_REGISTER_XMM8},   {"xmm9", ZYDIS_REGISTER_XMM9},
    {"xmm10", ZYDIS_REGISTER_XMM10}, {"xmm11", ZYDIS_REGISTER_XMM11},
    {"xmm12", ZYDIS_REGISTER_XMM12}, {"xmm13", ZYDIS_REGISTER_XMM13},
    {"xmm14", ZYDIS_REGISTER_XMM14}, {"xmm15", ZYDIS_REGISTER_XMM15},
  };
  for (const auto& e : kMap) if (name == e.name) return e.reg;
  return ZYDIS_REGISTER_NONE;
}
```

- [ ] **Step 4: Add `EncodeScale` to `native/src/cave_ops.cc`**

Add directly after `EncodeStoreRegister` (which ends around line 342, right before the `EncodeCaptureOnce` comment block):

```cpp
// mov eax, factorBits ; movd xmmScratch, eax ; mulss sourceXmmReg, xmmScratch
// — scale mode's whole effect: multiply the XMM register the game is about
// to store (source) by a runtime factor, in place, before the displaced run
// replays the game's own (unmodified) store instruction. xmmScratch is
// xmm0 unless the source itself is xmm0, in which case xmm1 — it only ever
// holds the factor bits, so any register other than the source works.
Napi::Value EncodeScale(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string srcRegName = info[0].As<Napi::String>().Utf8Value();
  uint32_t factorBits = info[1].As<Napi::Number>().Uint32Value();

  ZydisRegister srcReg = XmmRegisterByName(srcRegName);
  if (srcReg == ZYDIS_REGISTER_NONE) {
    Napi::Error::New(env, "unknown source xmm register").ThrowAsJavaScriptException();
    return env.Null();
  }
  ZydisRegister scratchReg =
      (srcReg == ZYDIS_REGISTER_XMM0) ? ZYDIS_REGISTER_XMM1 : ZYDIS_REGISTER_XMM0;

  uint8_t buf[ZYDIS_MAX_INSTRUCTION_LENGTH];
  std::string out;

  {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MOV;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[0].reg.value = ZYDIS_REGISTER_EAX;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_IMMEDIATE;
    req.operands[1].imm.u = factorBits;
    ZyanUSize len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode mov eax, imm32").ThrowAsJavaScriptException();
      return env.Null();
    }
    out += BytesToHex(buf, (size_t)len);
  }
  {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MOVD;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[0].reg.value = scratchReg;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[1].reg.value = ZYDIS_REGISTER_EAX;
    ZyanUSize len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode movd").ThrowAsJavaScriptException();
      return env.Null();
    }
    out += BytesToHex(buf, (size_t)len);
  }
  {
    ZydisEncoderRequest req;
    memset(&req, 0, sizeof(req));
    req.mnemonic = ZYDIS_MNEMONIC_MULSS;
    req.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    req.operand_count = 2;
    req.operands[0].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[0].reg.value = srcReg;
    req.operands[1].type = ZYDIS_OPERAND_TYPE_REGISTER;
    req.operands[1].reg.value = scratchReg;
    ZyanUSize len = sizeof(buf);
    if (!ZYAN_SUCCESS(ZydisEncoderEncodeInstruction(&req, buf, &len))) {
      Napi::Error::New(env, "failed to encode mulss").ThrowAsJavaScriptException();
      return env.Null();
    }
    out += BytesToHex(buf, (size_t)len);
  }
  return Napi::String::New(env, out);
}
```

- [ ] **Step 5: Declare it in `native/src/cave_ops.h`**

Add directly after the existing `EncodeStoreRegister` declaration:

```cpp
Napi::Value EncodeScale(const Napi::CallbackInfo& info);
```

- [ ] **Step 6: Export it in `native/src/addon.cc`**

Add directly after the `encodeStoreRegister` export line:

```cpp
  exports.Set("encodeScale", Napi::Function::New(env, EncodeScale));
```

- [ ] **Step 7: Rebuild the native addon**

Run: `cd native && npx node-gyp configure && npx node-gyp build && cd ..`
Expected: builds with no errors, refreshes `native/build/Release/memory_addon.node`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/native/cave_ops.test.ts -t encodeScale`
Expected: PASS (all 5 new tests)

- [ ] **Step 9: Run the full native test file to check for regressions**

Run: `npx vitest run tests/native/cave_ops.test.ts`
Expected: PASS (every existing test still green)

- [ ] **Step 10: Commit**

```bash
git add native/src/cave_ops.cc native/src/cave_ops.h native/src/addon.cc tests/native/cave_ops.test.ts
git commit -m "feat(native): add encodeScale primitive for scale patch mode"
```

---

### Task 2: `scale` mode in the patch engine

**Files:**
- Modify: `src/main/store.ts` (extend `PatchCheat['mode']` and `patchMode()`'s return type; document `sourceRegister`'s dual meaning)
- Modify: `src/main/nativeAddon.ts` (wrap `addon.encodeScale`)
- Modify: `src/main/patchEngine.ts` (add `encodeScale` to `PatchOps`; add `scale` validation and install branch)
- Test: `tests/main/patchEngine.test.ts` (new `describe('PatchEngine — scale injection', ...)` block)

**Interfaces:**
- Consumes: `nativeAddon.encodeScale(sourceXmmRegister: string, factorBits: number): string` from Task 1.
- Consumes: `valueBits(value: number, dataType: DataType): number` (already exported by `patchEngine.ts`).
- Produces: `PatchCheat` with `mode: 'scale'`, `sourceRegister: string` (xmm name), `value: number`, `dataType: 'float'` now installs correctly via `PatchEngine.apply()`.

- [ ] **Step 1: Extend the mode types in `src/main/store.ts`**

Change:

```ts
  mode?: 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy'
```

to:

```ts
  mode?: 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale'
```

And change `patchMode`'s signature similarly:

```ts
export function patchMode(patch: PatchCheat): 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' {
  return patch.mode ?? 'nop'
}
```

to:

```ts
export function patchMode(
  patch: PatchCheat
): 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale' {
  return patch.mode ?? 'nop'
}
```

Update the comment above `sourceRegister` (currently: `// copy only: which register's live value to store — ...`) to:

```ts
  // copy: which GPR's live value to store — the "set this field to
  // whatever that register currently holds" shape force mode cannot
  // represent (force only encodes a fixed 32-bit immediate known at
  // capture/import time).
  // scale: which XMM register holds the float the game is about to store
  // — the register scale multiplies in place by `value` before the game's
  // own (unmodified) store replays. Same field, disjoint meaning: a patch
  // is either copy or scale, never both, so one name can carry either a
  // GPR or an XMM register name depending on mode.
```

- [ ] **Step 2: Wrap the native call in `src/main/nativeAddon.ts`**

Add directly after `encodeStoreRegister`'s entry in the `nativeAddon` object:

```ts
  // scale mode's effect: multiply an XMM register in place by a runtime
  // factor. See cave_ops.cc's EncodeScale comment for the three-instruction
  // shape (mov eax,imm32 / movd xmmScratch,eax / mulss source,xmmScratch).
  encodeScale: (sourceXmmRegister: string, factorBits: number): string =>
    addon.encodeScale(sourceXmmRegister, factorBits),
```

- [ ] **Step 3: Add `encodeScale` to `PatchOps` in `src/main/patchEngine.ts`**

Add directly after `encodeStoreRegister` in the `PatchOps` interface:

```ts
  encodeScale(sourceXmmRegister: string, factorBits: number): string
```

- [ ] **Step 4: Write the failing tests in `tests/main/patchEngine.test.ts`**

First, add a fake for the new op to `FakeOps`, directly after `encodeStoreRegister`'s fake (around line 106):

```ts
  encodeScaleCalls: { sourceXmmRegister: string; factorBits: number }[] = []
  encodeScale(sourceXmmRegister: string, factorBits: number): string {
    this.encodeScaleCalls.push({ sourceXmmRegister, factorBits })
    return 'aabbcc' // fixed stand-in, mirrors encodeStoreRegister's fixed-output style
  }
```

Then add a new describe block at the end of the file, modeled on the `'PatchEngine — guard injection'` block:

```ts
describe('PatchEngine — scale injection', () => {
  const scalePatch: PatchCheat = {
    kind: 'patch',
    mode: 'scale',
    id: 'patch-damage-x2',
    name: 'Damage x2',
    originalBytes: ORIGINAL,
    length: 5,
    signature: 'f3 0f 11 41 10',
    moduleName: 'game.exe',
    moduleOffset: '0x100',
    sourceRegister: 'xmm5',
    value: 2,
    dataType: 'float'
  }

  // scale replays the game's own write, scaled — unlike force mode, which
  // replaces it outright — so the original bytes MUST still be in the cave,
  // after the effect.
  it('keeps the game\'s own write in the cave, after the effect', async () => {
    const result = await engine.apply(scalePatch)
    expect(result.ok).toBe(true)

    const codeAddress = '0x' + (BigInt(ops.caves[0]) + 8n).toString(16)
    expect(ops.memory.get(codeAddress)).toBe('aabbcc' + ORIGINAL + 'e900000000')
  })

  it('passes the source register and the multiplier\'s float bits', async () => {
    await engine.apply(scalePatch)
    expect(ops.encodeScaleCalls).toEqual([
      { sourceXmmRegister: 'xmm5', factorBits: valueBits(2, 'float') }
    ])
  })

  it('installs without a base register or field offset, which it never uses', async () => {
    expect(scalePatch.baseRegister).toBeUndefined()
    expect(scalePatch.fieldOffset).toBeUndefined()
    const result = await engine.apply(scalePatch)
    expect(result.ok).toBe(true)
  })

  it('refuses, before allocating a cave, when sourceRegister is missing', async () => {
    const noReg = { ...scalePatch, id: 'patch-scale-noreg', sourceRegister: undefined } as PatchCheat
    const result = await engine.apply(noReg)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
  })

  it('refuses, before allocating a cave, when sourceRegister is not a recognized xmm register', async () => {
    const bogus = { ...scalePatch, id: 'patch-scale-bogus', sourceRegister: 'notareg' } as PatchCheat
    const result = await engine.apply(bogus)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
  })

  it('refuses, before allocating a cave, when value or dataType is missing', async () => {
    const noValue = { ...scalePatch, id: 'patch-scale-noval', value: undefined } as PatchCheat
    const result = await engine.apply(noValue)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
  })

  it('refuses when dataType is not float — scale only multiplies floats', async () => {
    const wrongType = { ...scalePatch, id: 'patch-scale-int', dataType: 'int32' } as PatchCheat
    const result = await engine.apply(wrongType)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
  })
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run tests/main/patchEngine.test.ts -t "scale injection"`
Expected: FAIL — `ops.encodeScale is not a function` / TS error on unrecognized `sourceRegister` xmm value, or `mode` type error, until Step 6 below lands.

- [ ] **Step 6: Implement `scale` mode in `src/main/patchEngine.ts`**

In the `AppliedPatch` interface, extend the `mode` field's type the same way:

```ts
  mode: 'nop' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale'
```

In `installInjection`, change the outer base-register guard (currently unconditional) to skip `scale`:

```ts
    try {
      if (mode !== 'scale' && typeof patch.baseRegister !== 'string') {
        throw new Error('missing base register')
      }
```

Add a new validation branch directly after the existing `if (mode === 'copy') { ... }` block, inside the same `try`:

```ts
      if (mode === 'scale') {
        // scale never uses fieldOffset/baseRegister — only a recognized
        // xmm source register and a float multiplier.
        if (
          typeof patch.sourceRegister !== 'string' ||
          !/^xmm(1[0-5]|[0-9])$/.test(patch.sourceRegister.toLowerCase())
        ) {
          throw new Error('missing or unrecognized scale-mode source register')
        }
        if (typeof patch.value !== 'number' || patch.dataType !== 'float') {
          // Scale only multiplies a float register — int32 has no XMM
          // representation this mode's mulss could operate on.
          throw new Error('missing or unencodable scale-mode multiplier')
        }
      }
```

Add a matching branch to the error-message ternary right after the `catch`:

```ts
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : mode === 'copy'
              ? "This patch is missing the register or offset a copy injection needs, its source register isn't a recognized register, or its offset isn't valid hex — can't compute what to write."
              : mode === 'scale'
                ? "This patch is missing its source xmm register or its multiplier, or the source register isn't recognized — can't compute what to write."
                : "This patch is missing the register, offset, value, or data type a force injection needs, its data type isn't int32/float (the only widths force mode can write), or its offset isn't valid hex — can't compute what to write.",
```

In the body-construction section, add `scale` to the "replay everything" group:

```ts
      const replay =
        mode === 'capture' || mode === 'guard' || mode === 'scale' ? displaced : displaced.slice(patch.length * 2)
```

And add a `scale` branch to the effect ternary, directly alongside the `copy` branch:

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
            : mode === 'scale'
              ? this.ops.encodeScale(
                  patch.sourceRegister as string,
                  valueBits(patch.value as number, 'float')
                )
              : mode === 'copy'
                ? this.ops.encodeStoreRegister(
                    patch.baseRegister as string,
                    Number(BigInt(patch.fieldOffset as string)),
                    GPR64_ALIASES[(patch.sourceRegister as string).toLowerCase()]
                  )
                : this.ops.encodeStore(
                    patch.baseRegister as string,
                    Number(BigInt(patch.fieldOffset as string)),
                    valueBits(patch.value as number, patch.dataType as DataType)
                  )
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/main/patchEngine.test.ts -t "scale injection"`
Expected: PASS (all 7 new tests)

- [ ] **Step 8: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — every existing test (patchEngine, store, ctImport, anchor, etc.) still green.

- [ ] **Step 9: Commit**

```bash
git add src/main/store.ts src/main/nativeAddon.ts src/main/patchEngine.ts tests/main/patchEngine.test.ts
git commit -m "feat: add scale patch mode to the patch engine"
```

---

## Deliberately out of scope

Finding the real Valheim instruction to build a `scale`-mode `valheim.json` "Damage Multiplier" cheat around, and any UI wiring in `Scanner.tsx`/`EditPatchModal.tsx` to create a `scale` patch from the write-watch flow, are follow-up work once this primitive exists and are not part of this plan.

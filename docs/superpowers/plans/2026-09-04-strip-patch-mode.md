# Strip Patch Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `strip` patch mode that writes zero or more fixed values to multiple fixed offsets off a live register — re-read fresh on every invocation, never captured/anchored — and then replays the original instruction(s) unchanged, so cheats like "remove crafting/building material requirements" can be expressed without a per-object anchor (wrong, since a different data-table row is current every call) or a new native encoder (unnecessary, since the write primitive already exists).

**Architecture:** `strip` joins the patch engine's existing `capture`/`guard`/`scale` family (replay the whole displaced run; effect runs first) rather than `force`/`copy`'s "replace the instruction" family. Its effect is N calls to the already-existing `encodeStore` native primitive (the same one `force` mode already calls once), concatenated — no new native code.

**Tech Stack:** TypeScript/vitest only — `src/main/store.ts` and `src/main/patchEngine.ts`, tested via `tests/main/patchEngine.test.ts`'s existing `FakeOps`-based harness.

**Spec:** `docs/superpowers/specs/2026-09-04-strip-patch-mode-design.md`

## Global Constraints

- No native (`native/src/*`) changes. `EncodeStore`/`encodeStore` (native → `nativeAddon.ts` → `PatchOps.encodeStore`) is unmodified and already does the exact write this mode needs.
- `strip` needs `baseRegister` (like `force`/`capture`/`guard`) but never `fieldOffset`/`value`/`dataType` at the top level — those three stay reserved for `force`'s (and `copy`'s/`scale`'s) single-field meaning. `strip`'s fields live in a new array, `PatchCheat.fields`.
- Each entry in `fields` needs its own `fieldOffset` (hex string), `value` (number), and `dataType` (`'int32' | 'float'` only — the same width restriction `force` already has, since `EncodeStore` only ever writes a dword).
- `strip` must NOT be added to the `mode === 'force' || mode === 'copy'` boundary check (`patchEngine.ts` — the block requiring `patch.length` to equal the first decoded instruction's exact length): that check exists because `force`/`copy` *replace* one instruction and must know its exact boundary; `strip`, like `capture`/`guard`/`scale`, replays the whole displaced run and has no such constraint.
- Run TS tests with `npx vitest run tests/main/patchEngine.test.ts`.

---

### Task 1: `strip` mode — schema, validation, effect, and tests

**Files:**
- Modify: `src/main/store.ts` (extend `PatchCheat['mode']` and `patchMode()`'s return type; add `PatchCheat.fields`)
- Modify: `src/main/patchEngine.ts` (validation block, error-message branch, `replay` ternary, `effect` ternary)
- Test: `tests/main/patchEngine.test.ts` (extend `FakeOps.encodeStore` to record calls; new `describe('PatchEngine — strip injection', ...)` block)

**Interfaces:**
- Consumes: `PatchOps.encodeStore(baseRegister: string, offset: number, imm32: number): string` (already declared in `patchEngine.ts`'s `PatchOps` interface, already implemented in `nativeAddon.ts` and `FakeOps`) — unchanged.
- Consumes: `valueBits(value: number, dataType: DataType): number` (already exported by `patchEngine.ts`) — unchanged.
- Produces: a `PatchCheat` with `mode: 'strip'`, `baseRegister: string`, `fields: { fieldOffset: string; value: number; dataType: 'int32' | 'float' }[]` (non-empty) now installs correctly via `PatchEngine.apply()`, writing every field off the live register and replaying the original instruction(s).

- [ ] **Step 1: Extend the mode types and add `fields` in `src/main/store.ts`**

Find (around line 199):

```ts
  mode?: 'nop' | 'replace' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale'
```

Change to:

```ts
  mode?: 'nop' | 'replace' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale' | 'strip'
```

Find `patchMode`'s declaration (around line 365):

```ts
export function patchMode(
  patch: PatchCheat
): 'nop' | 'replace' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale' {
  return patch.mode ?? 'nop'
}
```

Change the return type the same way:

```ts
export function patchMode(
  patch: PatchCheat
): 'nop' | 'replace' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale' | 'strip' {
  return patch.mode ?? 'nop'
}
```

Find the `force only: where the field sits...` comment block directly above `fieldOffset?: string` (around line 302) and add a `strip` paragraph after it, then add the new field directly below `hotkey?: string` at the end of the interface:

```ts
  // force only: where the field sits relative to that register, what to
  // write, and how to turn `value` into the 32 bits that get written.
  //
  // strip: none of fieldOffset/value/dataType — it writes several fields at
  // once, off the SAME baseRegister, re-read fresh on every invocation
  // rather than a captured/anchored one (right for a shared data-table row
  // that's a different object on every call — e.g. Palworld's crafting
  // requirement check — where a capture-mode anchor would freeze on
  // whichever row happened to be current the moment it was captured).
  // Unlike force, strip replays the original instruction(s) afterward
  // instead of replacing them — the site strip hooks is typically a READ,
  // with no existing write to piggyback on. See `fields` below.
  fieldOffset?: string
```

```ts
  // Same meaning as CheatDefinition.hotkey above.
  hotkey?: string
  // strip only: the fields to write, each off the SAME baseRegister,
  // re-read live on every invocation — e.g. zeroing Material1_Count through
  // Material5_Count on whichever recipe row is current. Every entry needs
  // its own fieldOffset/value/dataType (EncodeStore only ever writes a
  // dword, so dataType is restricted to 'int32'/'float' the same way
  // force's single fieldOffset/value/dataType triple already is). Absent
  // or empty refuses to install — a strip patch with nothing to write isn't
  // meaningful.
  fields?: { fieldOffset: string; value: number; dataType: DataType }[]
}
```

(The second snippet's trailing `}` is the interface's own closing brace — `fields` is the last member.)

- [ ] **Step 2: Run the type-check to confirm the schema change compiles**

Run: `npx tsc --noEmit -p .`
Expected: no new errors (existing `PatchCheat` literals don't set `mode: 'strip'` yet, so nothing downstream is affected).

- [ ] **Step 3: Add strip validation in `src/main/patchEngine.ts`**

Find the `mode === 'copy'` validation block (around line 759-777, ending right before `if (mode === 'scale') {`):

```ts
      if (mode === 'copy') {
        // copy mode encodes "store whatever sourceRegister currently holds"
        // — no value/dataType to validate, since it never writes a fixed
        // immediate the way force does.
        if (
          typeof patch.sourceRegister !== 'string' ||
          !(patch.sourceRegister.toLowerCase() in GPR64_ALIASES)
        ) {
          // Unrecognized names must be refused HERE, before allocateCave —
          // native RegisterByName (cave_ops.cc) throws on an unknown name
          // too, but only once encodeStoreRegister runs in the effect
          // ternary below, which is after the cave is already allocated and
          // has no surrounding try/catch. Refusing early is what keeps a
          // bad sourceRegister from leaking a 4KB cave in the target
          // process.
          throw new Error('missing or unrecognized copy-mode source register')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
```

Add a new block directly after it (still before `if (mode === 'scale') {`):

```ts
      if (mode === 'strip') {
        // strip writes several fields off the same baseRegister (already
        // required above), re-read live on every invocation — no
        // fieldOffset/value/dataType of its own to validate, only the
        // fields array. Each entry gets the exact same width check force's
        // single field already gets, for the exact same reason: EncodeStore
        // only ever writes a dword, so any other dataType would be silently
        // mis-encoded rather than refused.
        if (!Array.isArray(patch.fields) || patch.fields.length === 0) {
          throw new Error('missing or unencodable strip-mode fields')
        }
        for (const field of patch.fields) {
          if (
            typeof field.value !== 'number' ||
            (field.dataType !== 'int32' && field.dataType !== 'float')
          ) {
            throw new Error('missing or unencodable strip-mode fields')
          }
          BigInt(field.fieldOffset) // throws on unparsable hex
        }
      }
```

Find the error-message ternary in the `catch` block (around lines 813-824):

```ts
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : mode === 'copy'
              ? "This patch is missing the register or offset a copy injection needs, its source register isn't a recognized register, or its offset isn't valid hex — can't compute what to write."
              : mode === 'scale'
                ? conditionalScale
                  ? "This conditional scale is missing its base register, source xmm register, multiplier, resolved compare-method address, or armed comparison pointer — can't compute what to write."
                  : "This patch is missing its source xmm register or its multiplier, or the source register isn't recognized — can't compute what to write."
                : "This patch is missing the register, offset, value, or data type a force injection needs, its data type isn't int32/float (the only widths force mode can write), or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
      }
```

Insert a `mode === 'strip'` branch between the `scale` branch and the terminal `force` fallback:

```ts
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : mode === 'copy'
              ? "This patch is missing the register or offset a copy injection needs, its source register isn't a recognized register, or its offset isn't valid hex — can't compute what to write."
              : mode === 'scale'
                ? conditionalScale
                  ? "This conditional scale is missing its base register, source xmm register, multiplier, resolved compare-method address, or armed comparison pointer — can't compute what to write."
                  : "This patch is missing its source xmm register or its multiplier, or the source register isn't recognized — can't compute what to write."
                : mode === 'strip'
                  ? "This patch has no fields to write, or one of them has an unencodable data type or an offset that isn't valid hex — can't compute what to write."
                  : "This patch is missing the register, offset, value, or data type a force injection needs, its data type isn't int32/float (the only widths force mode can write), or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
      }
```

- [ ] **Step 4: Join the "replay everything" family and add the effect branch**

Find (around line 982-983):

```ts
      const replay =
        mode === 'capture' || mode === 'guard' || mode === 'scale' ? displaced : displaced.slice(patch.length * 2)
```

Change to:

```ts
      const replay =
        mode === 'capture' || mode === 'guard' || mode === 'scale' || mode === 'strip'
          ? displaced
          : displaced.slice(patch.length * 2)
```

Find the terminal `force` branch of the `effect` ternary (around lines 1029-1039):

```ts
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

Change to insert a `strip` branch between `copy` and the terminal `force` fallback:

```ts
              : mode === 'copy'
                ? this.ops.encodeStoreRegister(
                    patch.baseRegister as string,
                    Number(BigInt(patch.fieldOffset as string)),
                    GPR64_ALIASES[(patch.sourceRegister as string).toLowerCase()]
                  )
                : mode === 'strip'
                  ? // One encodeStore per field, off the same baseRegister,
                    // concatenated in declared order — jumpBackFrom below
                    // is already generic over effect.length, so a
                    // multi-instruction effect needs no further change.
                    (patch.fields as NonNullable<PatchCheat['fields']>)
                      .map((field) =>
                        this.ops.encodeStore(
                          patch.baseRegister as string,
                          Number(BigInt(field.fieldOffset)),
                          valueBits(field.value, field.dataType)
                        )
                      )
                      .join('')
                  : this.ops.encodeStore(
                      patch.baseRegister as string,
                      Number(BigInt(patch.fieldOffset as string)),
                      valueBits(patch.value as number, patch.dataType as DataType)
                    )
```

- [ ] **Step 5: Run the type-check again**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Extend `FakeOps.encodeStore` to record its calls in `tests/main/patchEngine.test.ts`**

Find (around line 99-101):

```ts
  encodeStore(): string {
    return 'c78718080000' + '0000af43' // mov [rdi+0x818], 350.0f
  }
```

Change to:

```ts
  encodeStoreCalls: { baseRegister: string; offset: number; imm32: number }[] = []
  encodeStore(baseRegister: string, offset: number, imm32: number): string {
    this.encodeStoreCalls.push({ baseRegister, offset, imm32 })
    return 'c78718080000' + '0000af43' // mov [rdi+0x818], 350.0f — same fixed
    // output regardless of args, mirroring encodeStoreRegister/encodeScale's
    // existing fake style; a strip test with 2 fields asserts the effect is
    // this string repeated twice, in call order.
  }
```

This is additive (recording calls, same return value) — every existing test that calls `apply()` on a `force`/`copy` patch and checks the resulting cave bytes keeps passing unchanged.

- [ ] **Step 7: Write the failing tests**

Add a new describe block at the end of `tests/main/patchEngine.test.ts`, modeled on the `'PatchEngine — capture injection'` block's replay assertion (`effect + ORIGINAL + backJump`):

```ts
describe('PatchEngine — strip injection', () => {
  const stripPatch: PatchCheat = {
    kind: 'patch',
    mode: 'strip',
    id: 'patch-easy-craft',
    name: 'Easy Craft',
    originalBytes: ORIGINAL,
    length: 5,
    signature: 'f3 0f 11 41 10',
    moduleName: 'game.exe',
    moduleOffset: '0x100',
    baseRegister: 'rdi',
    fields: [
      { fieldOffset: '0x2c', value: 0, dataType: 'int32' },
      { fieldOffset: '0x38', value: 0, dataType: 'int32' }
    ]
  }

  it('writes one encodeStore per field, off the same base register, then replays the original instruction', async () => {
    const result = await engine.apply(stripPatch)
    expect(result.ok).toBe(true)

    expect(ops.encodeStoreCalls).toEqual([
      { baseRegister: 'rdi', offset: 0x2c, imm32: 0 },
      { baseRegister: 'rdi', offset: 0x38, imm32: 0 }
    ])

    // Two fields means two calls to FakeOps.encodeStore, each returning its
    // fixed output — concatenated in declared order, then the FULL
    // displaced run (strip never replaces, unlike force/copy), then the
    // jump back.
    const codeAddress = '0x' + (BigInt(ops.caves[0]) + 8n).toString(16)
    const oneStore = 'c78718080000' + '0000af43'
    const effect = oneStore + oneStore
    const backJump = 'e900000000'
    expect(ops.memory.get(codeAddress)).toBe(effect + ORIGINAL + backJump)
  })

  it('refuses, before allocating a cave, when fields is missing', async () => {
    const incomplete = { ...stripPatch, id: 'patch-strip-missing', fields: undefined } as PatchCheat
    const result = await engine.apply(incomplete)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses, before allocating a cave, when fields is empty', async () => {
    const empty = { ...stripPatch, id: 'patch-strip-empty', fields: [] }
    const result = await engine.apply(empty)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it("refuses, before allocating a cave, when a field's dataType is a width strip mode cannot encode", async () => {
    const wideType = {
      ...stripPatch,
      id: 'patch-strip-wide',
      fields: [{ fieldOffset: '0x2c', value: 0, dataType: 'int64' }]
    } as PatchCheat
    const result = await engine.apply(wideType)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it("refuses, before allocating a cave, when a field's fieldOffset isn't valid hex", async () => {
    const junk = {
      ...stripPatch,
      id: 'patch-strip-junk',
      fields: [{ fieldOffset: 'not-hex', value: 0, dataType: 'int32' }]
    } as PatchCheat
    const result = await engine.apply(junk)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses, before allocating a cave, when baseRegister is missing', async () => {
    const incomplete = { ...stripPatch, id: 'patch-strip-no-register', baseRegister: undefined } as PatchCheat
    const result = await engine.apply(incomplete)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it('does NOT require patch.length to match the first decoded instruction (unlike force/copy)', async () => {
    // strip replays the whole displaced run rather than replacing one
    // instruction, so it must not be subject to force/copy's exact-boundary
    // guard — a mismatched firstInsnLength must not refuse installation.
    ops.firstInsnLength = 3
    const result = await engine.apply(stripPatch)
    expect(result.ok).toBe(true)
  })

  it('restores the original bytes on disable', async () => {
    await engine.apply(stripPatch)
    expect(engine.restore(stripPatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
  })
})
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npx vitest run tests/main/patchEngine.test.ts -t "strip injection"`
Expected: FAIL — `mode === 'strip'` isn't handled anywhere yet (if Steps 3-4 haven't landed) or, if run after Step 6 alone, fails because the effect/replay branches don't exist yet. (If following this plan in order, Steps 3-4 land before Step 7's tests are written, so run this once after Step 7 to confirm the tests as written actually exercise real, currently-passing-for-the-wrong-reason-or-failing behavior — see Step 9.)

- [ ] **Step 9: Run the full suite and confirm everything passes**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: PASS — every existing test (force/copy/capture/guard/scale/replace/nop) plus the new `strip injection` block.

- [ ] **Step 10: Commit**

```bash
git add src/main/store.ts src/main/patchEngine.ts tests/main/patchEngine.test.ts
git commit -m "feat: add strip patch mode -- multi-field write, replay original

Fills the gap between force (re-reads the current register every
invocation, but one field, replaces the instruction) and
capture/guard/scale (replay everything, but only ever record/skip/scale --
never write arbitrary fields). No native changes: EncodeStore already
exists and already does exactly the write this needs -- force mode just
never called it more than once per patch.

Reusable beyond Palworld: any survival-crafting game whose requirement
check reads several fixed-offset fields off a shared, per-invocation data-
table row (rather than exposing one boolean method a reflection-aware
game like Valheim can bypass wholesale via immune) needs this same shape."
```

## Self-Review

**Spec coverage:**
- New mode `'strip'`, sibling in `PatchCheat.mode` — Step 1.
- `fields` array, `strip`-only, other modes' fields untouched — Step 1.
- Effect: N `encodeStore` calls off `baseRegister`, concatenated — Step 4.
- Replay (not replace) the full displaced run — Step 4.
- Validation: non-empty `fields`, each entry's `value`/`dataType`/`fieldOffset` — Step 3.
- `baseRegister` requirement — already covered by the existing generic `(mode !== 'scale' || conditionalScale) && typeof patch.baseRegister !== 'string'` guard; a strip-specific test in Step 7 confirms this without needing a new guard.
- Not subject to force/copy's exact-instruction-length boundary check — confirmed by omission (Step 4 does not touch that check) and asserted by a dedicated test in Step 7.
- Testing section's exact asks (install/restore round-trip, rejection tests for empty/missing fields and bad dataType/fieldOffset) — Step 7.
- "Out of scope" items (Palworld building-site confirmation, wiring the actual cheat into `games/Palworld-Win64-Shipping.json`) — correctly not tasked here.

**Placeholder scan:** none — every step has real, complete code.

**Type consistency:** `fields?: { fieldOffset: string; value: number; dataType: DataType }[]` (Step 1) matches the cast `patch.fields as NonNullable<PatchCheat['fields']>` and the `field.fieldOffset`/`field.value`/`field.dataType` accesses (Steps 3-4) and the test fixture's `fields: [{ fieldOffset, value, dataType }]` shape (Step 7) throughout.

# `strip` patch mode design

## Motivation

Palworld's craft/build-requirement check (and the equivalent in most
survival-crafting games — Valheim included, though Valheim's happens to have
a clean Mono method to bypass wholesale via `immune`) reads several
fixed-offset fields off a shared data-table row — `Material1_Count`,
`Material2_Count`, ... — and gates crafting on whether the player holds
enough of each. Live RE against Palworld found the exact site
(`Palworld-Win64-Shipping.exe`, register `rdi` holding the current
`PalItemRecipe*`, offsets `+0x2C/+0x38/+0x44/+0x50/+0x5C`), but a *different*
row is current on every invocation — whichever item's crafting screen is
open — so no existing mode can express "zero these out":

- `capture` records a register **once** (`encodeCaptureOnce`) and every
  chained freeze/force cheat then targets that one fixed, anchored address
  forever. Right for a per-player singleton (HP, Stamina); wrong here, since
  the object of interest changes every call.
- `force` re-reads the *current* register on every invocation (good — no
  capture needed) and writes a fixed value at `baseRegister+fieldOffset`,
  but only **one** field, and it **replaces** the instruction it hooks
  rather than replaying it. Palworld's check doesn't have five separate
  writes to piggyback on — it has *reads* — so there's nothing for `force`
  to replace.
- `copy`/`scale` are single-field, register-sourced variants of the same
  "one target, replace" shape.
- `guard`/`immune` skip a write or an entire method; neither writes
  arbitrary field values.

What's missing is: **re-read the current register on every invocation (like
`force` already does), write several fixed values off it, then still run
the original code untouched (like `capture`/`guard` already do).** This is
purely a gap in what existing modes combine — the encoder that does the
actual writing, `EncodeStore` (`mov [reg+offset], imm32`), already exists
and is already exposed to `patchEngine.ts` as `force`'s effect. No new
native code is needed at all.

## Design

New mode `'strip'`, sibling to `force`/`copy`/`capture`/`guard`/`immune`/
`scale` in `PatchCheat.mode`.

**Shape:** like `capture`/`guard`/`scale`, `strip` replays the *entire*
displaced run — it does not replace the hooked instruction. Its effect runs
first (same "registers exactly as they were at the patched instruction"
ordering every other mode already follows), writing zero or more fixed
values off `baseRegister`'s live value; the original (read-only, in every
known use case) instructions then replay unchanged.

**New field**, `PatchCheat.fields`:

```ts
fields?: {
  fieldOffset: string // hex, relative to baseRegister
  value: number
  dataType: 'int32' | 'float' // same width restriction force already has —
                               // EncodeStore only ever writes a dword
}[]
```

`strip` is the only mode that reads `fields`; every other mode's single
`fieldOffset`/`value`/`dataType` triple is untouched and keeps meaning
exactly what it already means for `force`/`copy`/`scale`. `baseRegister` is
still required (shared with `force`/`capture`/`guard`) — `strip` has no
per-field register, only per-field offset and value, matching the real
shape: one object, several of its fields written at once.

**`patchEngine.ts`:**

- `installInjection`'s effect construction gets a new branch, evaluated
  before the terminal `force` fallback:
  ```ts
  mode === 'strip'
    ? (patch.fields as NonNullable<PatchCheat['fields']>)
        .map((f) =>
          this.ops.encodeStore(
            patch.baseRegister as string,
            Number(BigInt(f.fieldOffset)),
            valueBits(f.value, f.dataType)
          )
        )
        .join('')
    : /* existing force branch */
  ```
  `jumpBackFrom`'s `effect.length / 2 + replay.length / 2` computation is
  already generic over effect length, so a multi-instruction effect needs no
  change there.
- The `replay = mode === 'capture' || mode === 'guard' || mode === 'scale'
  ? displaced : displaced.slice(...)` ternary gains `|| mode === 'strip'` —
  joining the "replay everything" family instead of `force`'s "replace"
  family.
- New install-time validation (same place `force`'s fields get checked):
  refuse to install unless `patch.fields` is a non-empty array and every
  entry has a numeric `value`, `dataType` of `'int32'` or `'float'`, and a
  `fieldOffset` that parses as hex (`BigInt(f.fieldOffset)` throwing is the
  existing check style for `force`'s own `fieldOffset`). Error message:
  `"missing or unencodable strip-mode fields"`, mirroring force's own
  wording.
- `baseRegister` requirement: `strip` is not `'scale'`, so it already falls
  under the existing generic `typeof patch.baseRegister !== 'string'` guard
  — no new check needed there.

**`store.ts`:** extend `PatchCheat['mode']` and `patchMode()`'s return type
with `'strip'`; add the `fields` field documented above, referencing
`force`'s existing `fieldOffset`/`value`/`dataType` doc comment for the
single-field case those three keep serving.

## Testing

- `patchEngine.test.ts`: a `strip`-mode install/restore round-trip against
  the fake `PatchOps` with 2+ fields, asserting the built cave body contains
  one `encodeStore` call per field (in order) followed by the *full*
  displaced run (not sliced) and a correct jump-back target; a rejection
  test for missing/empty `fields`, and for an entry with a bad `dataType` or
  unparsable `fieldOffset` — mirroring the existing `force` validation
  tests.
- No native test changes — `EncodeStore` itself is unmodified and already
  covered by its own existing `cave_ops.test.ts` suite.

## Out of scope

- Confirming Palworld's building-requirement check site (only the
  craft-requirement site was fully verified live this session) — separate
  follow-up RE, not part of this change.
- Wiring the actual Palworld "Easy Craft" `PatchCheat` entry into
  `games/Palworld-Win64-Shipping.json` — follows once `strip` exists and the
  building site is confirmed, so both can ship together.

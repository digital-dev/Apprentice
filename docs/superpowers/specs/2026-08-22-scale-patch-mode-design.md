# `scale` patch mode design

## Motivation

Valheim's damage modifier cheat needs to multiply a value the game computes
at runtime (outgoing damage) by a user-chosen factor. None of the patch
engine's existing modes can express this:

- `force` writes a fixed 32-bit immediate, known at capture time — can't
  represent "whatever the game just computed, times N."
- `copy` stores a live GPR verbatim — no arithmetic.
- `capture`/`guard` never change what's written, only record or skip it.

Valheim's damage math lands in an XMM register (SSE calling convention) right
before the game stores it — the same site pattern the existing `force`/`copy`
modes already hook via `baseRegister`+`fieldOffset`, except the value worth
touching here is the *source* register, not the destination memory.

## Design

New mode `'scale'`, sibling to `force`/`copy`/`capture`/`guard`/`immune` in
`PatchCheat.mode`.

**Shape:** like `capture`/`guard`, `scale` replays the *entire* displaced
run — it does not replace the captured store the way `force`/`copy` do.
Its effect runs first (consistent with every other mode's "effect sees
registers exactly as they were at the patched instruction" ordering) and
mutates a live XMM register in place; the original store then replays and
writes the now-scaled value through unmodified game code. Because of this,
`scale` needs neither `baseRegister` nor `fieldOffset` — only:

- `sourceRegister`: an XMM register name (`"xmm0"`..`"xmm15"`) holding the
  computed value at the captured instruction — reusing the field `copy`
  already occupies for its own (GPR) source register. The two modes never
  overlap on one patch, so one field can carry either meaning; each mode's
  install-time validation checks the name against the register set it
  needs.
- `value` + `dataType: 'float'`: the multiplier, reusing the same fields
  `force` already uses for "the number this mode needs," rather than
  inventing parallel ones.

**Native encoding** (`cave_ops.cc`): `EncodeScale(sourceXmmReg, factorBits)`
emits three instructions via the existing Zydis-encoder style (matching
`EncodeStore`'s approach, not the hand-written-bytes style reserved for the
RIP-relative/branching blobs):

```
mov eax, factorBits          ; the multiplier's IEEE-754 bits
movd xmmScratch, eax         ; xmmScratch picked != sourceXmmReg
mulss sourceXmmReg, xmmScratch
```

`xmmScratch` is `xmm0` unless the source is `xmm0`, in which case `xmm1`.
This clobbers `eax` and `xmmScratch` — acceptable under the same precedent
`force`/`copy` already set (their injected effects aren't checked against
what the replayed swallowed instructions need either; only the *displaced
game code's own* RIP-relative/flow-terminating hazards are guarded against
today).

Register lookup (`RegisterByName`) gets a sibling `XmmRegisterByName`
accepting `xmm0`..`xmm15`; the GPR-only lookup used for `baseRegister`
elsewhere is untouched.

**`patchEngine.ts`:** add `'scale'` to the mode union (`PatchCheat.mode`,
`AppliedPatch.mode`, `patchMode()`'s return type). In `installInjection`,
`scale` joins the `capture`/`guard` "replay everything" branch rather than
the `force`/`copy` "replace the instruction" branch — new validation (before
`allocateCave`, matching the existing per-mode try/catch) requires
`sourceRegister` to be a recognized xmm name and `value`/`dataType==='float'`
to be present.

**`store.ts`:** extend `PatchCheat['mode']` and `patchMode()`'s return type
with `'scale'`. Document `sourceRegister`'s dual meaning (GPR for `copy`,
XMM for `scale`).

## Testing

- `cave_ops` native test: byte-exact check of `EncodeScale`'s output for a
  couple of (register, factor) pairs, same style as the existing
  `encodeStoreRegister` coverage.
- `patchEngine.test.ts`: a `scale`-mode install/restore round-trip against
  the fake `PatchOps`, and a rejection test for a missing/unrecognized
  `sourceRegister` or missing multiplier — mirroring the existing per-mode
  validation tests for `force`/`copy`.

## Out of scope

Finding the actual Valheim instruction to hook `scale` onto (a live,
interactive reverse-engineering session against the running game) is a
separate follow-up once this primitive exists — not part of this change.

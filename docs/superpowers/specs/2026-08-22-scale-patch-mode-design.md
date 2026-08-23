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

**Native encoding** (`cave_ops.cc`):
`EncodeScale(sourceXmmReg, atAddress, slotAddress)` emits exactly one
instruction:

```
mulss sourceXmmReg, dword ptr [rip+disp]   ; disp names the cave's slot
```

The multiplier's IEEE-754 bits live in the cave's own reserved slot — the
first 8 bytes `EncodeCaptureOnce` and the guard arming already use — written
there by `installInjection` before the code body goes down. The
displacement is relative to the END of the instruction, whose length depends
on the displacement's own encoding, so it is computed the same two-pass way
`EncodeCaptureOnce` computes its: encode once with a placeholder to learn
the length, then again with the real value. Assembling for a known cave
address is what makes a RIP-relative instruction safe here — unlike a
displaced one, it is built for exactly where it will execute and never moves
afterwards.

*Why not the obvious `mov eax, imm32` / `movd xmmScratch, eax` / `mulss
source, xmmScratch`:* that shape permanently destroys RAX and a second XMM
register. There is no precedent for it in this file — every other injected
effect is scrupulously non-destructive of caller state (`EncodeCaptureOnce`
brackets its compare in `pushfq`/`popfq`; `EncodeGuardedSkip` saves and
restores flags and `r11`, and refuses to encode at all rather than risk
corrupting an `r11` base register). Because `scale`'s effect runs FIRST,
ahead of the displaced game instructions, and because RAX and XMM0 are the
calling convention's return and first-float-argument registers — extremely
likely to be live at an SSE store site — that shape is a real, silent,
intermittent corruption risk. Reading the factor out of the slot removes
both clobbers instead of merely bracketing them.

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

- `cave_ops` native test: byte-exact check of `EncodeScale`'s output, plus a
  check that the emitted displacement, measured from the end of the
  instruction, resolves to the slot address — the same property the
  `encodeCaptureOnce` tests assert about their own two displacements — and a
  decode round-trip confirming the source register is the only thing
  written. A live end-to-end test scales the harness's `movss [reg], xmm`
  store by 8.0 and asserts every sampled value is an exact multiple of 8.
- `patchEngine.test.ts`: a `scale`-mode install/restore round-trip against
  the fake `PatchOps`, and a rejection test for a missing/unrecognized
  `sourceRegister` or missing multiplier — mirroring the existing per-mode
  validation tests for `force`/`copy`.

## Out of scope

Finding the actual Valheim instruction to hook `scale` onto (a live,
interactive reverse-engineering session against the running game) is a
separate follow-up once this primitive exists — not part of this change.

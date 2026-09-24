# Phasmophobia — cheat wishlist status

Build: Unity 2022.3.40, IL2CPP, `GameAssembly.dll`. No static singleton root for any
player/ghost component (`author_cheats` fast path returns empty for every category) —
everything here used the [[il2cpp-engine-instance-discovery]] pipeline: survey →
`FindObjectsOfType`/capture-hook → live poll-diff or disassembly to confirm meaning.
Private field *names* are Beebyte-obfuscated; class/method names are not.

## Done (in `games/Phasmophobia.json`)

- Unlimited Stamina (force-pins `PlayerStamina+0x40` exertion to 3.0 — the "how tired"
  gauge, not the displayed bar; freezing to 0 broke sprinting, see memory)
- Refill Stamina (oneshot on same field via new `factory-capture-PCStamina` anchor)
- Maximum Sanity (force, two store sites, `PlayerSanity+0x30`)
- Set Consumed Sanity (oneshot on the same field via new `factory-capture-PlayerSanity`
  anchor — confirmed by disassembling `ChangeSanity`: `rbx+0x30` is the displayed
  sanity, 100=full)
- Unlimited Salt (freeze, `SaltShaker` capture anchor)
- Set Money (oneshot, `SingleplayerProfile+0xc8` capture anchor)
- Ghost Always Visible (replace patch, force-take the "always show" branch)
- Ghost Type (display only) — `GhostAI` capture → deref `+0x38` (GhostInfo) → `+0x28`
  (int32 enum, labels table included)

## Not done yet — needs more investigation, deliberately not guessed

- **Super Walking/Running Speed**: no plain per-instance multiplier field on
  `FirstPersonController` or `PhysicsCharacterController` (surveyed both). Speed is a
  known landmine category (`author_cheats` flags it `manualReview` even for other
  games) — likely computed from a ScriptableObject config or combined with several
  gated fields, not a single store site. Needs `findCallers`/`callTree` tracing before
  any patch, not a field-offset guess.
- **Reveal/Set Player Location**: no capture yet for the player's own Transform/position.
  Doable (chase through `PlayerSanity+0x28` `player` field or a similar owning
  component to the transform) but not started.
- **Disable Ghost**: previously attempted as an early-return on
  `GhostAI.StartHuntingTimer` — broke door-lock bookkeeping the normal completion path
  does, softlocked a door, got the user killed twice. Do NOT ship a no-op on that
  method again. Needs the actual boolean/timer gate a caller checks, found by tracing
  callers, not disabling the whole function.
- **Set Ghost Type** (force a specific ghost, vs. the existing reveal-only cheat):
  same anchor (`GhostAI`+0x38 deref +0x28) but as a `force` write — should be low risk,
  just not built yet.
- **Reveal/Set Ghost Favorite Room**, **Reveal/Set Ghost Location**: `GhostInfo`'s
  survey doesn't show an obvious room pointer; `GhostAI.DelayTeleportToFavouriteRoom`
  is the method to disassemble next to find the field. Not started.
- **XP Multiplier**: no `Progression`/`Experience`/`Currency` class matched a broad
  survey regex near `SingleplayerProfile`. XP is likely computed and applied
  elsewhere (post-match summary code) rather than a per-frame field — needs a
  `findCallers`/`callTree` trace on `SingleplayerProfile`, not a survey hit.
- **Sanity Drain Rate Multiplier**: `PlayerSanity` has candidate neighbor fields
  (`+0x34`, `+0x38`) but their disassembly (`ChangeSanityOverTime`,
  `MultiplyDifficultyRate`, `IncreaseDifficultyRate`) wasn't traced yet.

All of the above are read-only/offline analysis next steps (survey + disasm +
callTree), consistent with [[offline-analysis-over-ingame-testing]] — no live
mechanic-triggering needed to make progress on them.

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
- Maximum Sanity (force, now **five** store sites, `PlayerSanity+0x30`):
  - `factory-maxsanity`/`-2`: the two `ChangeSanity` (delta) overloads, from the
    original factory draft.
  - `factory-maxsanity-3`: `NetworkedUpdatePlayerSanity`'s direct store. Added after
    a report of draining to ~0 with the first two active; turned out to be a red
    herring for that specific report (single-player, "ANOMALY" in the screenshot was
    the player's in-game name, not a validation flag) but is still a real gap worth
    having patched for multiplayer.
  - `factory-maxsanity-4`/`-5`: `SetInsanity`'s two store sites, added after a
    follow-up report of sanity stuck low / not regenerating in a solo contract.
    Unlike `ChangeSanity` (adds/subtracts a delta), `SetInsanity(int)` is an
    ABSOLUTE assignment — `clamp(float(arg), 0, 100)` written straight to `+0x30` —
    so it bypasses every other patch in one call. This is the more likely
    explanation for "stuck, can't regain": something calls `SetInsanity(0)` (a
    curse/event — caller not yet identified) and the value only recovers once
    `SanityDrainer`'s per-frame call reaches an already-patched `ChangeSanity` site
    again, which may not happen every frame.
  - **Also found while diagnosing this**: at one point `factory-maxsanity` (the
    first `ChangeSanity` overload patch) was confirmed live-unpatched (original
    bytes, no jmp) even though `-2` and `-3` were both installed in the same
    process. Cause not identified — worth checking in-app whether all patches in
    this group install together when "Maximum Sanity" is toggled, or one is
    silently failing.
  - **Root cause found and fixed (this session): `PlayerSanity+0x30` is insanity/stress,
    not sanity — 0=fully sane, 100=fully insane.** All five patches had `value: 100`,
    i.e. forcing maximum insanity the entire time; that's the actual explanation for
    both earlier bug reports (fast drain, stuck-low/can't-regain), not the multiplayer
    or `SetInsanity` theories floated along the way (those were real gaps worth
    patching regardless, just not the root cause). Confirmed by diffing against another already-installed, independently-patched trainer running on the same process    (per [[il2cpp-engine-instance-discovery]]'s "diff a working trainer" technique): its own Max Sanity hook forces this exact field to
    literal 0.0, and the player visibly holds full sanity with it on. All five
    `value`s corrected to 0. `SetInsanity`'s own name was the honest signal the whole
    time and got dismissed as "sloppy naming" early on — don't do that again; a
    method name is evidence, not decoration.
  - Not yet confirmed fixed by live testing with the corrected values.
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

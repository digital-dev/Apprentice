# Schedule I — cheat wishlist status

Build: Unity 2022.3.62 IL2CPP, `GameAssembly.dll` timestamp `1786590259`. Found
2026-09-19 by running `author_cheats` and reading class structs live (see
`docs/superpowers/specs/2026-09-19-il2cpp-cheat-factory-design.md`). The game
was running under MelonLoader/Harmony with mods loaded.

`games/Schedule I.draft.json` holds the generated cheats. **None has been
toggled in Tamper yet**; "read-verified" below means the field was read live
with a plausible value, not that writing it does what the name says.
Promote an entry to `Schedule I.json` only after its `lookFor` check passes.

## Drafted (field cheats)

| Wishlist item | Field | Off | Live read | Notes |
|---|---|---|---|---|
| Unlimited Health | `PlayerHealth.<CurrentHealth>` | `0x11c` | 100 | Verified through `Player.Local`, single instance. |
| Unlimited / Edit Bank Balance | `MoneyManager.onlineBalance` | `0x128` | 43,654.875 | Same field as the shipped Infinite Money cheat. 3 candidate instances. |
| Unlimited / Edit Cash | `PlayerInventory.<cashInstance>` (`0x48`) then `CashInstance.<Balance>` (`0x30`) | | 69,317.79 (works in-game; the on-screen figure updates only when you click the cash or open the inventory, because the UI refreshes on the game's own event and calling its UI method from Tamper's thread is unsafe) | Hand-built with the new anchor `derefOffset`: capture `PlayerInventory.Update` (every frame), follow `+0x48` to the wallet, write `+0x30`. Verified live: the pointer leads to the same object whose balance changes as you play. The earlier `CashInstance.ChangeBalance` hook only captured when cash changed. |
| Unlimited Water | `WaterContainerInstance.<CurrentFillAmount>` | `0x30` | 5 | Frozen at 999; lower it if the can looks overfull. Hook `get_NormalizedFillAmount`. |
| Infinite Stamina | `PlayerMovement.<CurrentStaminaReserve>` | `0x4c` | 100 (the max) | Freeze 999 through the shared `PlayerMovement.Update` capture. Untested in-game. The first factory run picked a stale object reading 1e-42 (fixed: scanned floats need real magnitude), so if this reads oddly, suspect a wrong instance first. Sprint drains it every frame, so watch whether the bar still flickers. |
| No Curfew | `CurfewManager` `IsEnabled`, `IsCurrentlyActive`, `IsHardCurfewActive` | `0x120-0x122` | IsEnabled=1 | One cheat, three targets, all frozen to 0. |
| Freeze Daytime | `TimeManager.<TimeSpeedMultiplier>` | `0x13c` | 1.0 | Frozen to 0. Sleeping may misbehave while frozen. |
| ~~Run Speed Multiplier~~ | `PlayerMovement.<CurrentSprintMultiplier>` | `0x50` | 1.0 | Worked, but froze a field the camera also reads, so the camera bobbed while standing still. Replaced by the scale patch below. |
| ~~No Body Search~~ | `PlayerCrimeData.BodySearchPending` | `0x168` | 0 | **Does not work** (police still searched, confirmed in-game): the flag is not what starts a search. Replaced by the officer patch below. |

Every cheat is a `capture` patch on an instance method of the owning class
(rcx = `this`) plus an `anchor` value cheat, the same pair `Schedule I.json`
already uses. `multiInstanceRisk` cheats record whichever instance ran last.

## Drafted (method patch)

| Wishlist item | Site | Notes |
|---|---|---|
| Movement Speed Multiplier (player only) | `PlayerMovement.Move` at RVA `0x63c300`: `scale` `xmm6` by `value` (default 2) | In `Move` the speed factor is built as `CurrentSprintMultiplier * walk const * crouch * static` into `xmm6` and then `mulss xmm7,xmm6` combines it with the shared `FloatStack` multiplier. Scaling `xmm6` there speeds all player movement without changing the stored sprint field, so the camera bob (which reads that field inline in `PlayerCamera.UpdateCameraBob`) is untouched. It runs only inside the player's own `Move`, so NPCs and everything else that shares `FloatStack` are unaffected. `WalkSpeed`, `SprintMultiplier` and the other caps names are `const`s with no storage. Untested in-game. |

| Wishlist item | Site | Notes |
|---|---|---|
| No Investigate / No Body Search | `PoliceOfficer.CanInvestigatePlayer` at RVA `0x72a2b0`: entry replaced with `xor eax,eax; ret` | Both `CheckNewInvestigation` (new) and `UpdateExistingInvestigation` (running, leads to `ConductBodySearch`) call this gate, so it returns false for every officer. A `replace` patch with a unique 148-byte signature. Two earlier guesses were wrong: the player-side `BodySearchPending` flag, and an inlined `BodySearchChance` compare in `CheckNewInvestigation`. Untested in-game. |

Officer patches (both `replace`, both untested until toggled):
- `factory-nobodysearch-officers` at `0x72af60`: `PoliceOfficer.ConductBodySearch` returns immediately. It is the function **every** search route calls (patrol `UpdateExistingInvestigation`, `BodySearchLocalPlayer`, and `CheckpointBehaviour.PlayerWalkedThroughCheckPoint`). Found by watching a live checkpoint officer switch from `checkpoint` to `bodySearch`, not by reading code.
- `factory-noinvestigate-officers` at `0x72a2b0`: the investigation gate. In-game it did **not** stop searches by itself (checkpoint route), so enable it only with the one above.

## Drafted 2026-09-19 (second batch; all untested in-game)

Built from the code, not from names: each was found by reading callers and
callees (`findCallers`, `callTree`, `findFieldReaders`) and confirmed unique in
a recorded snapshot of the build (`tests/fixtures/manifest.json`). What the
snapshot proves is that the bytes and signatures are right; whether each
*does* what its name says is only established when you toggle it.

| Cheat | Site | Why here | Watch for |
|---|---|---|---|
| Invisible: player visibility reads 0 | `VisionCone.GetPlayerVisibility` entry: `xorps xmm0,xmm0; ret` | Officer investigations and look-at-player read it | Officers no longer start investigations by sight |
| Invisible: combat and pursuit never see the player | `VisionCone.IsTargetVisible` entry: `xor eax,eax; ret` | `CombatBehaviour` and `VehiclePursuitBehaviour` visibility checks | A chase drops when it should |
| Invisible: NPCs never notice anything | `VisionCone.UpdateVision` entry: `ret` | General noticing (customers, crimes) runs here | **Least certain**: assumed void (large tick prologue, no return value seen). If NPCs freeze or behave oddly, turn this one off first |
| No Arrest | `PlayerCrimeData.SetArrestProgress` entry: `scale` `xmm1` by 0 | The arrest fires from this function's own compare (`Player.Arrest_Server`) once the incoming progress passes the threshold; scaling the *stored* value would not stop it. `PursuitBehaviour.UpdateArrest` only accumulates a local timer and calls this | Dying still routes through `OnDie` -> arrest, deliberately left alone |
| Max Relationship | `NPCRelationData.get_NormalizedRelationDelta`: returns 1.0 | Customer deal logic (`OnMinPass`, counteroffers, rejections) and the UI read it. Sole owner of that code (no folding). It changes what is read, not the saved relationship | Deals accepted more readily; the UI bar shows full |
| Fast Time x10 / x60 | `TimeManager.TimeSpeedMultiplier` `0x13c`, freeze; off restores 1 | `TimeManager.Update` multiplies frame time by it. Pots, ovens, mixing stations, cauldrons and chemistry all advance on the game's minute tick, so this speeds every timer with no per-machine patch | The game may clamp minutes per frame, so x60 may not be 6x faster than x10. Use one at a time. Sleeping may interact |

| Clone Items (3 patches: drag all / drag partial / shift-click) | `ItemUIManager.EndDrag` (`neg edx`; `mov edx,-1`) and `SlotClicked` (`neg ebp`) | Moving items ends in `ItemSlot.ChangeQuantity(sourceSlot, -amountMoved)` after the target has already received them (`draggedSlot` `0x80`, `draggedAmount` `0x90`, `HoveredSlot` `0x30`). Each patch makes that subtraction 0, so the target gets the items and the source keeps them | Drag a stack onto another slot and shift-click an item: the source should stay full. Enable all three. Cash dragging is a separate path and is not covered. Untested: what a drop back onto the same slot does |

Known limits: the three invisibility patches stack (enable together for full
effect). Fast Time replaces the earlier idea of an "advance one hour" write:
writing `CurrentTime` directly would skip the `onTimeSet`/`onMinutePass` events
NPC schedules run on.

## Not drafted, and why

- **Set XP / rank**: `LevelManager.XP` and `TotalXP` are plain fields, but the
  rank-up is decided in the game's own add-XP path, so writing them would not
  rank you up. It needs a call to that method, which is not something a field
  or patch cheat can do.
- **Per-station instant timers, instant plant growth**: replaced by Fast Time
  above, which drives all of them from the shared clock.

## Not drafted: needs a method-level patch

The field is per object (every pot, station, NPC), and a capture hook only
records one instance. A patch on the method itself covers all of them.

| Wishlist item | Mechanism found |
|---|---|
| Invisibility | `PlayerVisibility.GetVisibilityPoints` / `get_Suspiciousness`: make them return 0. |
| Instant Oven Timer | `OvenCookOperation.GetCookDuration` (int) / `cookDuration` `0x44`. |
| Instant Chemistry Timer | `ChemistryCookOperation.Progress` / `IsComplete`; `CurrentTime` `0x38`. |
| Instant Cauldron Timer | `Cauldron.CookTime` `0x230`, `RemainingCookTime` `0x338`. |
| Instant Mixing | `MixingStation.MixTimePerItem` `0x290` (int, per station). |
| Instant Plant Growth | `Pot.GrowSpeedMultiplier` `0x3a8` (per pot), `Plant.GrowthTime` `0x80`. |
| Max NPC Relationship | `NPCRelationData.<RelationDelta>` `0x10` (float, per NPC); getter or `SetRelationship`. |

Duration fields are counts, so zeroing them is normally safe; the skill's
"never zero a rate" landmine applies to the multipliers (`GrowSpeedMultiplier`
should go up, not down). Each still needs a live differential check.

## Not drafted: needs real reverse engineering or a script

- **Unlock All Shop Items** — `ShopListing` has stock/visibility flags
  (`LimitedStock`, `ConditionalVisibility`, `OverridePrice`) but the unlock
  gate is not a field on it; find the check in `ShopInterface`/item definition.
- **Advance / Rewind 1 Hour** — a relative write to `TimeManager.<CurrentTime>`
  (`int32`, `0x128`, HHMM-style). A fixed `oneshot` cannot add or subtract, so
  this needs a Tamper Lua cheat, or a call to `TimeManager.SetTime`.

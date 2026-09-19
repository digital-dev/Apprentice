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
| No Curfew | `CurfewManager` `IsEnabled`, `IsCurrentlyActive`, `IsHardCurfewActive` | `0x120-0x122` | IsEnabled=1 | One cheat, three targets, all frozen to 0. |
| Freeze Daytime | `TimeManager.<TimeSpeedMultiplier>` | `0x13c` | 1.0 | Frozen to 0. Sleeping may misbehave while frozen. |
| Run Speed Multiplier | `PlayerMovement.<CurrentSprintMultiplier>` | `0x50` | 1.0 | Frozen to 3. May be recomputed every frame; if it does nothing use the static `SprintMultiplier` via a method patch. |
| ~~No Body Search~~ | `PlayerCrimeData.BodySearchPending` | `0x168` | 0 | **Does not work** (police still searched, confirmed in-game): the flag is not what starts a search. Replaced by the officer patch below. |

Every cheat is a `capture` patch on an instance method of the owning class
(rcx = `this`) plus an `anchor` value cheat, the same pair `Schedule I.json`
already uses. `multiInstanceRisk` cheats record whichever instance ran last.

## Drafted (method patch)

| Wishlist item | Site | Notes |
|---|---|---|
| No Investigate / No Body Search | `PoliceOfficer.CanInvestigatePlayer` at RVA `0x72a2b0`: entry replaced with `xor eax,eax; ret` | Both `CheckNewInvestigation` (new) and `UpdateExistingInvestigation` (running, leads to `ConductBodySearch`) call this gate, so it returns false for every officer. A `replace` patch with a unique 148-byte signature. Two earlier guesses were wrong: the player-side `BodySearchPending` flag, and an inlined `BodySearchChance` compare in `CheckNewInvestigation`. Untested in-game. |

Officer patches (both `replace`, both untested until toggled):
- `factory-nobodysearch-officers` at `0x72af60`: `PoliceOfficer.ConductBodySearch` returns immediately. It is the function **every** search route calls (patrol `UpdateExistingInvestigation`, `BodySearchLocalPlayer`, and `CheckpointBehaviour.PlayerWalkedThroughCheckPoint`). Found by watching a live checkpoint officer switch from `checkpoint` to `bodySearch`, not by reading code.
- `factory-noinvestigate-officers` at `0x72a2b0`: the investigation gate. In-game it did **not** stop searches by itself (checkpoint route), so enable it only with the one above.

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
- **Clone Items When Clicking** — needs the `ItemSlot` click path; no field
  expresses it.
- **Advance / Rewind 1 Hour** — a relative write to `TimeManager.<CurrentTime>`
  (`int32`, `0x128`, HHMM-style). A fixed `oneshot` cannot add or subtract, so
  this needs a Tamper Lua cheat, or a call to `TimeManager.SetTime`.

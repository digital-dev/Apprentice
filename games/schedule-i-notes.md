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
| Instant Ovens | `LabOven.OnUncappedMinPass`: `inc [rcx+0x40]` (rcx = live `OvenCookOperation`, CookProgress's real per-tick increment) force-pinned to `1000` every tick (mode: force) | Fourth revision. v1 (force `IsComplete`'s entry to return true) froze the timer at 06:00; v2 (force only the final `cmp edi,[rbx+0x44]` compare true) froze it at 03:45 -- forcing the boolean at all stops anything polling `while (!IsComplete) refresh timer`, regardless of which instruction does it. v3, after confirming live via IL2CPP metadata that `+0x40`/`+0x44` really are `CookProgress`/`cookDuration` (both genuine Int32, cross-checked against the resolved class handle and each field's real `Il2CppType`, not a guess), force-cached `cookDuration` down to `1` -- **this crashed the game** (`Schedule I.exe` came back as a new PID with `UnityCrashHandler64.exe` alongside it). Root cause: shrinking the threshold while `CookProgress` keeps incrementing normally lets their ratio grow unboundedly for as long as the oven sits uncollected -- a very plausible native/IL2CPP out-of-bounds crash (an array/animation-frame index derived from that ratio), and it gets worse over time rather than being an immediate, bounded mistake. Read a live active cook to ground the fix in real numbers: `CookProgress=34`, `cookDuration=360`. This revision instead targets `LabOven.OnUncappedMinPass`'s own increment of `CookProgress` (found by enumerating LabOven's real methods and disassembling it) and pins it to a fixed `1000` every tick -- comfortably above the one real duration observed, but bounded and re-pinned rather than ever-growing. `cookDuration` itself is untouched, so its own real per-recipe lazy-init logic and the completion compare both run through entirely unmodified code | A loaded oven finishes within a couple of real-time ticks; a recipe with a real duration above 1000 would just be fast rather than instant, not unsafe. **Confirmed working in-game** this session: no freeze, no crash |
| Instant Chemistry | `ChemistryStation.OnTimePass`: `cmp edi,[recipe+0x50]` becomes `cmp edi,edi` | The station compares the operation's `CurrentTime` with the recipe's `CookTime` and jumps to its completion code when it is not less. Making the compare always equal takes that jump | A running chemistry job completes on the next tick |
| Instant Cauldron | `Cauldron.OnTimePass`: `sub eax,edi` becomes `xor eax,eax` | That instruction subtracts the elapsed minutes from `RemainingCookTime` (`+0x338`); the loop keeps cooking while it is positive. Zero falls through to the finish path | A running cook completes on the next tick |
| Instant Mixing | Three coordinated patches on `MixingStation`/`OnTimePass`, nested under one toggle via `internal`/`companions` (store.ts) -- `factory-instant-mixing` is the visible cheat, `factory-instant-mixing-display` and `factory-instant-mixing-complete` are `internal: true` and arm/disarm automatically with it | **Confirmed working live, all three together**: progress advances, display reads 0 instead of negative, completion event/animation fires without exit+reopen. (1) `mov [rbx+0x220],ecx` (CurrentMixTime, `0x85c50f`) force-pinned to `1000` every pass -- v1 forced this to `999999999` (astronomical negative display); v2 shrank the threshold instead (`imul` to `mov edi,1`, same structural overshoot risk that crashed the analogous oven fix). Confirmed live before this fix: Quantity=20, MixTimePerItem=3 (real required=60), CurrentMixTime already at 69 sitting uncollected. (2) `0x85ade4`: a small unnamed standalone getter (`return Quantity * MixTimePerItem`, no completion check -- found by scanning for every occurrence of the `imul ...,[reg+0x290]` pattern, 9 total, and disassembling each; the other 8 are inline completion checks) changed to `mov eax,[rcx+0x220]` so it always returns CurrentMixTime itself -- whatever external UI code computes `total - current` for the display always gets exactly 0. (3) `0x85c528`: the completion-event trigger inside `OnTimePass` read a *register* (`ecx`, computed from the real pre-hook value) rather than memory, so patch (1) alone never made the "ding" fire even though memory-based checks like `IsMixingDone` correctly saw it as done. NOPed the `jl` that gated on that stale register so the completion path always falls through; the next check (`cmp edx,edi; jnl`, using a freshly-read OLD memory value) does the real once-only edge-triggering instead | A running mix completes and dings on the next tick; a batch whose real required-total exceeds 1000 would just be fast rather than instant, not unsafe |
| Instant Plant Growth | `Plant.MinPass`: `scale` `xmm6` x 100000 at `mulss xmm6,[pot+0x3a8]` | Scales the growth step. `SetNormalizedGrowthProgress` clamps progress to 0..1 and then runs the normal `GrowthDone` path, so harvestables spawn as usual. Water and temperature rules still apply | Watered plants reach full growth on the next tick |

| Clone Items (3 patches: drag all / drag partial / shift-click) | `ItemUIManager.EndDrag` (`neg edx`; `mov edx,-1`) and `SlotClicked` (`neg ebp`) | Moving items ends in `ItemSlot.ChangeQuantity(sourceSlot, -amountMoved)` after the target has already received them (`draggedSlot` `0x80`, `draggedAmount` `0x90`, `HoveredSlot` `0x30`). Each patch makes that subtraction 0, so the target gets the items and the source keeps them | Drag a stack onto another slot and shift-click an item: the source should stay full. Enable all three. Cash dragging is a separate path and is not covered. Untested: what a drop back onto the same slot does |

| Double Hovered Stack (Lua script, hotkey) | Chain `ItemUIManager.HoveredSlot` (`+0x30`) -> `ItemSlotUI.assignedSlot` (`+0x28`) -> `ItemSlot.ItemInstance` (`+0x10`) -> `Quantity` (`+0x10`, int32; from `ItemSlot.get_Quantity`), reached through a capture on `ItemUIManager.Update` | The three Clone patches above copy items into a *target* slot and respect its max stack. This writes the hovered slot's own quantity, so a 40 stack becomes 80 regardless of the max. Assign a hotkey in Tamper, hover a slot, press it: every press doubles (enable and disable run the same script) | Not a click: hover and press. The chain is proven against a synthetic copy in `tests/native/cloneStackScript.test.ts`, not against the live game. The displayed number may not refresh until the slot updates. Avoid cash slots. Quantity is clamped to plausible values (1 to 1,000,000) so a wrong offset does not corrupt memory |

Known limits: the three invisibility patches stack (enable together for full
effect). "Instant" here means the next game-minute tick, not the same frame:
the game only counts these timers when the clock ticks. These replace the earlier
Fast Time cheats (a faster clock), which sped up everything indiscriminately.

## Place Anywhere (build collision/overlap check)

First revision (freezing only `_validPosition`/`validPosition` to 1)
**confirmed not enough** live: with the cheat off, a live
`BuildUpdate_Grid` instance read `_validPosition=0` (red ghost, matches)
and, critically, `_closestIntersection` (`0x58`) `=0` -- **null** -- while
standing outdoors away from any `Grid`. `BuildUpdate_Grid.Place` itself
(not just the UI/ghost-color path) early-returns the moment
`_closestIntersection` is null, before it ever looks at
`_validPosition`: forcing the bool true cannot fix a placement whose
`Place()` call bails out on a missing intersection object. The `Grid`
class also has fixed `Width`/`Height` bounds (`ScheduleOne.Tiles.Grid`),
so a `Grid`-typed item is fundamentally tied to one specific, bounded
tile array -- there is no free-floating "no grid" placement mode for
these items in the data model, only "which existing `Grid`, and where in
its tile array."

`BuildUpdate_Grid.CheckIntersections` computes `_closestIntersection` by
running a physics overlap around the ghost model within
`detectionRange` (`0x38`, live-read default `4.0` units) -- small enough
that stepping a few meters from your property's own `Grid` already
produces a null intersection outdoors. `BuildUpdate_ProceduralGrid`
(walls) has the same `detectionRange` field, same default. `Surface`-typed
items (wall decor etc.) don't have this problem -- `IsSurfaceValidForItem`
raycasts against any valid surface layer, no bounded `Grid` needed --
so they were never the ones failing outdoors.

| Wishlist item | Mechanism found |
|---|---|
| Place Anywhere | `BuildUpdate_Grid._validPosition` `0x47`, `BuildUpdate_Surface.validPosition` `0x40`, `BuildUpdate_ProceduralGrid.validPosition` `0x48` (`int8`, frozen to 1) **plus** `BuildUpdate_Grid.detectionRange` `0x38` and `BuildUpdate_ProceduralGrid.detectionRange` `0x38` (`float`, frozen to `200`, up from the live-confirmed default `4.0`) |

Revised cheat: same 3 capture patches (each class's `LateUpdate`, which
runs after the check that sets these fields), now with 5 targets --
the 3 validity bools plus 2 detection-range floats. This is a real,
verified-live extension of a `Grid`/`ProceduralGrid`'s effective reach
(50x, ~4m to ~200m), not a true "no grid anywhere" mode: it lets you
place far from a `Grid`'s own tiles as long as *some* `Grid` exists
within 200 units, but the item still belongs to whichever `Grid` it
attaches to, tile coordinates and all. Genuinely grid-free placement (an
item with no owning `Grid` at all, positioned at an arbitrary raycast
hit in open terrain) is not something this field/bool-level patch
approach can do -- the game's own save/placement data model
(`GridItemData.GridGUID`/`OriginCoordinate`) has no representation for
that; it would need new inserted logic (a Lua script fabricating a
placement path the game never takes), not a patch. Confirmed live this
session: the capture site's bytes match `originalBytes` exactly while
the cheat is off (RVA/signature correct), and the `_validPosition`/
`_closestIntersection` reads above are from the actual live instance,
not assumed. Whether `200` units is "far enough" or introduces its own
problems (attaching to a grid whose tile array bounds don't reach that
far, so the item snaps back near that grid instead of where you're
standing) is untested in-game.

## Not drafted, and why

- **Set XP / rank**: `LevelManager.XP` and `TotalXP` are plain fields, but the
  rank-up is decided in the game's own add-XP path, so writing them would not
  rank you up. It needs a call to that method, which is not something a field
  or patch cheat can do.

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

## Unlock All Shop Items

Found the real gate (was previously "not drafted": the unlock check isn't
a field on `ShopListing`). `ListingUI.UpdateLockStatus` and
`ShopInterface.RefreshUnlockStatus` both call `ItemDefinition.get_IsUnlocked`,
which turned out to be a 3-instruction IL2CPP virtual-dispatch thunk (`mov
rax,[rcx]; mov rdx,[rax+0x1A0]; jmp [rax+0x198]`) rather than real logic --
chased it to the concrete, non-polymorphic implementation:
`StorableItemDefinition.GetIsUnlocked` (every purchasable item derives from
this one class, so one patch covers the whole shop, not per-subclass):

```
cmp byte ptr [rbx+0x88], 0    ; RequiresLevelToPurchase
jnz <check RequiredRank at 0x8c against player rank>
mov al, 1                      ; no rank required -> already unlocked
ret
```

Recipe C-ish early-return: entry replaced with `mov al,1; ret` (`b0 01 c3`,
+3 nops to fill the 6-byte prologue), so every item reports unlocked
regardless of `RequiresLevelToPurchase`/`RequiredRank`, without touching
the rank-check logic itself (left dead, never reached). Unique 46-byte
signature confirmed live via `scan_aob` (1 match) before shipping.
`factory-shopunlock` in the profile. Untested in-game.

Known limit, not covered by this patch: `ShopListing.ConditionalVisibility`
is a separate, per-listing gate (a named boolean game-state variable, e.g.
a quest-progress flag) unrelated to rank -- an item hidden that way will
still not show up in the shop list at all. Only the rank/level lock is
patched.

## No ATM Deposit Limit

Found via the deep-investigation fallback (survey → disasm → trace),
same procedure as Unlock All Shop Items. `ATM`'s static fields
(`DepositLimitEnabled`, `WeeklyDepositLimit`, plus `BreakImpactThreshold`,
`RepairTimeDays`, `MinCashDrop`, `MaxCashDrop`) are compile-time
`const`s: `enumerateIl2cpp` reported offset `0x0` for all of them,
colliding with `WeeklyDepositSum`'s real offset `0x0` -- the tell for a
literal baked into code rather than real storage (the skill's "const
fields have no storage" landmine, confirmed live this time via the
enumerator's own offset field rather than guessed from field naming).
Only `WeeklyDepositSum` is a genuine runtime static (`ATM`'s cached
class-typeinfo global → `+0xB8` `static_fields` → `+0x0`, reset in
`ATM.WeekPass`/`DayPass`).

The real enforcement is in `ATMInterface.UpdateAvailableAmounts`: for
each preset in the `amounts` list it loads `WeeklyDepositLimit` as a
baked float constant (`movss xmm7,[rip+const]` -- a shared rodata
literal, deliberately left untouched since a data constant can be
pooled/reused by unrelated code), computes `WeeklyDepositSum +
candidateAmount` into `xmm0`, then `comiss xmm7,xmm0; setnb dl` decides
whether that amount button is interactable. `ProcessTransaction` and the
deposit RPC never re-check the limit themselves -- confirmed by reading
the whole method, no second comparison against the limit anywhere in the
actual transfer path. So the button-enable gate is the only enforcement,
not just cosmetic graying: an uninteractable Unity button never fires
`onClick`.

Patched the local `setnb dl` (`0F 93 C2`, unique to this one call site)
to `mov dl,1; nop` (`B2 01 90`), leaving the shared constant and the sum
computation alone -- every preset amount stays selectable regardless of
the weekly sum. Unique 43-byte signature confirmed live via `scan_aob`
(1 match). `factory-atm-nodepositlimit` in the profile.

**Follow-up (still needed a second patch):** shipped `factory-atm-nodepositlimit`
alone and the user reported the deposit/confirm button was still disabled.
Second, independent gate found: `ATMInterface.SetSelectedAmount` (run every
time an amount is picked or the +/- buttons change it) computes `remaining =
WeeklyDepositLimit(const) - ATM.WeeklyDepositSum` and does `minss
xmm6,xmm0` to cap the chosen amount at that remaining allowance -- once the
weekly sum is at or past the limit this clamps `selectedAmount` down to 0,
which a downstream `selectedAmount>0` check almost certainly reads to grey
out the confirm button (matches the reported symptom exactly). NOPed the
`minss xmm6,xmm0` (`F3 0F 5D F0`) so the picked amount passes through
unclamped; left the separate floor-clamp right after it alone (only zeroes
the result for a negative caller-supplied minimum, never hit in normal use).
Unique 62-byte signature confirmed live. `factory-atm-nodepositlimit-clamp`
in the profile, ships alongside the first patch -- one keeps the preset
buttons selectable, the other stops the picked value being silently zeroed
back out.

**Second follow-up (still disabled with both patches on):** the user
reported the deposit button was STILL disabled. Found the real, third gate:
`ATMInterface.Update` runs every frame and directly toggles
`menu_DepositButton` -- the actual button clicked first, before ever
reaching the amount-selector screen the other two patches cover -- based on
`ATM.WeeklyDepositSum` vs the baked `WeeklyDepositLimit` constant
(`comiss xmm8,[static_fields]; setnbe dl`). Once the weekly sum reaches the
limit, the whole flow is locked at the entry point regardless of what the
amount-selector patches do downstream -- this was the actual bug both
times the user reported the button still disabled. Patched the local
`setnbe dl` (`0F 97 C2`) to `mov dl,1; nop`, same technique as the first
patch. Unique 63-byte signature confirmed live. `factory-atm-nodepositlimit-mainbutton`
in the profile. All three patches are needed together: main button enabled
(this one) -> preset amount buttons enabled (`factory-atm-nodepositlimit`)
-> picked amount not zeroed back out (`factory-atm-nodepositlimit-clamp`).
Untested in-game with all three on at once.

**MAX preset still capped (separate ask, not a bug report):** the user
pointed out MAX should equal their full cash balance. `GetAmountFromIndex`'s
`-1` case (the MAX sentinel) computes `min(cash-on-hand,
ATMInterface.get_remainingAllowedDeposit())` -- a real named getter, a
*third* independently-compiled instance of the same
WeeklyDepositLimit-minus-WeeklyDepositSum formula (UpdateAvailableAmounts
and SetSelectedAmount each had their own inlined copy; this one's the only
of the three behind an actual property getter). None of the three ATM
patches above touch this call site, so MAX still showed the smaller of
cash-on-hand vs. remaining allowance. NOPed the `minss xmm6,xmm0` (`F3 0F
5D F0`) so MAX returns the raw cash balance, unclamped. Unique 57-byte
signature confirmed live. `factory-atm-max-fullcash` in the profile.

Verified this specific patch's correctness live before moving on: called the
exact two functions GetAmountFromIndex calls (`call_remote_function` on the
object lookup, then `call_remote_function_float` on the Balance getter) and
got back 12563.5 -- matching the player's real cash balance read via
`factory-cash`'s own pointer chain. The underlying value was correct.

**Root cause of the actual "-9000" the user saw (a different, fourth
occurrence):** `ATMInterface.Update` runs every frame while `depositing==true`
and separately fetches the LAST entry in `amountButtons`
(`List.get_Item(count-1)`, i.e. the MAX button specifically), gets its Text
component, and writes `min(cash, get_remainingAllowedDeposit())` into it as
that button's own label -- completely independent of what
`GetAmountFromIndex` returns when the button is actually clicked. Since the
other ATM patches already let `WeeklyDepositSum` grow past the old
`WeeklyDepositLimit` (10000), `get_remainingAllowedDeposit()` now returns a
negative number (10000 - 19000 = -9000 matches exactly), and
`min(12563.5, -9000) = -9000` -- precisely the value reported. This explains
why the *computed selection* was right but the *label the user was looking
at* was wrong: two independent code paths, only one of which was patched.
NOPed the same `minss xmm6,xmm0` pattern here too. Unique 61-byte signature
confirmed live. `factory-atm-max-label-fullcash` in the profile.

**A genuinely different, pre-existing bug, surfaced only once MAX became
correct:** the user confirmed the label now matches cash, but the deposit
itself is greyed out. `ATMInterface.Update` gates `confirmAmountButton`'s
interactable state on `comiss xmm0,xmm7; setnbe dl` where
`xmm0=get_relevantBalance()` (cash on hand) and `xmm7=selectedAmount` --
`setnbe` is SETA (opcode `0F 97`), which requires balance **strictly
greater than** the selected amount, not greater-or-equal. Depositing
anything less than 100% of your cash always left a strict surplus, so this
never mattered before; MAX now legitimately sets `selectedAmount == balance`
exactly, `comiss` sees them equal (ZF=1), and SETA's condition (CF=0 AND
ZF=0) is false, so the confirm button disables itself. This is an
off-by-one in the game's own logic that the ATM patches simply made
reachable (depositing your literal full balance was previously unreachable,
since MAX was always clamped below it) -- not a side effect of any patch
above. Fixed by changing the opcode's second byte from `0x97` (SETA) to
`0x93` (SETAE/SETNB, CF=0 only) -- single byte, same instruction length,
now allows confirming when balance equals the selected amount too. Unique
52-byte signature confirmed live. `factory-atm-max-confirm-strictfix` in
the profile.

**Correction:** further investigation (after the user reported still-greyed
MAX) showed xmm7 at that comparison is actually zeroed (`xorps xmm7,xmm7`)
just before it, not `selectedAmount` -- the gate is really just "cash > 0",
essentially never false, and the SETA->SETAE change has no practical
effect. Harmless, left in place, but it was not the real bug.

**The actual sixth gate**, found by reading `UnityEngine.UI.Selectable`'s
real live field layout (`Button` -> `Selectable`, `m_Interactable` at
`+0xD8`) and confirming the MAX button's own instance had it set to `0` --
then tracing forward from that fact instead of guessing again.
`ATMInterface.UpdateAvailableAmounts` has a dedicated branch for the last
(MAX) slot, completely separate from the generic per-preset loop body
`factory-atm-nodepositlimit` already patched: it fetches
`amountButtons[count-1]` (the MAX button), checks `cash>0`, then does
`call get_remainingAllowedDeposit(); comiss xmm0,0; setnbe dl` and sets
the MAX button's OWN interactable to `dl` -- i.e. MAX is only clickable
while `WeeklyDepositLimit - WeeklyDepositSum` is still positive, entirely
independent of the per-preset check, the `SetSelectedAmount` clamp, and
the confirm-button check. Since the other patches already let
`WeeklyDepositSum` grow past the limit, this permanently disabled MAX
regardless of actual cash -- the real cause of "still greyed out".
Patched this `setnbe dl` (a distinct address from the similar-looking
pattern in the confirm-button check) to `mov dl,1; nop`. Unique 47-byte
signature confirmed live. `factory-atm-max-button-enabled` in the
profile. Untested in-game.

Lesson for next time this pattern shows up: when a fix "should" work but
doesn't, read the actual live UI-component state (here, Unity's own
`Selectable.m_Interactable` field, resolved via `enumerateIl2cpp` walking
`Button` -> `Selectable`'s real field list) instead of re-deriving the
gate from source reading alone -- it pointed straight at
`UpdateAvailableAmounts` having a second, unrelated branch that pure
disassembly skimming had missed.

**Bundled into one toggle.** Confirmed working end-to-end (main button,
every preset, MAX value, MAX label, MAX button itself all correct). Seven
independent `replace` patches were needed because this one wishlist item
turned out to have six separate, independently-compiled enforcement sites
across `ATM`/`ATMInterface` -- not a sign of a messy fix, just how many
places Schedule I's deposit-limit logic is duplicated. Bundled them the
same way `factory-instant-mixing` bundles its two companions: kept
`factory-atm-nodepositlimit` as the one visible cheat and added
`companions: [...]` listing the other six; each of those six now has
`"internal": true` so they're hidden from Tamper's cheat list and
arm/disarm automatically with the single toggle
(`ipc.ts`'s `armPatch`/`patch:arm` calls `companions.enable(patch.id,
patch.companions)` for any patch cheat, not just capture/value ones --
same mechanism, confirmed by reading that code path before relying on it).

## Not drafted: needs real reverse engineering or a script

- **Advance / Rewind 1 Hour** — a relative write to `TimeManager.<CurrentTime>`
  (`int32`, `0x128`, HHMM-style). A fixed `oneshot` cannot add or subtract, so
  this needs a Tamper Lua cheat, or a call to `TimeManager.SetTime`.

## Beta update (2026-10-04)

`GameAssembly.dll` is now timestamp `1791043358`, size 70332416 (was `1786590259`); Unity is still 2022.3.62.
`mcp-server/scripts/checkPatches.js` found 17 of 44 entries broken (14 signatures gone, 1 ambiguous, 1 changed).
All 17 were re-derived from the new code, and the profile now passes `checkPatches` 34/34 (a byte and uniqueness check only).
**None of the re-derived patches has been toggled in-game.**

| Cheat | What changed |
|---|---|
| Captures: PlayerInventory (`0x6931f0`), TimeManager (`0x9f0c50`), ItemUIManager (`0xab6730`) | New prologues, same `Update` hooks |
| Capture: CurfewManager | The `get_IsEnabled` hook matched 2 places. Re-hooked on `CurfewManager.OnUncappedMinPass` (`0x6569f0`), which runs each game minute |
| No Investigate (`0x76cfd0`), Max Relationship (`0x92cfc0`) | Code unchanged, signature bytes only |
| Clone drag (`0xab3afc`), Clone shift-click (`0xab56c7`) | `this` register in `EndDrag` is now rbx, not rdi |
| Instant Chemistry (`0x887bef`) | Now `add [rcx+0x38],esi` forced to 999999; offsets unchanged |
| Instant Growth (`0x81ddcc`) | Multiplies reordered; scale `xmm6` at the `Pot.GrowSpeedMultiplier` load (`+0x3a8`) |
| Instant Mixing Complete (`0x8a7e7f`) | Same logic, `jl` displacement changed |
| Always Open Doors (`0x71f500`) | Chosen by RVA: two `CanPlayerAccess` overloads share the name |
| ATM deposit patches | Same logic, different registers: `UpdateAvailableAmounts` `setnb dl` (`0x9ccca4`), `SetSelectedAmount` `minss xmm7,xmm0` (`0x9cc5e8`, was xmm6), MAX branch `setnbe r14b` (`0x9ccd22`) |
| **Movement Speed (highest risk)** | Old site gone: the `FloatStack` multiplier is now folded into `xmm6` earlier. New site is `PlayerMovement.Move` `movaps xmm0,xmm6` (`0x69918f`), scale `xmm6`; it multiplies movement x (`0x9c`) and z (`0xa4`) right after. Read from disassembly only |

Field offset moved: `TimeManager.TimeSpeedMultiplier` is `0x134` (was `0x13c`, now `_lastMinWaitExcess`); `factory-freezetime` updated.
Every other value-cheat and Lua-chain offset was re-read and is unchanged.

Test first in-game: movement speed (camera bob, sprint), instant growth, instant chemistry, the ATM patches, freeze daytime, no curfew.

## Max Relationship on Sale (2026-10-04)

`factory-maxrelationship` is no longer the read-only `get_NormalizedRelationDelta` trick (it made every NPC *read* as max while on, and nothing was saved).
It now patches `CustomerSatisfaction.GetRelationshipChange` (`0x6fa7f0`) to `mov eax,0x41200000; movd xmm0,eax; ret` (returns +10.0).
`Customer.ProcessHandover` is its only caller; it passes the result unchanged (`xmm8`) to the virtual `NPCRelationData.ChangeRelationship(delta, network=true)`, which adds it to `RelationDelta` and `SetRelationship` clamps to 0..5.
So a handover pushes that customer to max and the value is saved. Unique 32-byte signature. Untested in-game; unknown whether `ProcessHandover` also reaches this call for a rejected handover (it would max those too).

Note: while a patch is toggled on, `checkPatches.js` reports its signature as GONE (the live bytes are patched). Run it with the cheats off.

**Suppliers (Albert Hoover etc.).** Two more patches bundled under the same toggle (`companions`, both `internal`):
`Supplier.MeetupOrderCompleted` (`0x70cc97`, relationship from what you spend in a meetup order) and `Supplier.TryRecoverDebt` (`0x710472`, relationship from repaying debt).
Both compute `delta = amount / divisor * const` and pass it to the virtual `NPCRelationData.ChangeRelationship(delta, true)`; the final `mulss` + `movaps xmm1` is replaced by `mov edx,10.0f; movd xmm1,edx` (rax holds the call target, so edx is used). Unique signatures. Untested in-game. Other supplier relationship routes, if any, are not covered.

## Dealer Customer Limit 20 (2026-10-04)

`Dealer.MAX_CUSTOMERS` is a `const` (offset 0 like the other consts, no storage), inlined as an immediate. `Dealer.AddCustomer` and `AddCustomer_Server` only do a `List.Contains` check, so the cap lives in the phone UI: `DealerManagementApp.SetDisplayedDealer` sets `AssignCustomerButton` interactable to `AssignedCustomers.Count < 10` (`83 79 18 0a` + `setl dl`, RVA `0xa5fd15`).
`factory-dealer-maxcustomers` changes that `0x0a` to `0x14`; its `internal` companion `factory-dealer-maxcustomers-label` (`0xa5f619`) changes the `N/10` label's constant to 20 (inferred from the format call, not read from the string). Per-dealer, applies to all dealers. Untested in-game; no server-side check was found, so I expect more than 10 to stick.

## Recipe calculator (2026-10-04)

`games/schedule-i-recipe-calculator.html` is a single-file offline page (open it in a browser). Its data and rules were read from the beta build: 35 effects, 16 ingredients, 7 base products, one shared `MixerMap`.
Mixing (`EffectMixCalculator.MixProperties`, RVA `0x99e3d0`): each ingredient adds `MixDirection * MixMagnitude` to every existing effect's circle position; if that lands in another circle (first in map order, radius 0.4, within map radius 4) the effect is replaced unless already present; then the ingredient's effect is appended if absent and fewer than 8 effects. Value = `round(base * product(valueMultiplier) ...)` per `ProductManager.CalculateProductValue`; all `valueChange` are 0 and all multipliers 1, so value = `round(base * (1 + sum addBaseValueMultiple))`.
Verified: value formula 7/7 base products; the 2 recipes stored in the game (both only add an effect). **Not verified in-game:** effect replacement, the 8-effect cap, sequential ordering. `UseRandomizedMixMaps` (rotates the map by a seeded angle) was off; the calculator assumes off. The Python-free engine and tests are not in the repo (scratch work).

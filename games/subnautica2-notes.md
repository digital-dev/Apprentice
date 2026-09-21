# Subnautica 2 (`Subnautica2-Win64-Shipping.exe`, UE 5.6.1) — findings

Recorded 2026-09-21 against the running game (read-only; nothing was written to game memory).

## Engine calibration (all auto-discovered by `ueDiscover.ts`; nothing stored in the profile)
- GNames: `lengthShiftCount 6`, `stringOffset 2`, stride 2, 16 block bits. Block 0 starts `None`, then `ByteProperty` (comparison index 3).
- GUObjectArray: chunk array pointer at the global loaded by `48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1`; item stride 24; ~200k objects.
- **FField layout is not the UE 5.1 one**: `Next 0x18`, `Name 0x20`, `Offset_Internal 0x44` (`fieldLayout: "compact"`). UStruct `SuperStruct 0x40` and `ChildProperties 0x50` are unchanged.

## Where the stats live
Gameplay stats are GAS attribute sets (`UWE*AttributeSet`, owned by the actor: `OuterPrivate +0x20`). Each attribute is an
`FGameplayAttributeData` (16 bytes): **BaseValue at +8, CurrentValue at +0xC** (floats). Every creature and some props have their own set,
so the player's is picked with `rootOuterClass: "SN2PlayerCharacter"` (player pawn chain: `BP_Character_01_C > BP_SN2PlayerCharacter_C > SN2PlayerCharacter > SN2BaseCharacter > Character`).

| Set | Attribute (offset) | Player value seen |
|---|---|---|
| `UWESurvivalAttributeSet` | Oxygen 0x48, MaxOxygen 0x58, Food 0x68, MaxFood 0x78, Water 0x98, MaxWater 0xa8 | 135 (max base 45, current 135), 91/100, 87/100 |
| `UWEHealthAttributeSet` | Health 0x50, MaxHealth 0x60, Radiation 0x80, Temperature 0xe0 | 100/100, 0, 20 |
| `UWEMechanicalAttributeSet` | Energy 0x50, MaxEnergy 0x60 | 100/100 |
| `UWEMovementAttributeSet` | MaxWalkSpeed 0x48, MaxSwimSpeed 0x58, DashOxygenCost 0xb8 | 350, 350 base / 450 current, 5 |
| `UWEPhysicalAttributeSet` | Bulk 0x48 | 20 |
| `UWEBehaviorAttributeSet` (creatures only) | Stamina 0x90, Infection 0xb0, Temper 0x60 | not on the player |

## Shipped in `games/Subnautica2-Win64-Shipping.json`
15 `freeze` cheats; disabling restores what each target held when enabled (default restore policy). **All targets resolve live and read
sane values; none has been toggled in-game yet**, so the effect of each is unverified.

| Cheat | Targets |
|---|---|
| Unlimited Health / Oxygen / Never Hungry / Never Thirsty / Tool (suit) Energy | attribute Base+Current on the player's sets |
| Set Player Speed (walk), Set Move Speed (swim) | movement attribute + `CharacterMovement.MaxWalkSpeed/MaxSwimSpeed` |
| Set Jump Height, Set Gravity Strength | `CharacterMovement.JumpZVelocity` (420), `GravityScale` (1) |
| Stable Body Temperature | Health set `InternalTemperature`, `Temperature` held at 20 (damage below 10 cold / above 100 hot) |
| Game Speed 2x / 0.5x | `WorldSettings.TimeDilation`, reached as player -> `^Outer` (its Level) -> `WorldSettings` |
| Freeze Time at Noon | `UWETimeOfDayComponent` on `SN2GameState`: `DayLengthMinutes` 24 -> 100000 and `InitialHour` -> 12. **Guess** from field names (`WorldTimeAtInitialValue`, `InitialHour`); the time formula was not read. |
| Free Dash, No Radiation | `DashOxygenCost` -> 0, `Radiation` -> 0 (meaning assumed from names) |

Path notes: many `World` objects share the name `L_Main` (one per streaming cell), so the first `World` is not the live one; hang world
targets off the player instead. `^Outer` follows `OuterPrivate`. Instance search skips default subobjects (Outer named `Default__X`).

## Not done, and why
- **Instant crafting / easy crafting / easy building.** `UWECraftingRecipe` data assets (255 loaded) hold `CraftingTime` (+0x108) and
  `Requirements` (+0xE0, array of 0x30-byte `{ItemType, NumItems @+0x28}`). Zeroing them means writing every recipe, which the target
  model (one address per target) and the per-target restore cannot do; restoring would need per-address capture. Building cost lives in
  `SN2ConstructableComponent` (`UnpaidCost`/`PaidCost`, `ConstructableParams`) and only exists while something is being built.
  Code patches are the alternative: ~120 sites load a float at +0x108, unsorted.
- **Unlimited Facility Power.** `UWEPowerStorage.CurrentCharge/MaxCharge` and `UWEPowerGeneratorComponent.BasePowerGeneration` exist but
  no storage instance is live until a base is built, so nothing could be checked.
- **Unlock All Blueprints / Databank.** State is in `SN2UnlockPlayerStateComponent.AllUnlockables` and `UWEDatabankWorldSubsystem`;
  changing it properly means calling game functions (`ProcessEvent`), which the app does not have.
- `SN2CheatManager` ships in the build and would cover item spawning and possibly unlocks, but also needs function calls.
- In co-op the first `SN2PlayerCharacter` found may not be the local player.

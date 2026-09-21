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
All eight are `freeze` cheats writing both Base and Current. **Resolved live and value-checked; none has been toggled in-game yet**, so
what each does to gameplay is unverified: health, oxygen, food, water, energy, fast walk/swim, free dash, no radiation.
Worth checking when testing: a freeze may lose to the game's own tick on a drain (the Palworld hunger lesson); the `Fast Walk and Swim`
current value may be recomputed by effects; `Free Dash` and `No Radiation` assume the attribute meaning from its name.

## Not done
- `SN2CheatManager` ships in the build (fields `SN2StartingItems`, `EquipAll_*`, `SpawnAll_*` queues). Its console functions would give item
  spawning, but calling them needs `ProcessEvent` (see `2026-09-17-ue-call-function-design.md`), not built.
- Player stamina, infection and temper are on `UWEBehaviorAttributeSet`, which the player does not have.
- In co-op the first `SN2PlayerCharacter` found may not be the local player.

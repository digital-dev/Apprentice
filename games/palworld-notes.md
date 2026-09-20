# Palworld notes (UE 5.1.1, build timestamp 1789097921, found 2026-09-20)

## Build check
Module timestamp changed from the profile's 1788339267. `mcp-server/scripts/checkPatches.js` on the new build: all 5
existing patches (save-parameter, stamina, tech-points captures, easy-craft, easy-building) still match exactly once.
Their in-game behaviour on the new build has NOT been re-tested.

## Reflection calibration (verified live: decodes "None", resolves classes)
- GNames (FNamePool) = `Palworld-Win64-Shipping.exe` + 0x9481280 : found via `lea` at AOB
  `48 8D 05 ?? ?? ?? ?? EB ?? 48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? C6 05 ?? ?? ?? ?? 01` (first hit). Session address 0x7ff798e81280.
  blockOffsetBits 16, nameEntryStride 2, stringOffset 2, headerOffset 0, **lengthShiftCount 6** (1 is wrong).
- GUObjectArray.Objects: AOB `48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1` (first hit, `mov rax,[rip+rel]`), session 0x7ff798f20990.
  chunksArrayBase = the pointer stored there (heap, changes per session). 65536 per chunk, stride 24, item offset 0.
- Now handled by `src/main/ueDiscover.ts` (2026-09-20): both roots are found from code at attach, nothing stored in the profile.
  Verified live on this build: discovery returned the same GNames and chunk array in ~2 s.

## Field offsets (decimal from ue_resolve_field; hex in brackets)
PalCharacterParameterComponent: bIsInfinitySP 200 [0xC8], bIsEnableMuteki 162 [0xA2], IsImmortality 1840 [0x730]
PalPlayerInventoryData: NowItemWeight 388 [0x184], MaxInventoryWeight 392 [0x188] (500.0 was the CDO default), PassiveBuffedMaxWeight 408 [0x198]
PalCharacterMovementComponent: WalkSpeed_Default 8724 [0x2214], RunSpeed_Default 8728 [0x2218], SprintMaxSpeed 4448 [0x1160]
Instances: at the title screen only `Default__` objects exist; in a world the player is a Blueprint SUBCLASS of PalPlayerCharacter, so
instance search must match subclasses (SuperStruct chain), not just ClassPrivate == class.

## Live values in a world (read via the shipped root-path resolver, 2026-09-20)
MaxInventoryWeight 1150, CharacterMovement WalkSpeed_Default 87.5, RunSpeed_Default 350, SprintMaxSpeed 500, bIsEnableMuteki 0.
Resolve time ~2.5 s per uncached class, then cached.

## Shipped as root-path targets (resolve verified live; writing and in-game effect NOT yet tested)
- palworld-inf-carry-weight: PalPlayerInventoryData.MaxInventoryWeight float freeze 99999
- palworld-invincible: PalPlayerCharacter -> CharacterParameterComponent (on PalCharacter) -> bIsEnableMuteki int8 freeze 1
- palworld-fast-run: CharacterMovement RunSpeed_Default 700 + SprintMaxSpeed 1000. Which of the movement fields the game actually
  consumes is not confirmed from code; if it does nothing, read the movement update to find the consuming field.

## Carry weight (read live with the cheat on)
Inventory UI shows MaxInventoryWeight (+0x188), but the encumbrance check uses MaxInventoryWeight_Cached (+0x18C, offset 396), which stayed 1150
with NowItemWeight ~1887. The cheat now freezes both. In-game effect of the second target not yet confirmed.

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
CORRECTION: the game was at the title screen. The single PalPlayerCharacter / PalPlayerInventoryData found were the class default
objects (`Default__...`), so the 500.0 read was the CDO default, not a live player value. No live player instance has been read yet.

## Shipped as root-path targets (untested in-game, need a loaded world)
- palworld-inf-carry-weight: PalPlayerInventoryData.MaxInventoryWeight float freeze 99999
- palworld-invincible: PalPlayerCharacter -> CharacterParameterComponent (on PalCharacter) -> bIsEnableMuteki int8 freeze 1
- Speed (WalkSpeed_Default/RunSpeed_Default/SprintMaxSpeed on CharacterMovement, inherited from ACharacter) not added: no live default value read yet.

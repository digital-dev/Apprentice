# Valheim notes

## After the major update (2026-09-20)

`mcp-server/scripts/checkPatches.js <pid> games/valheim.json` re-checks every patch against the running game (read-only apart from
compiling the keyed methods). Result: 6 of 7 patches survived (durability, food timer, damage multiplier, craft, unlock build pieces,
skill XP); all 8 value cheats still resolve. `patch-maxitemstacks1` lost its signature: the code is unchanged but the compiler chose
different registers (`sub eax,r15d; mov [r14+0x38],eax` became `sub eax,[rbp-0x80]; mov [r13+0x38],eax`), so the entry now uses
`r13` and the new signature. `m_stack` is still at `ItemData+0x38`.

Game code lives in `assembly_valheim` (1311 classes); `Assembly-CSharp` is a 34-class stub. There are two classes named `Player`.

## Factory run (2026-09-20)

`author_cheats` needed two fixes to work here: scan every `assembly_*` assembly (it only looked at the stub), and rank the stat itself
above action-cost variants (it drafted `m_jumpStaminaUsage`, the price of a jump, as stamina). With those it drafts `m_stamina`,
`m_eitr` and `m_godMode`, identical to the hand-built profile. Its `Player.m_health` draft is doubtful (current health is not a plain
field in Valheim) and `water` matches a swim-depth field, so both are ignored.

## Promoted (2026-09-20, Player fields)

`Longer Auto Pickup Range` (`m_autoPickupRange`, read by `Player.AutoPickup`), `Longer Build/Remove Reach` (`m_maxPlaceDistance`, read by
`Player.CopyPiece` / `RemovePiece`) and `Longer Interact Reach` (`m_maxInteractDistance`, read by `Player.FindHoverObject`). Not run in-game.

## Drafted, not promoted (`valheim.draft.json`)

- `Fly Mode` (`m_debugFly`, +0x978): `Player.IsDebugFlying` returns it for the local owner (`m_nview.IsOwner()`), otherwise it reads a synced
  `"debugFly"` ZDO bool; there is no cheat gate. `Character.UpdateDebugFly` consumes it through a virtual call that was not traced.
- `Ghost Mode` (`m_ghostMode`, +0x97A): `Player.InGhostMode` returns it. No direct caller among the BaseAI/MonsterAI targeting methods
  (virtual dispatch), so that enemies really ignore it is not shown from code.

Not checked: `m_placeDelay`, `m_dodgeAdrenaline` and the rest of `Player`.

Stability: compiling all of `Player` (300+ methods) in one burst crashed the game (`0xe0000001` in KERNELBASE, offset `0xc41ca`, the same
fault as Aviassembly). `monoReaders.js` now caps and paces the pass; use `METHODS=<regex>`. The targeted searches above (about a dozen
methods each) were fine.

## "Picked up an item affected by dev commands, achievements disabled" (2026-09-20)

Items carry a flag, `ItemData.m_cheated` (+0x61), which `ItemData.Save` writes, so it persists in the save. `Inventory.ItemCheated` /
`AnyCheatedItem` query it. Live inventory dump (`scripts/valheimInventory.js <pid>`): the only flagged items were `ironnails`, `tar` and
`frostwood`, all with normal stacks. Every item at 4000 durability (Infinite Weapon Durability, `DUR>MAX`) was NOT flagged, and no stack
exceeded its maximum, so the durability and Infinite Items patches do not set it.

The setter found: `Piece.DropResources` stores `m_cheated = 1` on the resources a removed piece drops, when the piece's ZDO bool
`0xF6DA2160` is set (two sites, +0x7b6 and the second read at +0xbef). `Player.PlacePiece` writes that bool (`ZDO.Set(0xF6DA2160, true)`)
at +0xbfd when the piece is placed, behind a guard on a stack-passed local bool that was not resolved to a specific cheat. `Player.NoCostCheat()`
is `return m_noPlacementCost` (+0x970), the field our No Placement Cost cheat freezes, but `PlacePiece` does not call it directly, so
that link is inferred: the flagged items are exactly building materials, and no other shipped cheat touches placement except
Easy Crafting (`HaveRequirements`) and Unlock All Build Pieces (`IsPieceAvailable`).

### Anti-tag patches are companions of the cheats that cause the tag (2026-09-20)

Requested: no separate cheat; the fix rides with the cheats that cause the tag. The app now supports `companions` (ids of `internal` patches) on a
cheat; they arm with it and disarm with the last cheat using them (`src/main/companions.ts`, wired into every toggle, hotkey, delete and
process-exit path in `ipc.ts`). `mono-no-placement-cost` (the game's `NoCostCheat` / `PlacementCostDisabled` both read the field it freezes),
`mono-craft-without-materials` and `mono-unlock-all-build-pieces` carry four hidden patches:

- `cheat-tag-pieces-1` / `-2`: two sites write `ZDO.Set(0xF6DA2160, true)` when a piece is placed (`mov r8d, 1` -> `xor r8d, r8d`). One is in
  `Player.PlacePiece`; the second, in a different method, was found by a signature scan and not yet identified (it is followed by
  `cmp dword [rbp+0x38], 2`). Its two signatures differ only in the nop encoding after `cmp dword [rax], 0`.
- `cheat-tag-drops-1` / `-2`: the two `mov byte [rax+0x61], 1` stores in `Piece.DropResources` (`ItemData.m_cheated`) become a 4-byte nop.

They are found by signature, never by a fixed method offset (new engine option `monoSearch`, see `PatchCheat.monoSearch`: compile the method, scan its own
range, require exactly one match and the original bytes there). The two drop patches and `cheat-tag-pieces-1` use it (`Piece.DropResources`,
`Player.PlacePiece`), because those methods are not compiled until first used: on a fresh game a plain signature scan finds nothing for them.
`cheat-tag-pieces-2` is signature-only (its method is unidentified but already compiled at startup). Reason for not using offsets: the same code sat at different offsets after a game restart (`DropResources` stores moved from
`+0x7b6`/`+0xc3a` to `+0x7c6`/`+0xc52`), which would have made a method-offset patch refuse to apply.

Verified on a running game: `cheat-tag-pieces-2` matches exactly once; the drop signatures matched once on the previous instance. NOT yet verified: `monoSearch` end to end in
the app (it compiles the method in the game), and `cheat-tag-pieces-1` matching once inside `PlacePiece`. Not covered: items already carrying the flag.

Stability: compiling about 60 methods across `Player`, `Piece` and neighbours crashed the game a third time (16:08, the same KERNELBASE fault);
earlier searches of about a dozen methods were fine. Do not compile methods in Valheim without an explicit go-ahead; signature scans are safe.

Verified live (2026-09-20, after the user turned on No Placement Cost and placed and dismantled a piece): all four patches applied, each matching exactly
once in patched form and zero times in original form, so `monoSearch` works end to end in the app. The inventory afterwards showed no newly flagged items
(only the `ironnails` stack from before stayed flagged). Not shown: a piece that was tagged BEFORE the patches, dismantled with the drop patches on.

### Correction: the reader searches were capped (2026-09-20)

`monoReaders.js` read only the first 2 KB of each method until this date, so any search of a large method looked at its start only. Re-running the
`ItemData.m_cheated` (+0x61) writer search with the cap fixed: the crafting, placement and pickup batch is still empty, but `CharacterDrop.DropItems`
also stores to it (`mov [rax+0x61], sil`, `sil` being the caller's fourth argument), so creature loot can flag items too. Who passes that argument, and
whether one of our cheats influences it, is not yet known; the earlier statement that `Piece.DropResources` is the only writer was too strong.
The anti-tag companions cover `Piece.DropResources` only.

### Easy Build (was No Placement Cost)

Renamed. It now carries a companion, `easy-build-no-station-extension`: in `Player.UpdatePlacementGhost` the game sets `m_placementStatus = 7`
(`$msg_extensionmissingstation`, "needs to be placed near the appropriate crafting station") when a station extension has no station in range; the patch
writes `0` (Valid) at that one store (`+0xb3b`, `monoSearch`, signature verified unique). NOT covered: the ordinary "requires a workbench" rule for regular
pieces, which lives in the second `Player.HaveRequirements` overload; overloads cannot be selected by name in this engine or my tools.

### Always Hidden flicker (2026-09-20)

The old cheat froze `Player.m_stealthFactor` (+0xae8) at 0 every 100 ms while the game rewrites it every frame, so the value alternated and the HUD's eye and
stealth bar (`Hud.UpdateStealth`, driven by `Player.GetStealthFactor`) flickered. The game reads the field through `Player.GetStealthFactor` (the virtual the HUD
calls, vtable +0x1F0); for the local owner it returns `[this+0xAE8]`. Always Hidden is now a `replace` patch (`monoSearch`, signature unique) that swaps that
`movss xmm0, [rsi+0xAE8]` for `xorps xmm0, xmm0` + nop, so the getter returns 0 and the field is left alone (same hotkey, `num7`). Enemy AI and the HUD both ask the
getter, so both see 0 steadily. Not run in-game: whether the eye/bar are then steadily shown or hidden depends on HUD logic I did not read in full (it shows the bar
from the factor and two timers, `m_timeSinceTargeted` +0xadc and `m_timeSinceSensed` +0xae0).

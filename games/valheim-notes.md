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

### Patches that stop the tagging (2026-09-20)

Requested: stop the game recording cheat use on items. Three `replace` patches (all off until toggled), each verified against the running game:

- `mono-no-cheat-tag-pieces`: `Player.PlacePiece+0xc07`, `mov r8d, 1` -> `xor r8d, r8d` (+ 3-byte nop). New pieces are no longer tagged (`ZDO.Set(0xF6DA2160, false)`).
- `mono-no-cheat-tag-drops-1` / `-2`: `Piece.DropResources+0x7b6` and `+0xc3a`, the two `mov byte [rax+0x61], 1` stores that set `ItemData.m_cheated`,
  replaced by a 4-byte nop. Pieces already tagged in an existing world stop flagging their drops.

Scope: a search of the crafting, placement, pickup, drop and inventory methods (`InventoryGui.DoCrafting`, `Player.ConsumeResources`, `Humanoid.Pickup`,
`ItemDrop`, `Inventory.AddItem`, `Container`/`Smelter`/`CookingStation`/`Fermenter` drops, `CharacterDrop`, `Pickable` ...) found no other store to
`ItemData+0x61`. Not covered: methods outside that list, and items already carrying the flag (they stay flagged; the patches do not clear them).

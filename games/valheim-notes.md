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

## Drafted, not promoted (`valheim.draft.json`)

`Longer Auto Pickup Range` (`m_autoPickupRange`, read by `Player.AutoPickup`) and `Longer Build/Remove Reach` (`m_maxPlaceDistance`,
read by `Player.CopyPiece` and `RemovePiece`). Seen in a compile pass that then crashed the game, so the rest of `Player` (`m_debugFly`,
`m_ghostMode`, `m_maxInteractDistance`, `m_placeDelay`, `m_removeDelay`) was not checked. Not run in-game.

Stability: compiling all of `Player` (300+ methods) in one burst crashed the game (`0xe0000001` in KERNELBASE, offset `0xc41ca`, the same
fault as Aviassembly). `monoReaders.js` now caps and paces the pass; use `METHODS=<regex>`.

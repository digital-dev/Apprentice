# Native-game cheat factory (Elden Ring first)

`author_cheats` handled Unity Mono and IL2CPP only. Native games (Elden Ring: `native-unknown` in
`fingerprint_process`) have no class or field metadata, so the wishlist cannot be matched by name.

## Approach

Data-driven, per game, in `mcp-server/src/factory/nativeGames.ts`:

- **Roots**: a signature for a `mov reg,[rip+rel32]` that loads a manager pointer. The factory requires exactly one
  match in the main module, decodes the rel32, and gets the static slot's RVA. Signatures survive patches; RVAs do not.
- **Cheats**: per existing category id (`health`, `stamina`, `mana`, `money`), the offset chain(s) from a root, the
  data type, freeze value and plausible range. Several chains make one multi-target cheat (current and max).

`buildNativeFactory` (pure, `nativeBuild.ts`) resolves roots, reads every chain live through the same
`[moduleBase, rva, ...offsets]` form Tamper and `verify_cheat` use, keeps only plausible reads, and drafts
`ChainTarget`s by RVA. `tools/authorNative.ts` picks the game whose roots all resolve and writes
`<profile>.draft.json`. `author_cheats` dispatches to it for `native-unknown`. Read-only on game memory.

Landmine categories (`manualReview`) still come back as manual; a category the game has no chain for is `notFound`;
a chain that reads null or implausible (not in a save, stale offsets) is `unresolved`.

## Adding a game

Add a `NativeGame` entry. Find roots by disassembling what reads the known manager; find chains by walking pointers
from the root while the value is visible on screen. Anything that needs a code patch (no-damage, one-shot, crafting)
stays a hand-authored profile entry: the factory drafts value cheats only.

## Verification

Elden Ring build 2.6.2.0: both root signatures unique and resolving to `0x3d65f88` (WorldChrMan) and `0x3d5df38`
(GameDataMan); the four drafted cheats' chains equal the ones in `games/start_protected_game.json` and read
plausible live values. Not yet toggled in-game through Tamper.

## Finding more cheats offline (Elden Ring)

Record a module-only snapshot (`MODULE=<exe> node mcp-server/scripts/recordSnapshot.js ...`; a full dump crashed the game),
then work offline with `mcp-server/scripts/`: `mineRoots.js` / `mineChains.js` (who loads a root, which offsets follow),
`flagXrefs.js` (which byte flags the code reads), `findFieldAccess.js` (who touches `[reg+disp]`), `findCallersSnap.js`,
`traceSnap.js` (disassembles through the obfuscator's `jmp` chains), `deriveFlagRoot.js` (unique signature for a flag).

What a flag means comes from its consumers: a getter that tests a `ChrData+0x19b` bit or a debug flag, and what its callers do.
Findings: bit 0x02 guards damage application (`No Damage`); bit 0x01 is a hit/target filter (not shipped, meaning unclear);
debug flags follow the engine's usual order (a2 exterminate, a4 stamina, a5 FP, a6 ammo anchored), so a3 is item consumption.
Cheats resting on this alone say so in their `lookFor`.

### Naming flags from the game's own strings

The exe carries a UTF-16 debug-flag name table (`GameData.PlayerNoDead`, `PlayerExterminate`, `PlayerNoGoodsConsume`, `AllNoDamage`,
`AllNoStaminaConsume`, `AllNoMpConsume`, `IsNoArtsPointConsume`, ...). `scripts/nameFlags.js` maps flag to thunk to name where the
obfuscator's jumps allow (aa = AllNoDead, ae = AllNoMove); the rest follow the declaration order (a0 PlayerNoDead, a1 PlayerHorseNoDead,
a2 PlayerExterminate, a3 PlayerNoGoodsConsume, aa..ae the All* flags) and cross-checks: getter 0x437470 is IsNoDead (bit 0, aa, player+a0),
a3 and b2 feed the same item-consume argument, a2/a4/a5/a6/b1 match the user-verified cheats. Unmapped: a7, af, b0, b3-b5, c5-cf.

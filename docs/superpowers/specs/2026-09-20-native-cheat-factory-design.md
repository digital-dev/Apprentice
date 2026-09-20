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

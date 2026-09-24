# Contributing

PRs welcome — bug fixes, new cheats for existing games, or support for a new
game's Mono/IL2CPP/Unreal layout.

1. Fork, branch off `master`.
2. Read [`CODEBASE_MAP.md`](CODEBASE_MAP.md) first. It's written for someone
   picking this up cold — the layer map, the four `CheatTarget` kinds, the
   nine patch modes, and the non-negotiable safety rules (never displace a
   RIP-relative instruction, never guess on an ambiguous signature, always
   restore on quit) — and *why* each of those rules exists. Read it before
   touching `native/src` or `patchEngine.ts` especially; several of those
   rules were learned by crashing a live game.
3. Match the surrounding code's comment density and idiom — this codebase
   explains *why*, not just *what*, and PRs are expected to keep that up.
4. Run the full test suite before opening the PR:
   ```bash
   npx vitest run
   npx tsc --noEmit
   npm run build
   ```
   The native test harness is real but limited — a static MSVC binary, not a
   Mono JIT target — so passing there is necessary but not sufficient for
   anything touching signatures, injection, or code-cave layout. Say in the
   PR if you validated a change in-game and against which game/build.
5. Open the PR against `master` with a clear "what and why." Small, focused
   PRs review faster than one that bundles an unrelated refactor with a
   feature.

**Adding a game profile?** See
[README's "Contributing a profile to this repo"](README.md#contributing-a-profile-to-this-repo)
— get it verified in-game first, keep the file schema-2 shaped, and note the
game version/build a module-anchored patch was captured against.

**Found a bug but not fixing it yourself?** Use the
[bug report template](../../issues/new/choose) — include the game, the cheat
(if applicable), and what you expected vs. what happened.

By participating in this project you agree to abide by its
[Code of Conduct](CODE_OF_CONDUCT.md).

# Aviassembly — investigation notes

No `aviassembly.json` profile exists yet — this records what a follow-up
session needs to pick up cold, and why there's no working cheat despite a
real investigation.

**Game**: Unity 6000.0.69 (Mono, not IL2CPP), Steam, Facepunch.Steamworks.
Build/model your own airplane, fly cargo contracts. `mono-2.0-bdwgc.dll` is
the runtime.

## The blocker: Singleton<T>

Every economy/state manager (`MoneyManager`, `ResearchManager`, `GameManager`,
`ContractManager`, ...) is a MonoBehaviour that inherits Unity's generic
`Singleton<T>` for its static instance pointer — the class itself declares no
static field of its own (`mono_list_field_names` on e.g. `MoneyManager`
returns only `["money"]`). The actual static storage lives on the *inflated*
`Singleton<MoneyManager>` type, which is a runtime-only MonoClass, not a
TypeDef in the assembly's metadata table — so it's unreachable by the game-memory
MCP's `mono_resolve_class`/`mono_static_field_address` (which only walk
TypeDefs). Confirmed dead end, not a matter of retrying: same result for
`MoneyManager`, `ResearchManager`, `GameManager`, `InputManager`,
`AudioManager`, `GraphicsSettings`, `SteamworksManager` (also `mono_list_method_names`
returned `[]` for every one of these — Assembly-CSharp classes' methods aren't
enumerable through this MCP either, so a code-patch cheat has no method
address to anchor to).

This is the same reason Valheim's cheats work and Aviassembly's can't yet:
Valheim's `Player.m_localPlayer` is a genuine plain static field declared
directly on `Player`. Aviassembly has nothing structurally equivalent that
this tooling can reach.

## What field types actually are (confirmed, don't re-guess)

Cross-referenced against a real reverse-engineered save-file parser
([L-at-nnes/aviassembly-tools](https://github.com/L-at-nnes/aviassembly-tools),
a `.plane` save editor — legitimate, no live-memory cheat, no scam links) and
verified live in-process:

| Field | Type | Notes |
|---|---|---|
| `MoneyManager.money` | **`float`** | Not int32 — this was the actual reason 6 straight int32 value-scans failed to converge across three separate crash/relaunch cycles. Live value reads as `224.99990844726562` for a displayed "225", i.e. genuinely float-backed, not tweened (confirmed: the HUD number jumps, doesn't animate). |
| `ResearchManager.researchPoints` | `int32` ("scrap" in the save format) | |
| `ResearchManager.advancedResearchPoints` | `int32` ("advancedScrap") | |
| `FuelTank.capacity` | not yet verified live | |
| `Battery.volume` | not yet verified live | |
| `CargoInventory(UI).cargoSpace` | not yet verified live | |

Once scanning as `float` and bounding the sweep (see below), money converged
in one narrow: two addresses tracked the exact same value in lockstep across
three independent changes (225→300→225) — that's the real field (likely one
copy plus a UI-bound mirror). Addresses are **not reusable** — pure GC-heap,
no module anchor, different every launch.

## Why this can't become a `games/aviassembly.json` entry yet

The schema (see `src/main/profile.ts`) needs either a module+RVA offset chain
(stable across restarts because a module's base is fixed) or a mono
`className`/`staticFieldName` root (re-resolved fresh on every attach). A bare
heap address has neither — Apprentice has no way to relocate it on the next
launch. Getting a real cheat here needs one of:

1. A fix to the mono MCP tooling to resolve inflated-generic (`Singleton<T>`)
   static fields — this is the one that unblocks everything else too.
2. An actual pointer chain to the `MoneyManager` instance found some other
   way (e.g. static analysis of decompiled IL, outside this toolset).
3. Accept a manual per-session re-scan workflow using Apprentice's own
   Scanner screen (same mechanism used here) — works today, just not
   persistent.

## Process stability (separate issue, not caused by scanning)

Aviassembly crashed repeatedly across this investigation — faults inside
`mono-2.0-bdwgc.dll` (`0xc0000005`) and once in `KERNELBASE.dll`
(`0xe0000001`), per Windows Event Log. Initially suspected as caused by the
scanning tool; on rereading `native/src/scanner.cc` this doesn't hold up
mechanically (scan is read-only `ReadProcessMemory`, skips `PAGE_GUARD`
regions, never writes) — more likely this build is just unstable on its own.
Not confirmed either way; worth checking Steam file integrity / GPU driver /
`Player-prev.log` if it keeps happening.

## Apprentice changes made as a result of this session

`scan_first`/`scan_next`/`scan_aob` now check the process handle is still
alive before walking memory (clear "process exited/crashed" error instead of
a misleading empty result on a stale handle — this cost most of the wasted
turns in this session, independent of the money-scan problem above).
`scan_first` also gained optional `rangeStart`/`rangeEnd` bounds, matching
`scan_aob`'s existing convention — cuts sweep time and noise on a large
GC-heavy Mono heap like this one. Both are additive; neither touches the scan
algorithm Valheim/Elden Ring profiles depend on (550/551 tests pass, 1
pre-existing unrelated skip).

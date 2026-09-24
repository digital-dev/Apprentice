<p align="center">
  <img src="App%20Icon/Apprentice.png" alt="Apprentice" width="220">
</p>

# Apprentice

A free, open-source Windows game trainer — an offline memory editor and
cheat engine for PC games, for when you want a Cheat Engine/WeMod
alternative that's transparent about what it's doing, doesn't phone home,
and doesn't require a closed-source client to use cheats someone else
built. Electron + React + TypeScript over a C++ N-API addon that talks to a
target process's memory directly — no server, no telemetry, no
always-online requirement.

Two ways to cheat:

- **Value cheats** — find an address, write it repeatedly (a "freeze"), write
  it once ("one-shot"), or just display it, read-only. A cheat can also be
  *anchored*: a small capture patch records the game object it belongs to, and
  the cheat reads or writes a field of that object (optionally following a
  chain of pointer fields first). A display cheat can decode that field as
  text instead of a number — Phasmophobia's ghost-location cheats read a room
  name straight out of the game's own string data. That keeps cheats working
  across restarts in games with no readable metadata, such as Unity IL2CPP and
  Unreal.
- **Code patches** — rewrite the instruction that writes a value, so the game
  itself never puts the old value back. NOP it out, replace it, force a
  fixed result, or skip a method entirely for one object.

Ships with cheat sets for eight games, one profile each in `games/`:

| Game | Cheats | Engine / notes |
|---|---|---|
| Valheim | 18 | Mono JIT (`valheim.json`) |
| Elden Ring | 14 | Native, pointer-chain value cheats (`start_protected_game.json`, named for its EAC-protected executable) |
| Palworld | 11 | Unreal (`Palworld-Win64-Shipping.json`) |
| Aviassembly | 12 | Unity/Mono (`aviassembly.json`) — see `games/aviassembly-notes.md` |
| Schedule I | 26 | Unity IL2CPP (`Schedule I.json`) — see `games/schedule-i-notes.md` for how each was found |
| Green Hell | 14 | Unity IL2CPP (`GH.json`) |
| Phasmophobia | 8 | Unity IL2CPP (`Phasmophobia.json`) — see `games/phasmophobia-notes.md`; several of these read live game state as text (e.g. the ghost's current room) rather than a plain number |
| Subnautica 2 | 20 | Unreal Engine 5.6, reflection-based value cheats (`Subnautica2-Win64-Shipping.json`) — see `games/subnautica2-notes.md` |

The newest Schedule I cheats (invisibility, no arrest, clone items, the instant
timers and others) were built from the game's code and checked against a recording
of the game build, but not every one has been confirmed in-game yet; treat any you
have not tried as unproven. The engine isn't tied to any of these games — see
[Sharing cheats](#sharing-cheats) for adding your own, or
[Using the cheat factory](#using-the-cheat-factory-author_cheats) to have an AI
agent draft a Unity game's cheat list for you.

> Windows only. The native addon's injection path is Win32; Linux is stubbed
> out but not implemented (see `native/src/platform/platform_linux.cc`).

---

## Install

Grab the latest `Apprentice-Setup-<version>.exe` from [Releases](../../releases)
and run it — no admin rights needed, it installs to your user profile.
Prefer to build it yourself, or want to hack on it? Keep reading.

## Building from source

Requirements: Node.js 26 to run the tests (they load a TypeScript worker and the compiled
`.node` addon natively), a recent `npm`, and the
[Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
(C++ workload) for compiling the native addon. The addon builds under Node 22 (what CI uses)
and, with the current node-gyp 13, under Node 26 as well; it is N-API, so a build from either
loads under both.

```bash
npm install
cd native && npx node-gyp configure && npx node-gyp build && cd ..
npm run build
```

`package.json`'s `allowScripts` lists the exact package versions whose install scripts may
run (Electron's binary download and esbuild). **When you upgrade Electron or esbuild, update
that entry too**, or `npm` skips the script and the binary is never downloaded.

Run it with `Apprentice.cmd` at the repo root, or package a real installer:

```bash
npm run dist
```

produces `release\Apprentice-Setup-<version>.exe` (NSIS, no admin required).

**Stop Apprentice before rebuilding the addon** — a running instance locks
`memory_addon.node` and the link fails with `permission denied`.

### Running the tests

```bash
npx vitest run      # unit + native-harness tests
npx tsc --noEmit     # type check
npm run build        # production bundle actually compiles
```

### CI and releases

`.github/workflows/ci.yml` runs on every push and pull request: it builds the native
addon, builds the MCP server, type-checks, compiles the production bundle, and runs the
whole test suite (native-harness tests included) on a Windows runner.

**To publish a release, bump `version` in `package.json` and push it to `master`.** If
there is no release for that version yet, CI builds the installer, creates the tag
`v<version>` and a GitHub Release (a prerelease when the version has a `-`, like
`0.1.2-beta`), attaches `Apprentice-Setup-<version>.exe` plus a `SHA256SUMS.txt`, and lets
GitHub generate the notes. Those list the merged pull requests since the previous release
and link the full comparison, so work pushed straight to `master` shows up only as that
comparison link. A push that doesn't change the version publishes nothing.

To check that a build works without publishing, run **Actions → CI → Run workflow** on
any branch other than `master`: it builds the installer and attaches it to the run as an
artifact (kept for 3 days) instead of releasing it.

The installer is not code-signed, so Windows SmartScreen will warn on first run. The
workflow builds the addon on the Windows 2022 image with Python 3.11 and Node 22, and runs
the tests on Node 26. Those pins were chosen for the old node-gyp 9; the comments in the
workflow explain why. node-gyp is now 13, so some may no longer be needed, but that has not
been tried in CI, so they are left as they are.

### The game library

Opening Apprentice shows your installed Steam games as cover tiles, with the ones
it has cheats for first. Pick a game to see its cheats; if it is not running, Play
starts it through Steam and Apprentice attaches by itself when it opens. Nothing is
changed in a game until you switch a cheat on.

Steam is found automatically, wherever it is installed: the registry entry first,
then the usual folders, then every library folder Steam lists (so a second drive
such as `D:\SteamLibrary` is picked up with no setup). Cover art comes from Steam's
own on-disk cache, so the library works offline and Apprentice makes no network
requests for it; a game with no cached art gets a coloured placeholder. Games from
other launchers are not listed, but any running process can still be attached from
**Tools -> Attach to process**.

### Fixture replay: testing signatures against real games offline

Signature building and patch relocation are where real games broke things the
harness never could (identical JIT copies, code near a region edge). Fixture
replay records a game's executable memory once, then re-runs the real signature
builder and `PatchEngine.locate()` against that recording on any machine.

```bash
# with the game running; each trailing argument is one patch site to test
node mcp-server/scripts/recordSnapshot.js <pid> valheim <build-label> \
    fixtures/snapshots/valheim-<build>.snap <patchId>:<address>:<length>
```

Add the site to `tests/fixtures/manifest.json` (signature, offset, original
bytes, snapshot SHA-256), then `npx vitest run tests/replay`. Snapshots contain
the game's code, so they stay local (`fixtures/snapshots/` is gitignored and the
recorder refuses to write elsewhere in the repo); a site whose snapshot is not on
your machine is skipped, and CI runs only the synthetic tier
(`tests/main/replay.synthetic.test.ts`). A snapshot is a best-effort copy of a
running process, so record with the game idle at a menu, not mid-load.

### The native test harness

`tests/native/*.test.ts` don't touch a real game — they drive
`test-harness/harness.exe`, a small standalone Windows binary
(`test-harness/harness.c`) built for exactly this: a real process with known
values at known addresses to scan for, freeze, patch, and watch. Each test
file `spawn()`s it directly (`spawn(path.resolve('test-harness/harness.exe'))`)
and talks to it over stdin/stdout — `npx vitest run` handles all of this for
you, there's no separate step to start it yourself.

The protocol is one command per line in, one `OK <result>` (or an error) per
line out. A few of the commands, for a sense of what's being exercised:

| Command | What it does |
|---|---|
| `drainloop` | Spin-writes a counter down — `patch_ops.test.ts` NOPs the write and checks it stops draining. |
| `forceloop` / `shieldloop` | Keep re-asserting a value — proves a `force`/`guard`-mode injection actually pins it. |
| `tight_write` | A real `movss [reg], xmm` store, back-to-back with no slack — the tightest case `write_watch` has to decode correctly. |
| `bigalloc` / `bigcode` (+`free` variants) | Allocate an 8 MiB data/executable region, replying `OK <0xbase>` — used to prove chunked region reads never drop a value straddling a 4 MiB chunk boundary. |
| `loaddll` / `loaddll2` / `unloaddll` | Load/unload a real DLL (`probe.dll`/`probe2.dll`) into the harness process — what `module_info.test.ts` uses to prove module-anchored patches survive a DLL reloading at a different base. |

Full command set and exact reply formats live in `harness.c` itself — it's
short and worth skimming before adding a test that needs a new one.

**Two hazards** if you're adding tests around it (see `CODEBASE_MAP.md` for
the full explanation): `cave_ops.test.ts` and `module_info.test.ts` must each
keep exactly one top-level `beforeAll` — a second one spawning its own
`AsyncWorker` reliably segfaults the vitest worker — and scans in the native
tests are one-shot, keyed off a field's initial value, so the first test to
touch a given field "wins" it.

If you change `harness.c` itself, rebuild it **from PowerShell, not Bash**
(Bash won't run `vcvars` and fails silently):

```powershell
& cmd.exe /c 'call "...\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'
```

then delete `harness.obj` and confirm the timestamp on `harness.exe` changed.

---

## Contributing

PRs welcome — bug fixes, new cheats for existing games, or support for a new
game's Mono/IL2CPP layout.

1. Fork, branch off `master`.
2. Read [`CODEBASE_MAP.md`](CODEBASE_MAP.md) first. It's written for someone
   picking this up cold — the layer map, the eight patch modes, the
   non-negotiable safety rules (never displace a RIP-relative instruction,
   never guess on an ambiguous signature, always restore on quit), and *why*
   each of those rules exists, are all there. Read it before touching
   `native/src` or `patchEngine.ts` especially — several of those rules were
   learned by crashing a live game.
3. Make the change. Match the surrounding code's comment density and idiom
   — this codebase explains *why*, not just *what*, and PRs are expected to
   keep that up.
4. Run the full test suite (`npx vitest run`, `npx tsc --noEmit`, `npm run
   build`) before opening the PR. The native test harness is real but
   limited — it's a static MSVC binary, not a Mono JIT target, so passing
   there is necessary but not sufficient for anything touching signatures,
   injection, or code-cave layout. Say in the PR if you validated a change
   in-game and against which game/build.
5. Open the PR against `master` with a clear "what and why." Small, focused
   PRs review faster than one that bundles an unrelated refactor with a
   feature.

Found a bug but not fixing it yourself? Open an issue — include the game,
the cheat (if applicable), and what you expected vs. what happened.

---

## MCP server: memory introspection from an AI coding agent

`mcp-server/` is a standalone, **read-only** [MCP](https://modelcontextprotocol.io)
server that exposes the same native memory-introspection primitives
Apprentice itself is built on — attach, scan, Mono class/field/method
resolution, read, disassemble, write-watch — as tools an AI coding agent
(Claude Code, etc.) can call directly against a live game process. It never
writes to the game's memory by design: it's for *finding* the
address/offset/signature a new cheat needs, not for installing one. (Its one
tool that writes anything, `author_cheats`, writes a draft profile file on
disk, and touches game memory only through a scratch buffer; see below.) See
`docs/superpowers/specs/2026-08-22-mcp-memory-server-design.md` for the full
design rationale.

This is what makes "find this field, resolve that class, watch this write"
a conversation instead of a manual Cheat Engine session — useful both for
building out a new game's cheat set and for debugging why an existing patch
stopped locating.

Setup:

```bash
cd mcp-server && npm install    # also builds dist/ via the prepare hook
```

The native addon must already be built (`native/build/Release/memory_addon.node`
— see [Building from source](#building-from-source) above); this package
`require()`s it directly rather than shipping its own copy. `.mcp.json` at
the repo root registers the server (`game-memory`) pointing at
`mcp-server/dist/index.js` — an agent working in this repo picks it up
automatically. Full tool list, dependency-pinning notes (there's a real
reason `@modelcontextprotocol/sdk` is pinned exactly, not ranged), and more
detail live in `mcp-server/README.md`.

### Using the cheat factory (`author_cheats`)

For a **Unity Mono or Unity IL2CPP** game, or a **native game that has an entry in
`mcp-server/src/factory/nativeGames.ts`** (currently Elden Ring), `author_cheats` turns a
wishlist of categories into draft cheats and an in-game checklist, instead of a
reverse-engineering session per cheat. It is an MCP tool, so you drive it through an AI agent
(Claude Code picks up the `game-memory` server from `.mcp.json` when you work in this repo), or
with a script (below).

**Before you start:** build the native addon and the MCP server (see Setup above), start
the game, and **load into a save or world**. The factory reads live objects, and a game
sitting at its main menu has none yet. Leave the game idle rather than mid-load.

**1. Run it.** Ask the agent something like *"attach to Schedule I and draft health,
stamina and bank cheats"*. It calls, in order:

```
list_processes                       -> find the game's pid
attach(pid)                          -> a handle
fingerprint_process(handle)          -> unity-mono, unity-il2cpp, or native-unknown (native games in nativeGames.ts only)
author_cheats(handle, ["health","stamina","bank"], "games/<Game>.json")
```

`profilePath` is where the *live* profile is (or will be); the output goes beside it as
`<Game>.draft.json`. You can skip the agent with the script for the game's engine:

```bash
node mcp-server/scripts/authorLive.js       <pid> "games/<Game>.json" health,stamina,bank   # Unity IL2CPP
node mcp-server/scripts/authorMonoLive.js   <pid> "games/<Game>.json" health,stamina,money   # Unity Mono
node mcp-server/scripts/authorNativeLive.js <pid> "games/<Game>.json" health,mana,money      # known native game
```

These scripts need `cd mcp-server && npm run build` first, and write
`<Game>.draft.json` even if you never wrote a profile. Note that it **replaces** the
whole draft file each run, so write to a different `profilePath` if you want to keep an
earlier draft.

**2. Read the result.** Every drafted cheat has an entry in `checklist`:

| Field | Meaning |
|---|---|
| `verified` | A live instance was read and gave a plausible value (not zero, not garbage). `false` means only the in-game test can confirm it. |
| `liveValue` | What was read, e.g. 100 for a full health bar. Something odd here (a huge or microscopic number) usually means the wrong object. |
| `multiInstanceRisk` | Several objects of that class exist and the capture records whichever runs last. |
| `lookFor` | What to do in the game to see it work. |

Three more lists explain what did not become a cheat: `unresolved` (matched a field but
found no plausible value or no hookable method), `notFound` (no field matched — fall back
to the analysis scripts below), and `manual` (see the table).

**3. Try each one in the game, then promote it.** A draft is never loaded by the app.
To use one, copy its entry from `<Game>.draft.json` into the `cheats` array of the live
`<Game>.json` — **together with the capture patch it names** (the `patchId` in its
`anchor` target; those entries have `"internal": true`) — then **restart Apprentice**: it
can overwrite a profile you edited while it was running the next time it saves. Toggle it, do what `lookFor` says, and delete the
ones that don't work. An anchored cheat reads `0/1 live` until its capture patch has
caught the object; it changes to `1/1 live` by itself once the game has used it.

**Categories** (`mcp-server/src/factory/categories.ts`):

| Drafted automatically | Reported as *manual*, with the reason |
|---|---|
| `health`, `stamina`, `mana`, `money`, `bank`, `water`, `curfew`, `freezetime`, `godmode` | `cash` (an item object: reach it from the inventory that holds it with an anchor `derefOffset`), `runspeed` and `speed` (rate multipliers: zeroing or freezing them breaks other systems), `nosearch` (the police decision is per-officer, not a player flag), `hunger` (a decaying stat loses a freeze race) |

To teach it a new game's naming, add a category (or extra `nameHints` / `classHints`) in that
file: name and class regexes, the data types to try, freeze or one-shot, the value to write,
and a `plausible` range for the live read. Give a category a `manualReview` message when
its obvious mechanism is a known trap.

**What the factory cannot do:**

- **Code patches** (instant timers, invisibility, item cloning, no-damage guards) and **Lua script
  cheats.** It drafts value cheats only. Those take the analysis scripts below.
- **Games it has not been taught.** Unity Mono and IL2CPP work generically. Any other engine only
  works if someone has written that game's entry in `nativeGames.ts` by hand: the signatures that
  find its static roots and the offset chain from each root to each stat. The factory then
  verifies them live and drafts the cheats. Writing the entry is the real work; see
  `docs/superpowers/specs/2026-09-20-native-cheat-factory-design.md`. A native game with no entry
  gets an error saying so; Unreal and other engines get an error pointing at that engine's playbook.
- **Tell a plausible field from the right one.** A draft is chosen by field name and a live value in
  a sane range, and `verified` only means that read succeeded. It can still be the wrong field:
  the factory once drafted a Valheim jump's stamina *cost* as stamina, and its Valheim health and
  water picks are doubtful (health is not a plain field there; there is no watering). Read the
  `lookFor` line and the field name, and check each cheat before trusting it.
- **Overloaded methods.** A Mono patch names a method, not a signature, so the app and the analysis
  scripts can only reach the first overload of a name.

What it does under the hood:

- **Mono:** enumerates classes and fields in every game assembly (`Assembly-CSharp` and the
  `assembly_*` family, since Valheim keeps its code in `assembly_valheim`), ranks them by name,
  finds the live singleton root (including a `Singleton<T>` root inherited from a base class, as
  Aviassembly uses), and keeps the first candidate whose live read is plausible. An exact stat name
  outranks a variant that only contains it, and fields that name what an action *costs* are skipped.
- **Native (known games):** finds each static root by a unique signature on the instruction that loads
  it (`mov reg,[rip+rel32]`), walks the offset chain to each stat, reads it live, and drafts a chain
  cheat by RVA. Bit flags and flag bytes are supported.
- **IL2CPP:** reads the runtime's class, field and method structs directly
  (no per-item remote call), ranks fields by name *and* type, verifies through
  a live singleton or a filtered instance scan, and emits the same pair Tamper
  already uses: a `capture` patch on a method prologue (found by a unique
  signature) plus an `anchor` value cheat.
- Output goes to `games/<exe>.draft.json`, beside the profile and never over
  it (a profile is looked up by exact exe name, so a draft is not loaded by
  accident). Every drafted cheat carries a `verified` flag and a
  `multiInstanceRisk` flag; confirm each one in-game before promoting it.
- Categories that are the wrong shape for a field cheat (continuously decaying
  stats, rate multipliers, NPC-decided behaviour, item-held currency) come back
  as **manual**, with the reason, instead of a draft that looks right and
  isn't.

When a cheat does nothing, or a mechanism isn't obvious, `mcp-server/scripts/`
has live-analysis scripts (survey classes, disassemble a method, list
callers and inlined field readers, watch a field change while the game does
something, generate a `replace`/`capture` patch with a unique signature). Beyond the
IL2CPP set shown below there are Mono ones (`surveyMono.js`, `monoDisasm.js`,
`monoReaders.js`, and `checkPatches.js`, which re-checks a profile's patches after a game
update) and, for native games, offline ones that work on a recorded snapshot of the game's code
(`recordSnapshot.js`, `mineRoots.js`, `flagXrefs.js`, `traceSnap.js`, `deriveFlagRoot.js`).

Two cautions. **Compiling many Mono methods at once has crashed Valheim and Aviassembly**, so
`monoReaders.js` refuses to run unless you name the methods (`METHODS=<regex>`); keep the set small.
And for an anti-tamper game, record snapshots with `MODULE=<game exe>` so only the game's own
module is read (a full-process dump crashed Elden Ring). The method they support is written up in
`.claude/skills/authoring-tamper-cheats/SKILL.md` and
`mcp-server/scripts/README.md`.

**A typical hunt for a code patch** (this one is IL2CPP; run `cd mcp-server && npm run build`
first; every script takes the game's pid first and only reads):

```bash
cd mcp-server/scripts
node survey.js <pid> out.txt "^PlayerCrimeData$"                # fields and methods of a class
node findCallers.js <pid> "^(?!.*Network).*$" Cls.method        # who calls it? (empty = inlined)
node findFieldReaders.js <pid> "^Cls$" "+0x148]"                # who touches this field offset?
CLASSES="^Cls$" ROWS=60 BYTES=400 node disasm.js <pid> Cls.method   # what does it do?
node callTree.js <pid> "^Cls$" Cls.method                       # what does it call?
# once you know the exact instruction, emit a patch with a signature that matches once:
MINLEN=2 AT=0x<address> ROWS=900 BYTES=4000 node makeReplace.js <pid> "^Cls$" method "." 31c0 my-id "My cheat"
```

The output of `makeReplace.js` is a ready-to-paste `patch` entry. Two things that
trip people up: `CLASSES` takes one class per call, and a long method needs `ROWS` and
`BYTES` raised or the script reports "instruction not found". Prefer a patch at the
function every route shares over one per route, and check that a getter you want to
patch actually has callers (IL2CPP inlines trivial ones).

Design docs:
`docs/superpowers/specs/2026-09-19-cheat-factory-design.md`,
`docs/superpowers/specs/2026-09-19-il2cpp-cheat-factory-design.md` and
`docs/superpowers/specs/2026-09-20-native-cheat-factory-design.md`.

---

## Sharing cheats

Every cheat lives in a per-game profile at `games/<exe-name>.json` — plain
JSON, easy to read, easy to hand to someone else.

### The easy way: Import/Export a Cheat Table

Apprentice can import a Cheat Engine `.CT` table directly (Cheats screen →
**Import Cheat Table (.CT)**) — it recognizes the common "replace one write
with a fixed value" shape most CT entries use, and skips (with a reason)
anything it can't safely translate. Going the other way, **Export to Cheat
Table (.CT)** turns your cheats into a `.CT` file anyone with Cheat Engine
can open — not just a select few: `nop`, `replace`, and `force`-mode patches
all export as Auto Assembler scripts, and any value cheat resolved through a
plain module+offset(+pointer chain) address exports as an ordinary Cheat
Engine address entry, no script needed. What's left out is only what
genuinely has no Cheat Engine equivalent — `capture`/`guard`/`immune`/
`scale`/`copy`-mode patches (relocated code-cave injections, some with an
object pointer resolved fresh every install from live Mono metadata Cheat
Engine has no way to replicate), a value cheat resolved via Mono metadata or
a capture patch's tracked pointer rather than a fixed address, and a
single-bit cheat (freezing the whole byte in Cheat Engine would clobber
other flags packed into it) — each reported with its specific reason rather
than silently dropped.

This is the fastest way to hand a friend a single cheat or a small set
without either of you touching a `games/*.json` file by hand.

### Contributing a profile to this repo

If you've built out a solid set of cheats for a game — especially a *new*
game this repo doesn't support yet — consider opening a PR to add or extend
its `games/<exe>.json`:

1. Get your cheats working and verified in-game first. A patch that only
   "looks right" in the JSON but was never actually tested against the game
   is worse than no PR — see `docs/superpowers/follow-ups/2026-07-28-valheim-session.md`
   for exactly how many ways a code patch can look fine and still be wrong.
   A `*.draft.json` produced by `author_cheats` is a starting point, not a
   verified profile: toggle each entry in-game and check what it does before
   promoting it.
2. Keep the file schema-2 shaped (`{ schema, exe, modules, cheats }`) — every
   cheat you add should be something the app itself saved, not hand-typed
   from scratch, so it's already validated against the app's own types.
3. Name cheats the way the existing ones are named: short, in-game
   terminology ("Infinite Weapon Durability," not "InfDur" or "cheat_12").
4. If a cheat is a code patch anchored to a module (not Mono-resolved), note
   in the PR description which game **version/build** it was captured
   against — module-anchored patches verify a fingerprint before trusting
   their saved address, but that only helps if someone knows what build to
   expect it against in the first place.
5. Mention any cheat that's build-specific or known to break on other
   difficulty/mode settings, so the next person doesn't have to rediscover
   that the hard way.

A game update can shift a patch's exact bytes even when nothing about the
*cheat* changed — that's expected, not a sign something's broken. Apprentice
re-verifies and re-locates on every attach, and Mono-anchored cheats
(resolved by class/method name rather than a byte signature) mostly ride
through updates without needing any of this.

---

## Safety notes

When Apprentice exits normally it puts the game back: code patches are restored when
you disable a cheat, when the game closes, and when you quit; frozen values are put back to
what they held when you turned the cheat on (or to the cheat's own off value, where it sets one); and a hardware write-watch breakpoint is cleared. **That
cleanup only runs while Apprentice is running.** If Apprentice itself is force-closed
(Task Manager, a crash, a power cut), nothing can restore the game: any patch or frozen
value you had switched on stays in it until you re-attach and switch it off, or restart
the game (re-attaching adopts patches left behind this way). A find-what-writes capture
in progress uses a hardware breakpoint, and if Apprentice is killed mid-capture the game
can crash. So quit Apprentice from its window rather than ending the process. If you see
something still patched after a normal quit, that's a bug — please report it with repro
steps.

This tool touches only the process you explicitly attach it to, and does nothing to a
game until you turn a cheat on (attaching and browsing the game library only read). The app makes no network requests of its own: Cheat Table import and export read
and write a file you choose, and the game library reads Steam's files on disk.

---

## License

[GPL-3.0](LICENSE). Free to use, study, modify, and redistribute — including
commercially — as long as anything you distribute that's built on this code
stays open source under the same license.

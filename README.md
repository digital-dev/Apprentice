# Apprentice

A free, open-source Windows game trainer — an offline memory editor and
cheat engine for PC games, for when you want a Cheat Engine/WeMod
alternative that's transparent about what it's doing, doesn't phone home,
and doesn't require a closed-source client to use cheats someone else
built. Electron + React + TypeScript over a C++ N-API addon that talks to a
target process's memory directly — no server, no telemetry, no
always-online requirement.

Two ways to cheat:

- **Value cheats** — find an address, write it repeatedly (a "freeze"), or
  write it once ("one-shot").
- **Code patches** — rewrite the instruction that writes a value, so the game
  itself never puts the old value back. NOP it out, replace it, force a
  fixed result, or skip a method entirely for one object.

Ships with two ready-made cheat sets: **Valheim** (Mono JIT — 15 cheats,
`games/valheim.json`) and **Elden Ring** (native, pointer-chain value
cheats — 14 cheats, `games/start_protected_game.json`, named for Elden
Ring's EAC-protected executable). The engine underneath isn't tied to
either game — see [Sharing cheats](#sharing-cheats) below for adding your
own.

> Windows only. The native addon's injection path is Win32; Linux is stubbed
> out but not implemented (see `native/src/platform/platform_linux.cc`).

---

## Install

Grab the latest `Apprentice-Setup-<version>.exe` from [Releases](../../releases)
and run it — no admin rights needed, it installs to your user profile.
Prefer to build it yourself, or want to hack on it? Keep reading.

## Building from source

Requirements: Node.js 18+, a recent `npm`, and the
[Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
(C++ workload) for compiling the native addon.

```bash
npm install                                    # electron postinstall may need approving
cd native && npx node-gyp configure && npx node-gyp build && cd ..
npm run build
```

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
   picking this up cold — the layer map, the four patch modes, the
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
(Claude Code, etc.) can call directly against a live game process. It has no
write operations by design: it's for *finding* the address/offset/signature
a new cheat needs, not for installing one. See
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

Apprentice never leaves a game modified after it closes: patches are
restored on cheat disable, on detach, and on app quit, and a hardware
write-watch breakpoint is always cleared before Apprentice exits — this is
also true if the process closes unexpectedly, e.g. via Task Manager. If you
see something patched that shouldn't be, that's a bug — please report it
with repro steps.

This tool touches only the process you explicitly attach it to, and does
nothing without you turning a cheat on. It has no network calls of its own
beyond an optional Cheat Table search/import feature you invoke by hand.

---

## License

[GPL-3.0](LICENSE). Free to use, study, modify, and redistribute — including
commercially — as long as anything you distribute that's built on this code
stays open source under the same license.

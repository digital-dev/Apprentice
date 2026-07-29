# Game Identity, Module Anchoring and Cheat Lifecycle (#8) — Design

## Purpose

Make a saved cheat re-arm itself in the next launch of the game, and keep
being trustworthy when the game updates.

#7 proved a patch can relocate by byte-pattern scan and survive a restart.
What it did not do is make that automatic or safe at scale:

- **Nothing verifies a module anchor.** Capture already records
  `moduleName` and `moduleOffset` when the instruction lies inside a
  module, and `resolveAddress` will happily do the arithmetic — but it
  trusts the offset blindly, never checking that the bytes there are still
  the captured instruction, and never falling back to a scan when they are
  not. Valheim's own patch has `null` for both because Mono JIT code is not
  in any module, so this path has never actually run against a game.
- **Nothing knows what build the cheat was captured against.** A game
  update can move, rewrite or delete the captured code. Today the only
  defence is that the signature stops matching; if it still matches
  something, the patch installs into whatever that is.
- **Relocation is a one-shot attempt.** Mono compiles a method on first
  call, so a scan immediately after launch correctly finds nothing, and
  the user is told the code "may have been re-compiled — re-capture it".
  The Valheim session recorded this as actively misleading and named a
  background retry the single highest-value follow-up.
- **Attaching is manual, every session.** The user must find the process
  in a list before anything can happen.

This sub-project is the first of several that take Tamper from a working
trainer for one game to a tool that can hold cheats for many. The others —
signature engine v2, Mono/IL2CPP metadata resolvers, an assembler and
script layer, discovery tools — all depend on knowing which game build is
running and where its modules are, so this one comes first.

## Scope

**In scope:**

- A profile format that records, per game, the fingerprint of every module
  a cheat anchors into, alongside the cheats themselves. Backwards
  compatible with today's bare-array `games/*.json`.
- Module enumeration in the native layer, through the platform seam.
- Recording the fingerprint of a patch's module into the profile when that
  patch is saved. (`moduleName` + `moduleOffset` are already captured.)
- An anchor resolution strategy that prefers arithmetic (module base +
  RVA) over scanning, verifies bytes either way, and re-learns the RVA
  when a scan relocates a patch in a changed build.
- Bounded `scanAob`, so a module-anchored scan searches that module rather
  than the whole address space.
- A per-cheat state machine with background retry, shared by value cheats
  and patch cheats.
- A process watcher that attaches automatically when a game with a profile
  appears, and cleans up when it exits.
- Status chips in the cheat list, and a banner when a module's fingerprint
  has changed.
- A loadable probe DLL in the test harness, so module anchoring and a
  simulated game update are testable without a game.

**Out of scope:**

- Signature-engine changes. `kMinSigBytes`, the backward extension and the
  wildcarding rules stay exactly as they are; uniqueness-driven length and
  semantic wildcarding are sub-project C.
- Mono or IL2CPP metadata traversal (sub-project D).
- An assembler, user-authored assembly, Cheat Engine `.CT` import
  (sub-project E).
- Pointer-scan persistence, read-watch, struct dissect (sub-project F).
- 32-bit targets. Everything here stays x86-64.
- **Arming cheats without the user.** The watcher attaches; it never
  writes. See Safety.

## Global constraints

- x86-64, Windows first, Linux-capable by construction: module
  enumeration goes through `platform/platform.h` with a Windows
  implementation and a Linux stub that refuses, matching #7's seam.
- No network calls anywhere in the stack. Offline single-player use only.
- Backwards compatibility with existing `games/*.json` is a hard
  requirement. The Valheim profile in the repo must load, arm and restore
  unchanged.
- No behaviour change to the injection engine itself. `patchEngine.ts`
  gains a caller and loses its own address resolution; the cave assembly,
  the safety refusals and the restore path are untouched.

## Architecture

```
watcher.ts ──attach──▶ cheatRuntime.ts ──resolve──▶ anchor.ts ──▶ patchEngine
     │                       │                          │
     │                       │                          └─ scanAob (bounded)
     │                       └─ retry/backoff, state per cheat
     └─ profile.ts (load, migrate, fingerprint compare)
```

Four new main-process modules, each testable against fakes in the style
`patchEngine`'s `PatchOps` established, and two native additions.

### `profile.ts` — what a game's file means

Today `games/<exe>.json` is a bare array of cheats. It becomes:

```json
{
  "schema": 2,
  "exe": "valheim",
  "modules": {
    "GameAssembly.dll": { "size": 74280960, "timestamp": 1719400000, "version": "0.218.15" }
  },
  "cheats": [ ... ]
}
```

`modules` holds one entry per module any cheat in this file anchors into,
recorded at capture time. It is not a snapshot of everything loaded — only
what a cheat depends on, so an unrelated DLL update costs nothing.

A file whose top-level value is an array is schema 1: it loads as a profile
with an empty `modules` map, which means every cheat in it is *unverified*
and resolves by scan alone — exactly today's behaviour. The file is
rewritten in schema 2 the next time a cheat is saved. `loadCheats` and
`saveCheat` keep their signatures so nothing outside `profile.ts` has to
know which schema it read; the existing refusal to overwrite an unparseable
file stays as is, for the reason recorded in `store.ts`.

### Module fingerprints

Per module: `name`, `size` (PE `SizeOfImage`), `timestamp` (PE
`TimeDateStamp`) and file version where available. All three come from
headers already mapped in the target process, so a fingerprint costs a
handful of reads and no file I/O — hashing a multi-hundred-megabyte
`GameAssembly.dll` on every attach is not acceptable, and repacks that
preserve both size and timestamp are not the failure mode we are defending
against.

Version comes from the module file's version resource where it has one, and
is `null` otherwise; it is recorded for the user's benefit and is not part
of the match test, so a game that ships unversioned DLLs loses nothing.

A cheat is **verified** when the module it names has a fingerprint in the
profile and that fingerprint's `size` and `timestamp` match what is loaded
now. Anything else — module absent, fingerprint absent, fingerprint
different — makes the cheat **unverified**.

Fingerprints are recorded on save: when a patch naming a module is written
to a profile, that module's currently-loaded fingerprint goes in with it.
`moduleName` and `moduleOffset` themselves are already captured today.

### `anchor.ts` — where a patch lives now

One pure function: `resolve(patch, modules, ops) → { address, trust, reason }`.
Its whole job is to be the only place that decides an address, so the
decision can be tested exhaustively without a game. It tries, in order:

1. **Arithmetic.** The patch names a module, that module is loaded, and its
   fingerprint matches. Compute `base + moduleOffset`, read `patch.length`
   bytes, require them to equal `originalBytes`. On success: return
   immediately, having scanned nothing. This is the fast, unambiguous path
   that most non-JIT games should take every single time.
2. **Bounded scan.** Reached when the patch names no module (JIT code), the
   module is not loaded, the fingerprint differs, or the bytes at the RVA
   are not what we captured. Scan the signature — restricted to the named
   module's address range when there is one, whole address space otherwise.
   Require **exactly one** match *and* that the bytes at
   `match + signatureOffset` equal `originalBytes`. On success, if the
   patch named a module, re-record `moduleOffset` as the new RVA and
   persist it, so the next launch of this build takes path 1.
3. **Fail**, with a typed reason (below). Never guess: the existing rule
   that 0 matches and >1 matches are opposite problems with opposite fixes
   is preserved and extended.

Byte verification happens on **both** paths. An RVA that still points at
the right bytes is trustworthy even in a build we have never seen; an RVA
that does not is discarded rather than patched. That is what makes
"warn, allow with verification" safe: a game update that did not touch the
patched function costs the user nothing, one that did falls through to a
scan, and one that rewrote the function fails loudly.

`patchEngine.locate` currently does this resolution inline. It is moved
here and `locate` calls it, keeping the already-shipped behaviour that a
patch known to be installed is not re-scanned — an injection replaces the
site with a jump, so its own signature deliberately no longer matches.

### Typed failure reasons

`relocationError`'s prose is replaced by a discriminated reason, rendered
in the UI:

| Reason | Meaning | What the user should do |
|---|---|---|
| `module-missing` | Named module not loaded | Wait, or re-capture |
| `no-match` | Signature matched nothing | Re-capture |
| `ambiguous` (with count) | Matched more than one place | Re-capture a longer instruction |
| `bytes-differ` | Located, but the bytes are not what we captured | Re-capture |
| `not-yet-compiled` | No match, no module, still early in retry | Play until the game runs the code |
| `foreign-injection` | Existing state, unchanged | Restart the game |

`not-yet-compiled` exists because the Mono case is not an error and must
not read like one. It applies only while a retry is still in progress; once
retries are exhausted it degrades to `no-match`.

### `cheatRuntime.ts` — the state machine

One machine for both cheat kinds, because "is this cheat actually working"
is the same question either way:

```
idle ──user toggles on──▶ arming ──resolved+applied──▶ active
  ▲                          │                           │
  │                          └── retry (backoff) ────────┘
  │                          │                           │
  └──user toggles off / process exits──── failed ◀── retries exhausted
                                       degraded ◀── was active, then stopped working
```

- `arming`: toggled on, not yet resolved. Retry with backoff from 250 ms to
  a 5 s cap, indefinitely while the process lives, because the Mono case
  can be arbitrarily far away — the method runs when the player does the
  thing. Reasons that cannot improve by waiting (`ambiguous`,
  `bytes-differ`) go straight to `failed` without retrying.
- `active`: applied and verified.
- `degraded`: was active and stopped working. `freezeLoop.ts` already has
  this concept for repeated write failures; it reports into this machine
  instead of owning it.
- `failed`: terminal until the user toggles off and on again.

`unverified` is a flag on top of the state, not a state: it describes the
build, not the cheat's progress, and an unverified cheat that resolves and
verifies its bytes is perfectly `active`.

Process exit resets every cheat to `idle` and drops the applied map. The
existing rule that a live foreign trampoline is refused rather than adopted
is unchanged.

### `watcher.ts` — attach without being asked

Polls `listProcesses` every 2 seconds for executables that have a profile
in `games/`. On appearance: attach, enumerate modules, compare
fingerprints, mark cheats verified or not, and tell the renderer. On
disappearance: detach and reset.

**The watcher never writes to the game.** Auto-attaching is a convenience;
auto-arming into a build nobody has verified is a way to corrupt a save
file unattended. Arming is always a user toggle. Manual attach from the
process picker stays, for a game with no profile yet.

### Native additions

- `listModules()` → `[{ name, base, size, timestamp, version }]` for the
  attached process, added to the platform seam as `platform::ListModules`
  with a Windows implementation (toolhelp snapshot plus a PE header read
  for `SizeOfImage` and `TimeDateStamp`) and a Linux stub that refuses.
- `scanAob(signature, rangeStart?, rangeEnd?)` — optional inclusive bounds.
  Absent bounds preserve today's behaviour byte for byte, so existing
  callers and tests are unaffected. Bounds narrow the region walk, they do
  not change matching: the rule that a pattern may not straddle a region
  boundary still holds, because `scanAob` still searches one region at a
  time.

### UI

`CheatList` rows gain a status chip driven by the state machine:
`ready` (idle, resolvable), `arming`, `active`, `degraded`, `unverified`,
`failed` — the failure reason on hover. One banner per game when any
anchored module's fingerprint differs from the profile:

> This game has updated since these cheats were captured. They'll be
> verified against the new build when you turn them on.

This extends the existing patch-status chip pattern; no new screens, no
styling system, matching the deliberately plain renderer.

## Data flow, end to end

1. Game launches. Watcher sees the exe, attaches, calls `listModules`.
2. `profile.ts` compares each anchored module's fingerprint. Cheats are
   marked verified or unverified. Rows render `ready` or `unverified`.
3. User toggles a cheat on. `cheatRuntime` enters `arming` and calls
   `anchor.resolve`.
4. Resolved and byte-verified → `patchEngine.apply` (or the freeze loop for
   a value cheat) → `active`. If the scan path relocated a patch that names
   a module, the new RVA is written back to the profile.
5. Not resolved, reason retryable → backoff, stay in `arming`, chip shows
   why.
6. Game exits. Watcher resets everything to `idle`.

## Error handling

- Every anchor failure carries a typed reason and reaches the UI; none
  collapse into a generic "not found".
- A profile that fails to parse still throws rather than being replaced —
  the existing data-loss defence, kept verbatim.
- A schema-2 profile with a `cheats` key that is not an array is a parse
  failure, treated the same way.
- `listModules` failing (a protected or exiting process) marks every cheat
  unverified rather than throwing; the scan path still works.
- Writing back a re-learned RVA is best-effort: a failed profile write logs
  and does not stop an otherwise working cheat from arming.

## Safety

Inherited unchanged from #7 and restated because they constrain this work:

- Never install when located bytes do not match the capture, or when a
  signature matches 0 or more than 1 place.
- Suspend all threads while writing an injection site; restore proceeds
  even if suspension fails.
- Never free a cave while the process lives.
- Restore on disable, detach and app exit — including watcher-initiated
  detach.

New to this sub-project:

- The watcher may attach and read; it may never write.
- An unverified build never skips byte verification. "Warn and allow" means
  the RVA is distrusted, not that the check is relaxed.

## Testing

Main-process logic is tested against fakes, in the established style:

- **`profile.ts`**: schema-1 array migrates (using the repo's real
  `valheim.json` content as a fixture), schema-2 round-trips, unparseable
  file still throws, non-array `cheats` rejected.
- **`anchor.ts`**: the strategy matrix — fingerprint match with good bytes
  (no scan performed, asserted by a fake that fails if called), fingerprint
  match with wrong bytes (falls through to scan), fingerprint mismatch,
  module missing, JIT patch with no module, scan returning 0 / 1 / many,
  scan match with wrong bytes, RVA re-learned and persisted.
- **`cheatRuntime.ts`**: every transition, backoff schedule with a fake
  clock, non-retryable reasons failing fast, process exit resetting state,
  degraded reporting from the freeze loop.
- **`watcher.ts`**: appearance, disappearance, a process with no profile
  ignored, and an assertion that no write op is ever called.

Native tests drive the existing child-process harness, plus:

- **`test-harness/probe.dll`** — a small DLL with a patchable function,
  loaded and unloaded on harness command (`loaddll` / `unloaddll`). Gives a
  real PE with a real base, RVA, `SizeOfImage` and `TimeDateStamp`.
- **A second variant of that DLL**, built with different padding so its
  size and timestamp differ, exercising the fingerprint-mismatch path
  against a real module rather than a mock.
- `listModules` returns the harness's own modules and the probe once
  loaded; bounded `scanAob` finds a pattern inside the probe and does not
  find one that lies outside the bounds.

Known hazards when writing these tests, carried from the map: exactly one
top-level `beforeAll` in native test files, and scans in native tests are
one-shot against a field's initial value.

**What these tests cannot tell us:** the harness is a static MSVC binary.
Every defect the Valheim session found was invisible to it. Passing here is
necessary, not sufficient — the acceptance test is Valheim: relaunch the
game, watch Tamper attach itself, toggle the stamina cheat, and see it
reach `active` without the user having to time it against Mono's JIT.

## Success criteria

1. Launching Valheim with Tamper open attaches automatically, with no
   process picking.
2. The existing Valheim profile loads, migrates to schema 2 on next save,
   and its guard patch behaves exactly as before.
3. A patch captured inside a named module resolves by arithmetic on the
   next launch, performing no scan (observable: scan count is zero).
4. Toggling a Mono-JIT cheat before the game has run the method shows
   `arming`, not an error, and reaches `active` once the method compiles.
5. A module whose fingerprint changed produces the banner, and its cheats
   still arm when their bytes verify.
6. `npx vitest run`, `npx tsc --noEmit` and `npm run build` all pass.

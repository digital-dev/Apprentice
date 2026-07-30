# Tamper — codebase map

Written for an agent picking this up cold. Read this instead of exploring;
open a file only when you need to change it. Line counts are indicative.

**What it is:** an offline Windows game trainer. Electron + React + TypeScript
over a C++ N-API addon. Two ways to cheat: *value cheats* (find an address,
write it repeatedly) and *code patches* (rewrite the instruction that writes
the value). Primary target: Valheim (Mono JIT).

---

## Layer map

```
renderer (React)  ──IPC──▶  main (TypeScript)  ──N-API──▶  native (C++)  ──▶  game process
src/renderer/src            src/main                       native/src
```

The renderer never touches memory. All process access is in `native/`, exposed
through `src/main/nativeAddon.ts`, and reached from the UI only via the
channels in `src/main/ipc.ts` bridged in `src/preload/index.ts`.

---

## native/src — everything that touches the game

| File | Lines | Responsibility |
|---|---|---|
| `write_watch.cc` | 945 | **Find-what-writes.** Hardware breakpoints (Dr0/Dr7) via a debugger loop; decodes the faulting instruction with Zydis; builds the AOB **signature**. The most subtle file here. |
| `cave_ops.cc` | 477 | Code-cave primitives: `allocateCave`, `decodeRun`, and the instruction **encoders** (`encodeStore`, `encodeCaptureOnce`, `encodeGuardedSkip`, `encodeJump`), plus thread suspend/resume wrappers. |
| `pointer.cc` | 339 | Pointer-chain discovery (module base + offsets) for value cheats. |
| `patch_ops.cc` | 271 | `readBytes` / `writeBytes` (protect → write → restore → flush) and `scanAob`, bounded by optional `(rangeStart, rangeEnd)`. |
| `scanner.cc` | 205 | Value scanning: `scanFirst` / `scanNext`. |
| `platform/platform_win32.cc` | 265 | The OS backend: read/write/query/allocate-near/suspend-all, and `ListModules` (the Win32-level module enumeration `module_info.cc` calls through the platform seam). |
| `memory_ops.cc` | 93 | `readValue` / `writeValue` through an offset chain. |
| `addon.cc` | 83 | N-API export table. |
| `process_utils.cc` | 67 | Process enumeration and attach. |
| `module_info.cc` | 37 | `listModules`: every module loaded in the target (name, base, `SizeOfImage`, `TimeDateStamp`, version string) — the PE fields a build fingerprint is made of. Returns `[]` rather than throwing on a protected/exiting process. |
| `platform/platform_linux.cc` | 36 | Stub: compiles, loads, refuses (`IsSupported() === false`). |

**Addon exports:** `ping listProcesses attach scanFirst scanNext
resolvePointerChain getModuleBase readValue writeValue startWriteWatch
pollWriteWatch stopWriteWatch readBytes writeBytes scanAob platformName
allocateCave decodeRun encodeStore encodeCaptureOnce encodeGuardedSkip
encodeJump suspendThreads resumeThreads listModules`

`scanAob` takes optional `(rangeStart, rangeEnd)` bounds (inclusive-exclusive)
after the signature; absent bounds walk all executable memory, unchanged from
before. Bounding to a module's `[base, base+size)` is what lets a scan recover
without paying to re-search the whole process.

**The platform seam** (`platform/platform.h`) exists so injection can be ported
to Linux. **Only new code uses it** — `cave_ops.cc` must contain *no* Win32
call. The older modules (scanner, pointer, memory_ops, write_watch, patch_ops)
still call Win32 directly; porting them is a separate sub-project.

---

## src/main — decisions, all testable against a fake process

| File | Lines | Responsibility |
|---|---|---|
| `patchEngine.ts` | 665 | **The core.** Locate / apply / restore for code patches, and the cave assembly for every injection mode. Takes a `PatchOps` interface, so every path — especially every refusal — is tested without a game. Also owns `setAnchorContext` (module map + verified set, refreshed on every attach) and `onRelearn` (a scan-found RVA worth writing back to the profile). |
| `ipc.ts` | 506 | Channel handlers, the live `patchOps` implementation, anchor resolution, freeze wiring, `refreshModuleContext`/`attachTo` (shared by manual attach and the watcher), and the `cheatRuntime`/`watcher` wiring that pushes `game:state` / `cheat:state`. |
| `anchor.ts` | 115 | `resolvePatchAddress`: where a module-anchored patch lives *right now*. Tries module-base + RVA first (only when the module's fingerprint is verified), falls back to a scan bounded to that module's address range, and verifies captured bytes on **both** paths before trusting an address. Returns an `AnchorReason` (`module-missing` / `no-match` / `ambiguous` / `bytes-differ` / `not-yet-compiled`) rather than a bare failure, since the fix differs per reason. Pure — takes an `AnchorOps` interface, no addon. |
| `cheatRuntime.ts` | 179 | `CheatRuntime`: the state machine behind a patch chip (`idle → arming → active`, plus `degraded`/`failed`), with exponential backoff (`BACKOFF_BASE_MS`..`BACKOFF_CAP_MS`) retrying only the reasons in `RETRYABLE` — `not-yet-compiled` is not an error, it means Mono hasn't JITted the method yet. Generation counters guard against a disarm()+arm() race clobbering a stale in-flight attempt. |
| `watcher.ts` | 76 | `ProcessWatcher`: polls `listProcesses` every `POLL_INTERVAL_MS` for a process this game has a profile for, and fires `onAppear`/`onVanish`. Attaches only — auto-arming a patch into an unverified build is how a save file gets corrupted unattended. |
| `profile.ts` | 127 | `games/<exe>.json` schema 2: `{ schema, exe, modules, cheats }`. `modules` records a `ModuleFingerprint` (`size`, `timestamp`, `version`) per module some cheat anchors into — only those, not everything loaded. `verifiedModules` / `fingerprintOf` are the pure comparisons `ipc.ts` drives on every attach and every save. Schema 1 (a bare cheat array) loads as an empty-fingerprint profile — every cheat in it starts unverified, exactly its old behavior. |
| `store.ts` | 124 | Types (`CheatDefinition`, `PatchCheat`, `ChainTarget`, `AnchorTarget`) and thin CRUD over `profile.ts`'s `loadProfile`/`saveProfile`. |
| `nativeAddon.ts` | 155 | Typed wrappers over the addon. Note the throwing / non-throwing pairs: `readValue`/`tryReadValue`, `readBytes`/`tryReadBytes`. `scanAob` takes optional `(rangeStart, rangeEnd)`. `listModules` returns `ModuleInfo[]`. |
| `freezeLoop.ts` | 87 | Rewrites frozen values on a tick; marks a cheat degraded after repeated failure. |

**IPC channels:** `process:list process:attach game:current cheats:load
cheats:save cheats:delete cheats:toggleFreeze cheats:oneShot cheats:verify
scan:first scan:next scan:resolveChain writeWatch:start writeWatch:poll
writeWatch:stop patch:locate patch:apply patch:restore patch:slot`

**Push events** (main → renderer, not request/response): `game:state` — sent
on attach and on the watched process vanishing; payload is
`{ exe, pid, changedModules }` (`changedModules` is which of the profile's
fingerprinted modules no longer match what's loaded, i.e. unverified).
`cheat:state` — sent on every `CheatRuntime` state transition; payload is
`{ cheatId, status }` where `status` is a `CheatStatus` (`state`, `unverified`,
`reason`, `address`, `attempts`). `cheat:broken` / `cheat:recovered` — the
freeze loop's existing degraded/recovered signal, now also mirrored into
`CheatRuntime.markDegraded`/`markRecovered` so the two notions of "broken"
stay in sync.

---

## src/renderer — deliberately plain React

`screens/ProcessPicker.tsx` → `screens/CheatList.tsx` (rows, toggles, patch
status chips) and `screens/Scanner.tsx` (scan → narrow → find-what-writes →
create cheat or patch). `tamper.d.ts` types the preload bridge. No component
library, no styling system — match the surrounding code.

`App.tsx` keeps Scanner **mounted but hidden** when you navigate away, so a
scan isn't thrown away.

---

## The four patch modes

Set by `PatchCheat.mode`; **absent means `'nop'`** so pre-injection saved
patches keep working.

| Mode | Cave body | Reaches |
|---|---|---|
| `nop` | *(no cave — writes NOPs at the site)* | every object that code runs for |
| `force` | `effect + tail + jmpBack` — the captured store is **replaced**, not replayed | every object |
| `capture` | `effect + displaced + jmpBack` — records the object pointer into the slot, changes nothing | n/a (feeds an anchored cheat) |
| `guard` | `guardBlob + displaced + jmpBack` — compares the object against the slot, skips the write for that one | **one object only** |

**Cave layout is fixed:** slot at `cave+0` (8 bytes, holds a captured pointer),
code at `cave+8`.

**The effect always runs first**, before any replayed instruction. This is not
stylistic: `decodeRun` rounds up to whole instructions to reach the 5 a
`jmp rel32` needs, so a short captured store drags in whatever follows — and if
that clobbers the base register, an effect running afterwards dereferences
garbage. This crashed Valheim.

---

## Non-negotiable safety rules (all enforced in code, all learned the hard way)

- Never displace a run containing a **RIP-relative** instruction, a **relative
  branch**, or a **flow terminator** (`ret`, indirect `jmp`/`call`, `int3`,
  `ud2`, `hlt`). A replayed `ret` returns before the effect runs — an installed
  cheat that silently does nothing.
- Never install when the located bytes don't match the capture, or when the
  signature matches 0 or >1 places. Never guess.
- **Suspend every thread while writing an injection site.** Install refuses if
  suspension fails; **restore deliberately proceeds anyway** — refusing to
  restore leaves a game permanently patched, which is worse.
- **Never free a cave** while the process lives; a thread may be inside it.
- Restore on disable, on detach, and on app exit.
- `restore` writes back the **full displaced run**, not `patch.length` — they
  differ whenever the captured instruction is under 5 bytes.

---

## Relocation (`anchor.ts`): two paths, one verification

A module-anchored patch is relocated by `resolvePatchAddress` (`anchor.ts`),
which tries **module base + RVA arithmetic first**, not the signature scan —
arithmetic is exact and free, where a scan walks executable memory. Arithmetic
is only trusted when the module's live fingerprint (`profile.ts`'s
`verifiedModules`) still matches what was recorded at save time; otherwise it
falls straight to a scan bounded to that module's `[base, base+size)`.
**Both paths verify the captured bytes before returning an address** — an RVA
that no longer points at the captured instruction (a build changed layout) is
discarded rather than patched, and a scan match that found the right pattern
but wrong bytes at the target offset (`bytes-differ`) is likewise refused. A
successful scan on a module-anchored patch writes its RVA back to the profile
(`relearnedOffset`) so the *next* launch of that exact build takes the
arithmetic path instead of re-scanning. This is the mechanism
`tests/native/module_info.test.ts`'s "a module anchor survives a reload" test
proves at the native-primitive level: the same 8 bytes read at `base + rva`
before and after a DLL unload/reload, regardless of whether the reload landed
at a different base.

---

## Signatures (the part that survives a game restart)

Built in `write_watch.cc`. A signature covers the **whole enclosing method**,
extending *backward* from the captured instruction, with `signatureOffset`
recording how many bytes precede it (a scan match is the pattern start, so the
instruction is at `match + signatureOffset`; absent means 0).

Rules, each from a real failure:

- **Wildcard `imm64`.** A 64-bit immediate is how x86-64 embeds an absolute
  address, and JIT allocations move every launch. `imm32` stays literal — it
  can't hold an address, and it earns uniqueness.
- **Never cross a method boundary** (`ret`/`jmp`) in either direction — past it
  is padding, JIT metadata, then an unrelated method, none of it stable.
- **Never cross a memory region boundary** — `scanAob` searches one region at a
  time, so a straddling pattern matches *nothing*.
- **Stop at padding runs** (`0x00`/`0xCC`, 4+ bytes) and **reject candidate
  alignments that decode opcode `0x00`** — x86 self-synchronizes, so a
  misaligned chain can decode cleanly, land correctly, and hide the `movabs`
  the wildcarding needed to see.

Tuning constants (`kMinSigBytes = 48`, `kLookBack = 64`, `kPadRun = 4`) come
from one game's evidence. A Cheat Engine table for the same game used an
11-byte pattern, so 48 is conservative.

---

## Tests — 213, and what they can't tell you

`npx vitest run` · `npx tsc --noEmit` · `npm run build`

Native tests drive a **real child process**: `test-harness/harness.exe`, built
from `harness.c`, driven over stdin (`drainloop`, `forceloop`, `wideloop`,
`shieldloop`, `tight_write`, `loaddll`, `loaddll2`, `unloaddll`, …).

`loaddll` / `loaddll2` / `unloaddll` load and unload a real DLL
(`probe.dll` / `probe2.dll`, a size/timestamp-varied variant of the same
DLL) into the harness process, replying `OK <0xbase>`. This is what
`tests/native/module_info.test.ts` uses to prove `listModules` sees a module
appear/disappear with a plausible fingerprint, that two builds of "the same"
DLL fingerprint differently (the pair `profile.ts`'s verification test
compares), and — the acceptance test for the whole arithmetic relocation path
— that the same bytes read at a fixed RVA survive the DLL being unloaded and
reloaded at a **different** base address (loading `probe2.dll` in between
specifically to discourage the loader from reusing the old base).

**The harness is a static MSVC binary; the real target is Mono JIT.** Almost
every defect found in-game was invisible here for that reason: stable bytes
past a `ret`, no absolute addresses in code, no shared setters, well-behaved
threads. When a fix passes here, that is necessary and not sufficient.

Two hazards when editing tests:
- `tests/native/cave_ops.test.ts` and `tests/native/module_info.test.ts` must
  each keep **exactly one top-level `beforeAll`** — awaiting an `AsyncWorker`
  promise in a second one reliably segfaults the vitest worker. New `describe`
  blocks in these files share the file's single `beforeAll`-spawned harness
  and its `send()` helper rather than adding their own setup.
- Scans in the native tests are **one-shot**: they key off a field's initial
  value, which the first test to run overwrites.

---

## Build and run

```bash
npm install                                    # electron postinstall may need approving
cd native && npx node-gyp configure && npx node-gyp build && cd ..
npm run build
```

- **Stop Tamper before rebuilding the addon** — a running Electron locks
  `memory_addon.node` and the link fails with `permission denied`.
- After changing `binding.gyp` sources, `configure` before `build`.
- **Rebuild the harness from PowerShell, never Bash** (Bash won't run vcvars
  and fails silently):
  `& cmd.exe /c 'call "…\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'`
  then delete `harness.obj` and **verify the timestamp changed**.
- `Tamper.cmd` at the repo root launches the built app.

---

## Conventions

- Addresses: `0x`-prefixed lowercase. Byte blobs: unspaced lowercase. AOB
  signatures: space-separated `??`-or-hex-pair tokens.
- Absent `mode` on a patch means `'nop'`; absent `signatureOffset` means 0.
  Backwards compatibility with saved `games/*.json` is a hard requirement.
- Hex helpers (`ParseHex`/`ToHex`) are duplicated across four native files —
  known debt, a shared header is due.

---

## Read these before deep work

- `docs/superpowers/specs/2026-07-25-code-injection-design.md` — the design.
- `docs/superpowers/follow-ups/2026-07-28-valheim-session.md` — **eight real
  defects found in-game and why Valheim health is still unsolved.** Read this
  before touching signatures or cave layout.
- `docs/superpowers/follow-ups/2026-07-25-code-patch-cheats.md` — earlier
  carried follow-ups.

**Highest-value open item:** a background retry on a failed locate. Mono
compiles a method on first call, so a patch legitimately cannot be found until
the game runs that code — and the current message ("may have been re-compiled —
re-capture it") sends users exactly the wrong way.

# Tamper (aka Apprentice) — codebase map

Written for an agent picking this up cold. Read this instead of exploring;
open a file only when you need to change it. Line counts are indicative.

**What it is:** an offline Windows game trainer. Electron + React + TypeScript
over a C++ N-API addon, plus a standalone read-only MCP server exposing the
same native primitives for live reverse-engineering sessions. Four ways to
cheat: *value cheats* (find an address, write it repeatedly), *code patches*
(rewrite the instruction that writes the value, one of eight modes), *Lua
scripts* (sandboxed, hotkey- or toggle-driven, for effects too dynamic for a
patch), and importing an existing Cheat Engine `.CT` table. Primary target:
Valheim (Mono JIT); Elden Ring is also bundled.

---

## Layer map

```
renderer (React)  ──IPC──▶  main (TypeScript)  ──N-API──▶  native (C++)  ──▶  game process
src/renderer/src            src/main                       native/src

mcp-server (stdio MCP)  ──N-API (same addon)──▶  native (C++)  ──▶  game process
```

The renderer never touches memory. All process access is in `native/`, exposed
through `src/main/nativeAddon.ts`, and reached from the UI only via the
channels in `src/main/ipc.ts` bridged in `src/preload/index.ts`. The MCP
server (`mcp-server/`) is a separate package that `require()`s the same built
`memory_addon.node` directly — it does not go through Electron or IPC at all,
and it is read-only (no write/patch/inject tools).

---

## native/src — everything that touches the game

| File | Lines | Responsibility |
|---|---|---|
| `mono_bridge.cc` | 2604 | **Mono runtime introspection.** Resolves classes/fields by name, gets a static field's address, compiles a method to get its live JIT entry, lists every field/method/assembly/class name, and injects a small collector stub (`BuildAssemblyCollectorStub`) to walk `mono_assembly_foreach`-style APIs that have no batch query. Every export attaches a throwaway thread to the Mono runtime first and detaches after — calling into Mono from an unattached thread is unsafe, and a managed method's own body may itself call back into Mono (e.g. a ZDO lookup), so this is the one mechanism the rest of the file exists to make safe. |
| `write_watch.cc` | 982 | **Find-what-writes.** Hardware breakpoints (Dr0/Dr7) via a debugger loop; decodes the faulting instruction with Zydis; builds the AOB **signature**. Handles signed displacement and DLL-load session stability. One of the most subtle files here. |
| `cave_ops.cc` | 945 | Code-cave primitives: `allocateCave`, `freeMemory`, `decodeRun`, and the instruction **encoders** — `encodeStore`, `encodeStoreRegister`, `encodeScale`, `encodeConditionalScale`, `encodeCaptureOnce`, `encodeGuardedSkip`, `encodeImmuneGuard`, `encodeJump` — plus thread suspend/resume wrappers. One encoder per patch mode (see below). |
| `scanner.cc` | 376 | Value scanning: `scanFirst` / `scanNext`, generalized over every `DataType` width via `value_type.h` (int8/16/32/64, float, double), chunked region reads, process-liveness checks, and optional range bounds. |
| `mono_call.cc` | 392 | `callRemoteFunction`/`callRemoteFunctionFloat`/`monoCallAttached` — calls an arbitrary function (game code, not just Mono API) on an injected thread, up to 4 pointer-sized args, returning both the integer (RAX) and float (XMM0) result. Frees its own scratch cave after the call. |
| `pointer.cc` | 387 | Pointer-chain discovery: `CollectPointers` + `CollectChains` walk every loaded module's static roots (not just the .exe — Mono/Unity runtime DLLs commonly own the real anchor) and score candidate chains in one pass — the same problem Cheat Engine's multi-restart pointer scan solves, done here via module-anchor scoring instead of repeated rescans. Capped and chunked to bound worst-case cost. |
| `patch_ops.cc` | 306 | `readBytes` / `writeBytes` (protect → write → restore → flush) and `scanAob`, bounded by optional `(rangeStart, rangeEnd)`, plus `resolveAddress`/`resolveExport`. |
| `platform/platform_win32.cc` | 393 | The OS backend: read/write/query/allocate-near/free/suspend-all, `ListModules`, and `ListThreads`/`GetThreadRegisters` (live register inspection). |
| `script_ops.cc` | 712 | **Lua 5.4 sandbox.** Runs a script cheat's enable/disable Lua on a background `AsyncWorker`, with an allowlisted global set, a memory cap, and a *sticky* 5-second timeout (delivered as an ordinary Lua error so a script wrapping it in `pcall` can't fake a clean run — see `scriptRuntime.ts` for the thread-leak accounting this forces). Binds `resolvePointer` and memory read/write into the sandbox. |
| `disasm_ops.cc` | 97 | `disassembleBuffer` — Zydis-backed disassembly of a raw byte buffer, for Memory Viewer's disassembly view. |
| `process_utils.cc` | 88 | Process enumeration, attach, and detach (closes the handle rather than leaking it). |
| `thread_ops.cc` | 78 | `listThreads`/`getThreadRegisters` JS-facing wrappers over the platform layer. |
| `memory_ops.cc` | 98 | `readValue` / `writeValue` through an offset chain, generalized over every `DataType` width. |
| `addon.cc` | 113 | N-API export table (36 exports — see below). |
| `module_info.cc` | 37 | `listModules`: every module loaded in the target (name, base, `SizeOfImage`, `TimeDateStamp`, version string) — the PE fields a build fingerprint is made of. Returns `[]` rather than throwing on a protected/exiting process. |
| `chain_walk.h` | 55 | Shared forward pointer-walk helper, hoisted out of `mono_bridge.cc`/`pointer.cc` duplication. |
| `protected_write.h` | 161 | Shared protect → write → restore → flush helper every write path (patch, Lua, UI byte edit) routes through, so a failed write is reported rather than silently dropped or left unprotected. |
| `platform/platform_linux.cc` | 49 | Stub: compiles, loads, refuses (`IsSupported() === false`). |

**Addon exports (36):** `ping listProcesses attach detach scanFirst scanNext
resolvePointerChain getModuleBase readValue writeValue resolveAddress
startWriteWatch pollWriteWatch stopWriteWatch readBytes writeBytes scanAob
platformName allocateCave freeMemory decodeRun encodeStore
encodeStoreRegister encodeScale encodeConditionalScale encodeCaptureOnce
encodeGuardedSkip encodeImmuneGuard encodeJump suspendThreads resumeThreads
listModules resolveExport createRemoteThread callRemoteFunction
callRemoteFunctionFloat monoResolveClass monoResolveField
monoStaticFieldAddress monoCompileMethod monoListFieldNames
monoListMethodNames monoListAssemblies monoListAssemblyNames
monoListClassesInImage monoCallAttached runScript disassembleBuffer
listThreads getThreadRegisters`

`scanAob` takes optional `(rangeStart, rangeEnd)` bounds (inclusive-exclusive)
after the signature; absent bounds walk all executable memory. Bounding to a
module's `[base, base+size)` is what lets a scan recover without paying to
re-search the whole process.

**The platform seam** (`platform/platform.h`) exists so injection can be
ported to Linux. **Only new code uses it** — `cave_ops.cc` must contain *no*
Win32 call. The older modules (scanner, pointer, memory_ops, write_watch,
patch_ops) still call Win32 directly; porting them is a separate sub-project.

---

## src/main — decisions, all testable against a fake process

| File | Lines | Responsibility |
|---|---|---|
| `ipc.ts` | 1503 | Channel handlers (see full list below), the live `patchOps`/`AnchorOps` implementations, anchor resolution, freeze/script/hotkey wiring, `refreshModuleContext`/`attachTo` (shared by manual attach and the watcher), CT import/export handlers, and the push-event senders — every one guarded against a destroyed renderer window. |
| `patchEngine.ts` | 1194 | **The core.** Locate / apply / restore for code patches across all eight modes, and the cave assembly for every injection mode. Takes a `PatchOps` interface, so every path — especially every refusal — is tested without a game. Also owns `setAnchorContext` (module map + verified set), `onRelearn`, and `monoMethodOffset` (patching mid-method Mono JIT sites, not just the method entry). |
| `store.ts` | 404 | Types (`CheatDefinition`, `PatchCheat`, `ScriptCheat`, `ChainTarget`, `AnchorTarget`, `MonoTarget`) and thin CRUD over `profile.ts`'s `loadProfile`/`saveProfile`. `DataType` is `int8\|int16\|int32\|int64\|float\|double` — every width `scanner.cc`/`memory_ops.cc` handle uniformly. A target can carry a per-target `value`/`dataType` override, a `bitIndex` for single-bit read-modify-write, and `offValue` (written once on disable/delete for fields the game never resets on its own). |
| `ctImport.ts` | 653 | Imports Cheat Engine `.CT` tables: plain (non-Auto-Assembly) entries map onto `ChainTarget`/freeze; nop-shape, register-copy-shape, and force-shape Auto Assembly scripts map onto the matching patch mode. No general AA interpreter — a script that doesn't reduce to one of these shapes is reported skipped, not guessed at. Hardened against regex/complexity DoS (quadratic tag matching, oversized inputs) and run through `ctImportSafe.ts`/`ctImportWorker.ts` on a worker-thread execution budget. |
| `ctExport.ts` | 291 | The reverse: builds a `.CT` table from this app's own cheats. `nop`/`replace`/`force` patches have a direct Auto Assembly equivalent. `capture`/`guard`/`immune`/`scale`/`copy` modes and any Mono-resolved target are reported **skipped** rather than approximated — they rely on live Mono metadata resolved fresh per install, which AA has no equivalent for. |
| `nativeAddon.ts` | 349 | Typed wrappers over all 36 addon exports. Throwing / non-throwing pairs: `readValue`/`tryReadValue`, `readBytes`/`tryReadBytes`. |
| `anchor.ts` | 216 | `resolvePatchAddress`: where a module-anchored patch lives *right now*. Tries module-base + RVA first (only when the module's fingerprint is verified), falls back to a scan bounded to that module's address range, and verifies captured bytes on **both** paths before trusting an address. Returns an `AnchorReason` (`module-missing` / `no-match` / `ambiguous` / `bytes-differ` / `not-yet-compiled`) rather than a bare failure. A successful scan writes its RVA back to the profile (`relearnedOffset`). |
| `cheatRuntime.ts` | 197 | `CheatRuntime`: the state machine behind a patch chip (`idle → arming → active`, plus `degraded`/`failed`), with exponential backoff retrying only `RETRYABLE` reasons — `not-yet-compiled` is not an error, it means Mono hasn't JITted the method yet. Generation counters guard against a disarm()+arm() race. |
| `monoTargetResolve.ts` | 140 | Resolves a `MonoTarget` to a live address: find the class, find the static field, either use its storage address directly or dereference to an object pointer and add an instance field's offset (the `[LocalPlayer]+Player.m_godMode` shape). Never throws — every failure returns `null`. |
| `freezeLoop.ts` | 144 | Rewrites frozen values on a tick, routed through the shared protect/restore helper; skips an overlapping tick if a write is slow; marks a cheat degraded after repeated failure. |
| `hotkeys.ts` | 152 | `HotkeyManager`: register/fire/conflict logic behind an injectable ops interface, covering freeze, one-shot, patch-arm, and script cheats uniformly. |
| `scriptRuntime.ts` | 133 | `ScriptRuntime`: async enable/disable for Lua script cheats with an in-flight guard and state handoff. Caps concurrent script runs at 2 (`MAX_CONCURRENT_SCRIPT_RUNS`) — a stuck script strands its libuv worker thread permanently (Lua's sticky timeout can't kill it from outside), so the cap bounds how much of the 16-thread pool (see `threadpool.ts`) a leak can ever consume. |
| `monoResolver.ts` | 60 | Thin, never-throwing wrappers over the native Mono bridge exports. |
| `monoClassLocations.ts` | 36 | Finds every assembly defining a class with a given name — surfaces an ambiguous resolve (native `MonoResolveClass` silently stops at the first match) so Mono Explorer can warn instead of trusting a resolve blindly. |
| `captureStore.ts` | 36 | Runtime record of a cheat's pre-freeze value, for `captureOriginal` restore mode: captured on enable, consumed (and removed) on every disable path — manual toggle, delete, or the quit/process-switch restore sweep. |
| `watcher.ts` | 87 | `ProcessWatcher`: polls `listProcesses` for a process this game has a profile for, fires `onAppear`/`onVanish`. Attaches only — auto-arming into an unverified build risks corrupting a save. |
| `profile.ts` | 161 | `games/<exe>.json` schema 2: `{ schema, exe, modules, cheats }`. Schema 1 (bare cheat array) loads as an empty-fingerprint profile. Saves go through a temp-file-and-rename, not a direct write. |
| `threadpool.ts` | 20 | Side-effect-only, imported first: sets `UV_THREADPOOL_SIZE=16` before anything else can touch libuv's threadpool (see `scriptRuntime.ts`). |
| `index.ts` | 46 | Electron main entry: window creation, lifecycle, wiring `threadpool.ts` first. |

**IPC channels:** `process:list process:attach detach game:current game:state
cheats:load cheats:save cheats:delete cheats:isEnabled cheats:toggleFreeze
cheats:oneShot cheats:verify cheats:resolveTargetAddress scripts:toggle
scripts:isEnabled scripts:run scan:first scan:next scan:resolveChain
writeWatch:start writeWatch:poll writeWatch:stop patch:locate patch:apply
patch:restore patch:slot memory:readBlock memory:writeByte
memory:disassemble memory:resolveTargetAddress threads:list
threads:registers mono:resolveClass mono:listFields mono:listMethods
mono:listAssemblyNames mono:listClassesInImage mono:classLocations
mono:resolvePlayerPointer mono:readLiveValue mono:resolveMethodBytes
hotkeys:conflicts ct:import ct:export`

**Push events** (main → renderer): `game:state` (attach, and watched-process
vanish — `{ exe, pid, changedModules }`), `cheat:state` (every `CheatRuntime`
transition), `cheat:broken`/`cheat:recovered` (freeze-loop degraded/recovered,
mirrored into `CheatRuntime`), `hotkey:fired`/`hotkey:conflict`.

---

## mcp-server — read-only MCP tools over the same native addon

Standalone package, `require()`s `native/build/Release/memory_addon.node`
directly (`src/addon.ts`) rather than shipping its own copy or going through
Electron/IPC. Registered in `.mcp.json` at the repo root, run over stdio.
**No write, patch, or inject tools** — attach/scan/read/disassemble/write-watch
only, for live reverse-engineering sessions against a running game without
risking the target.

| File | Lines | Responsibility |
|---|---|---|
| `addon.ts` | 138 | Native addon wrapper, mirrors `src/main/nativeAddon.ts`'s conventions independently (separate package, no shared import). |
| `tools/mono.ts` | 123 | `mono_resolve_class`, `mono_resolve_field`, `mono_static_field_address`, `mono_list_field_names`, `mono_list_method_names`, `mono_list_assemblies`, `mono_list_assembly_names`, `mono_list_classes_in_image`. |
| `tools/scan.ts` | 90 | `scan_first`/`scan_next`/`scan_aob`, range-bounded, process-liveness checked. |
| `tools/disasm.ts` | 45 | `disassemble_buffer`, rejects malformed hex rather than silently truncating. |
| `tools/watch.ts` | 38 | `start_write_watch`/`poll_write_watch`/`stop_write_watch`. |
| `tools/read.ts` | 39 | `read_bytes`/`read_value`. |
| `tools/process.ts` | 37 | `list_processes`/`attach`/`list_modules`. |
| `server.ts` / `index.ts` | 22 / 13 | MCP server wiring, stdio registration. |

`@modelcontextprotocol/sdk` is pinned to an exact version (see its README) to
avoid a `registerTool` TS2589 build failure. `npm install` builds `dist/`
automatically via the `prepare` script.

---

## src/renderer — deliberately plain React

`screens/ProcessPicker.tsx` → `screens/CheatList.tsx` (rows, toggles, patch
status chips, hotkey capture UI, "View in Memory"/"Edit…" entry points) and
`screens/Scanner.tsx` (scan → narrow → find-what-writes → create cheat or
patch). `screens/MonoExplorer.tsx` (browse assemblies/classes/fields/methods,
or resolve by exact name; warns on an ambiguous cross-assembly match) and
`screens/MemoryViewer.tsx` (live hex+ASCII grid with inline byte edit,
scrollable disassembly view, Structure Dissect panel, live Registers panel) —
both reachable from Scanner/CheatList's "View in Memory". `tamper.d.ts` types
the preload bridge. No component library, no styling system — match the
surrounding code.

`App.tsx` keeps Scanner **mounted but hidden** when you navigate away, so a
scan isn't thrown away.

---

## The eight patch modes

Set by `PatchCheat.mode`; **absent means `'nop'`** so pre-injection saved
patches keep working.

| Mode | Cave body | Reaches |
|---|---|---|
| `nop` | *(no cave — writes NOPs at the site)* | every object that code runs for |
| `replace` | *(no cave — fixed-length in-place instruction swap)* | every object |
| `force` | `effect + tail + jmpBack` — the captured store is **replaced**, not replayed | every object |
| `copy` | `effect + displaced + jmpBack` — copies a live register into `[reg+offset]` via `encodeStoreRegister` | every object |
| `scale` | `effect + displaced + jmpBack` — multiplies the captured value via `encodeScale`; with a `compareMonoMethod` set, becomes **conditional scale** (`encodeConditionalScale`) — multiplies only when a live Mono call gates it true (e.g. attacker-only damage multipliers) | every object, or attacker-gated subset |
| `capture` | `effect + displaced + jmpBack` — records the object pointer into the slot, changes nothing | n/a (feeds an anchored cheat) |
| `guard` | `guardBlob + displaced + jmpBack` — compares the object against the slot, skips the write for that one | **one object only** |
| `immune` | `encodeImmuneGuard` variant of guard, arm pointer resolved dynamically (Mono or non-Mono games) rather than fixed at capture time | **one object only** |

**Cave layout is fixed:** slot at `cave+0` (8 bytes, holds a captured pointer),
code at `cave+8`.

**The effect always runs first**, before any replayed instruction. This is not
stylistic: `decodeRun` rounds up to whole instructions to reach the 5 a
`jmp rel32` needs, so a short captured store drags in whatever follows — and if
that clobbers the base register, an effect running afterwards dereferences
garbage. This crashed Valheim.

`monoMethodOffset` lets a patch anchor mid-method (a Mono JIT site past the
method entry) rather than only at the compiled entry point.

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
  Failed installs free their leaked cave; a failed restore is reported, not
  silently treated as idle.
- Restore on disable, on delete, on detach, on quit, and on process switch —
  including freeze cheats (`captureOriginal` mode restores the pre-freeze
  value captured at enable time, via `captureStore.ts`).
- `restore` writes back the **full displaced run**, not `patch.length` — they
  differ whenever the captured instruction is under 5 bytes.
- Calling into Mono (any `mono_bridge.cc`/`mono_call.cc` export) always
  attaches a throwaway thread first and detaches after — an unattached-thread
  call is unsafe, and a managed method's own body may call back into Mono.
- A Lua script's 5-second timeout is **sticky** — delivered as an ordinary
  error so a `pcall`-wrapped infinite loop can't fake a clean run. The worker
  thread it stranded is still lost for the process's lifetime; the concurrency
  cap in `scriptRuntime.ts` bounds the damage, it doesn't fix the leak.
- Every main→renderer push is guarded against a destroyed window.
- Profile saves go through a temp-file-and-rename, never a direct write.

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
arithmetic path instead of re-scanning.

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

## Interop with Cheat Engine

Bidirectional, file-format-level only — Apprentice never drives the CE
process or its network protocol. Both directions are deliberately partial:
`ctImport.ts` recognizes plain entries plus three Auto-Assembly shapes
(nop/copy/force) and reports anything else skipped rather than guessing;
`ctExport.ts` covers `nop`/`replace`/`force` patches and plain-address value
targets, and skips the modes/targets that depend on live Mono metadata
resolved fresh per install (no fixed address a `.CT` entry could hold).
Apprentice's own native primitives already cover CE's core feature set —
value/AOB scan, pointer-chain discovery (`pointer.cc`'s module-anchor scoring
solves what CE's multi-restart pointer scan solves, in one pass), find-what-
writes, code injection, remote function calls, Mono introspection, a
disassembler, and Lua scripting — so there's no case for adding a CE-process
dependency (e.g. driving `ceserver`'s network protocol) on top of this.

---

## Tests — 557 across 37 files, and what they can't tell you

`npx vitest run` · `npx tsc --noEmit` · `npm run build`

Native tests drive a **real child process**: `test-harness/harness.exe`, built
from `harness.c`, driven over stdin (`drainloop`, `forceloop`, `wideloop`,
`shieldloop`, `tight_write`, `loaddll`, `loaddll2`, `unloaddll`,
`negdisploop`, plus int8/int16/int64/double coverage commands, …).

`bigalloc` / `bigallocfree` and `bigcode` / `bigcodefree` allocate one 8 MiB
region (data / executable respectively), replying `OK <0xbase>`, with a marker
value deliberately placed ACROSS the 4 MiB chunk boundary the native region
readers use. `scanner.test.ts` and `patch_ops.test.ts` use these to prove
chunked region reads never drop a boundary-straddling candidate.

`loaddll` / `loaddll2` / `unloaddll` load and unload a real DLL
(`probe.dll` / `probe2.dll`, a size/timestamp-varied variant of the same
DLL) into the harness process, replying `OK <0xbase>`. This is what
`tests/native/module_info.test.ts` uses to prove `listModules` sees a module
appear/disappear with a plausible fingerprint, that two builds of "the same"
DLL fingerprint differently, and that the same bytes read at a fixed RVA
survive the DLL being unloaded and reloaded at a **different** base address.

The MCP server has its own test files (`mcp-server/tests/`), including an
integration test that spawns the built `dist/index.js` — requires
`cd mcp-server && npm install` to have run first (gitignored `dist/`).

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
- `Apprentice.cmd` at the repo root launches the built app.
- The MCP server is a separate opt-in build: `cd mcp-server && npm install`
  (builds `dist/` via its `prepare` script) — needed before `.mcp.json`'s
  registration or the integration test will work.

---

## Conventions

- Addresses: `0x`-prefixed lowercase. Byte blobs: unspaced lowercase. AOB
  signatures: space-separated `??`-or-hex-pair tokens.
- Absent `mode` on a patch means `'nop'`; absent `signatureOffset` means 0.
  Backwards compatibility with saved `games/*.json` is a hard requirement.
- Hex helpers (`ParseHex`/`ToHex`) are duplicated across several native files
  — known debt, a shared header is due.

---

## Read these before deep work

- `docs/superpowers/specs/2026-07-25-code-injection-design.md` — the original
  injection design.
- `docs/superpowers/follow-ups/2026-07-28-valheim-session.md` — **eight real
  defects found in-game and why Valheim health is still unsolved.** Read this
  before touching signatures or cave layout.
- `docs/superpowers/specs/` has a design doc per major feature since, in date
  order — mono-resolver, mono-authoring-tools, rename-and-ct-export,
  numeric-data-types, hotkeys, memory-viewer-scripting, live-registers-panel,
  ct-table-import, mcp-memory-server, scale-patch-mode. Read the one for the
  area you're touching; each captures *why*, not just *what*.

**Highest-value open item:** a background retry on a failed locate. Mono
compiles a method on first call, so a patch legitimately cannot be found until
the game runs that code — and the current message ("may have been re-compiled —
re-capture it") sends users exactly the wrong way.

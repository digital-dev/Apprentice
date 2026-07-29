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
| `patch_ops.cc` | 250 | `readBytes` / `writeBytes` (protect → write → restore → flush) and `scanAob`. |
| `scanner.cc` | 205 | Value scanning: `scanFirst` / `scanNext`. |
| `platform/platform_win32.cc` | 192 | The OS backend: read/write/query/allocate-near/suspend-all. |
| `memory_ops.cc` | 93 | `readValue` / `writeValue` through an offset chain. |
| `addon.cc` | 81 | N-API export table. |
| `process_utils.cc` | 67 | Process enumeration and attach. |
| `platform/platform_linux.cc` | 32 | Stub: compiles, loads, refuses (`IsSupported() === false`). |

**Addon exports:** `ping listProcesses attach scanFirst scanNext
resolvePointerChain getModuleBase readValue writeValue startWriteWatch
pollWriteWatch stopWriteWatch readBytes writeBytes scanAob platformName
allocateCave decodeRun encodeStore encodeCaptureOnce encodeGuardedSkip
encodeJump suspendThreads resumeThreads`

**The platform seam** (`platform/platform.h`) exists so injection can be ported
to Linux. **Only new code uses it** — `cave_ops.cc` must contain *no* Win32
call. The older modules (scanner, pointer, memory_ops, write_watch, patch_ops)
still call Win32 directly; porting them is a separate sub-project.

---

## src/main — decisions, all testable against a fake process

| File | Lines | Responsibility |
|---|---|---|
| `patchEngine.ts` | 571 | **The core.** Locate / apply / restore for code patches, and the cave assembly for every injection mode. Takes a `PatchOps` interface, so every path — especially every refusal — is tested without a game. |
| `ipc.ts` | 367 | Channel handlers, the live `patchOps` implementation, anchor resolution, freeze wiring. |
| `store.ts` | 156 | Persistence to `games/<exe>.json`. Types: `CheatDefinition`, `PatchCheat`, `ChainTarget`, `AnchorTarget`. |
| `nativeAddon.ts` | 138 | Typed wrappers over the addon. Note the throwing / non-throwing pairs: `readValue`/`tryReadValue`, `readBytes`/`tryReadBytes`. |
| `freezeLoop.ts` | 87 | Rewrites frozen values on a tick; marks a cheat degraded after repeated failure. |

**IPC channels:** `process:list process:attach cheats:load cheats:save
cheats:delete cheats:toggleFreeze cheats:oneShot scan:first scan:next
scan:resolveChain writeWatch:start writeWatch:poll writeWatch:stop
patch:locate patch:apply patch:restore patch:slot`

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

## Tests — 145, and what they can't tell you

`npx vitest run` · `npx tsc --noEmit` · `npm run build`

Native tests drive a **real child process**: `test-harness/harness.exe`, built
from `harness.c`, driven over stdin (`drainloop`, `forceloop`, `wideloop`,
`shieldloop`, `tight_write`, …).

**The harness is a static MSVC binary; the real target is Mono JIT.** Almost
every defect found in-game was invisible here for that reason: stable bytes
past a `ret`, no absolute addresses in code, no shared setters, well-behaved
threads. When a fix passes here, that is necessary and not sufficient.

Two hazards when editing tests:
- `tests/native/cave_ops.test.ts` must keep **exactly one top-level
  `beforeAll`** — awaiting an `AsyncWorker` promise in a second one reliably
  segfaults the vitest worker.
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

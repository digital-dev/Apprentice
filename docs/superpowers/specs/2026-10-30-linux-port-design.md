# Linux Port — Design

Date: 2026-10-30. Status: draft for approval.

## Intent

Apprentice runs only on Windows today. Make the same app run on Linux, against
both **native Linux games** and **Windows games running under Proton/Wine**,
with an interface that is identical to the Windows build. Most development stays
on Windows, so the port must not fork the codebase.

## Goals

- Same Electron + React UI, same IPC surface, same profiles in `games/`.
  A Proton game uses the same profile as its Windows build.
- One shared codebase. Linux-only code, build scripts, packaging and build output
  live in `Linux/`.
- Linux build is produced from Windows via WSL2/Docker scripts, and in CI on a real
  Linux runner.
- Windows behaviour is unchanged. Every step keeps the existing vitest suite and
  fixture replay green on Windows.
- Native layer stays C++ (decided with the user: C++ is the more viable route; Rust
  rewrite explicitly not wanted).

## Non-goals / anti-goals

- No UI redesign, no Linux-only screens, no new language, no copied-and-diverging
  tree.
- Not a regression on Windows to make Linux easier.
- Native-Linux game *profiles* (ELF offsets) are content, not part of this port; the
  backend must support them, but only Proton games work out of the box.
- MCP server / cheat-factory on Linux is a stretch goal, not required.
- Flatpak/Snap packaging (sandboxing blocks ptrace). AppImage and .deb only.

## Current state (from recon)

- `native/src/platform/platform.h` defines an OS interface; `platform_win32.cc` (393
  lines) implements it; `platform_linux.cc` (49 lines) is a stub returning
  `IsSupported() == false`.
- Only new code uses it. These still call Win32 directly: `scanner`, `pointer`,
  `memory_ops`, `patch_ops`, `write_watch` (40 call sites), `script_ops`,
  `process_utils`, `protected_write.h`, `chain_walk.h`, `snapshot_ops`, `mono_call`,
  `mono_bridge`, `cave_ops`, `addon.cc`.
- Zydis and Lua in `native/third_party` are portable C/C++.
- Code injection uses `CreateRemoteThread` with hand-assembled x64 stubs
  (Microsoft x64 calling convention). The platform header documents that rapid
  thread create/destroy cycles correlated with game crashes.
- Hardware write-watch uses thread debug registers (Dr0-Dr3/Dr7) via
  `Get/SetThreadContext`.
- TypeScript: only `steamLibrary.ts` is OS-gated (registry via `reg query`).
  `.exe`-stem matching is everywhere and is correct for Proton.
- Build/CI/launch are Windows-only (`electron-builder --win`, `Apprentice.cmd`,
  windows-2022 runners, node-gyp pinned for MSVC).

## Design

### Layout (my call)

```
native/src/            shared portable C++ + platform.h + platform_win32.cc
native/binding.gyp     adds OS=="linux" conditions pointing at ../Linux/native/
Linux/native/          platform_linux_*.cc: proc/maps, ptrace, remote exec, ELF/PE parse
Linux/scripts/         build-in-wsl, build-in-docker, run-tests, dev launcher
Linux/packaging/       electron-builder linux config, AppImage/deb, desktop entry
Linux/docker/          build image (Ubuntu 22.04 LTS baseline)
Linux/test-harness/    Linux ELF target + mingw-built PE target run under wine
Linux/dist/            build output (gitignored)
Linux/README.md        setup, ptrace permissions, troubleshooting
```

### Step 1 of the work: finish the abstraction on Windows

Move every direct Win32 call in the files above behind `platform.h` (read/write
memory, query regions, list processes/modules/threads, suspend/resume, protect,
allocate, remote exec, debug registers). Pure refactor, Windows behaviour
identical, gated by the existing tests. This is the highest-risk step for Windows
and goes first so regressions show up while Windows is still the only backend.

### Linux backend

| Capability | Linux mechanism |
|---|---|
| Process list / name | `/proc/*`. Wine processes: take the Windows exe basename from `/proc/pid/cmdline` (comm is truncated to 15 chars). Native: basename of `/proc/pid/exe`. |
| Regions | parse `/proc/pid/maps` |
| Modules | maps, file-backed entries. Wine/PE: read PE headers from target memory (size, timestamp). Native: ELF headers. |
| Read/write memory | `process_vm_readv` for reads; `/proc/pid/mem` for writes (ignores page protection, so patching code needs no mprotect) |
| Export resolution | PE export directory (Proton) or ELF `.dynsym` (native), read from target memory |
| Remote allocate / protect | injected `mmap`/`mprotect` syscall via ptrace |
| Remote execution | ptrace thread hijack: save regs, point rip at the stub, wait for a trap, restore. Presents the same create/wait/exit-code semantics as `CreateRemoteThread`, with no thread churn. |
| Thread list / registers | `/proc/pid/task`; `PTRACE_GETREGS` |
| Suspend/resume | ptrace attach/detach (or SIGSTOP) |
| Hardware watch | ptrace `PTRACE_POKEUSER` on `u_debugreg`; SIGTRAP handled by the watcher |

**Calling convention is per target, not per OS.** A Proton game's Mono/IL2CPP are
Windows PE DLLs, so remote calls use the Microsoft x64 convention (as today). A
native Linux game uses System V (rdi, rsi, rdx, rcx, r8, r9; no shadow space).
The stub generator takes an ABI parameter chosen from the target module type
(PE vs ELF).

**Permissions.** ptrace is restricted by Yama (`ptrace_scope`). The app detects
EPERM at attach and shows an actionable message. Supported setups, documented in
`Linux/README.md`: `setcap cap_sys_ptrace+ep` on the packaged binary (what the
AppImage/deb post-install does for the deb), or a lowered `ptrace_scope`, or root.
Read-only features (scan, pointer chains) work without it where `process_vm_readv`
is permitted.

**Proton containers.** The game runs inside pressure-vessel but is visible to the
host `/proc` with host pids, so the app attaches from the host. Anti-debug or
unavailable debug registers under virtualisation must degrade with a clear error,
not a crash.

### TypeScript changes (minimal)

- `steamLibrary.ts`: Linux branch replaces the registry read. Look in
  `~/.steam/steam`, `~/.local/share/Steam`, parse `libraryfolders.vdf` (existing
  VDF parsing is reused), and find games under `steamapps/common`.
- Process picker's hidden-process list gains Wine helpers (`wineserver`,
  `services.exe`, `explorer.exe`, `winedevice.exe`, ...). Same list UI.
- Error text for `IsSupported()`/EPERM is routed through existing error paths.
- No renderer, preload or IPC contract changes.

### Build, test, packaging

- `Linux/scripts` build the addon and app inside WSL2 or Docker from a Windows
  checkout (no cross-compiling). Build output goes to `Linux/dist/`.
- CI adds an `ubuntu-22.04` job: build addon, run vitest, run native harness tests,
  build AppImage + deb, upload artifacts. Existing Windows jobs untouched.
- Native tests: a Linux ELF target for the native path, and a tiny Windows exe
  built with mingw-w64 and run under `wine` in CI for the Proton path (memory
  walk, export resolution, remote call with the MS ABI).
- Launcher: `Linux/scripts/apprentice.sh` (equivalent of `Apprentice.cmd`).

### Staging (each stage is mergeable and leaves Windows green)

1. Refactor Win32 calls behind `platform.h`. Windows only, no Linux code yet.
2. Linux skeleton: binding.gyp conditions, build scripts, CI job, app launches on
   Linux and lists processes via `/proc`.
3. Read-only: regions, modules (PE + ELF), memory read, scanner, pointer chains,
   disassembly view. Usable trainer for watching values.
4. Writes: memory write, patching, freeze.
5. ptrace remote execution + remote alloc/protect: code caves, Lua script ops.
6. Mono and IL2CPP bridges for Proton (MS ABI) then native (SysV).
7. Write-watch / hardware breakpoints, snapshots, registers panel.
8. Steam library discovery, packaging polish, README, release job.

## Left to the builder

Exact `platform.h` signatures (it must stay expressible on both OSes); whether
remote execution reuses one hijacked thread or a pool; handling of multi-threaded
attach ordering; Yama-setup UX wording; which Ubuntu/glibc baseline to publish for.

## Risks

- Stage 1 touches ~14 files that work today; mitigated by tests and fixture replay
  and by doing it first.
- ptrace on Proton games may meet anti-cheat or container restrictions; failures
  must be clean errors. Games with kernel anti-cheat are out of scope on both OSes.
- Debug registers may be unavailable in VMs/WSL2; hardware watch needs a software
  fallback or a documented limitation.
- Electron is large; AppImage size is acceptable per Windows installer precedent.

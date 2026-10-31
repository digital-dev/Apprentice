# Linux Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Apprentice on Linux against native Linux games and Windows games under Proton/Wine, with an identical interface, from one shared codebase.

**Architecture:** Finish moving every direct Win32 call in `native/src` behind `native/src/platform/platform.h` (Windows behaviour unchanged), then add a Linux backend in `Linux/native/` built on `/proc`, `process_vm_readv`, and ptrace. Remote-call stubs become ABI-parameterised (Microsoft x64 for Proton targets, System V for native). TypeScript changes are limited to Steam discovery and process-list filtering.

**Tech Stack:** C++17 N-API addon (node-gyp), Zydis, Lua, Electron/React/TypeScript, vitest, Docker/WSL2 for Linux builds, GitHub Actions (ubuntu-22.04), mingw-w64 + wine for Proton-path tests, electron-builder (AppImage, deb).

**Spec:** `docs/superpowers/specs/2026-10-30-linux-port-design.md`

## Global Constraints

- C++ for the native layer; no Rust, no new language.
- Shared codebase: no copied tree. Linux-only code, scripts, packaging and output live under `Linux/`; `Linux/dist/` is gitignored.
- UI, preload, IPC contract and profile JSON schema (`games/*.json`, schema 2) do not change. A Proton game uses the same profile as its Windows build (exe stem matching, `.exe` stripped).
- Windows behaviour unchanged: after every task `npm test` passes on Windows and, for native tasks, the addon rebuilds with the project's existing procedure (see `.github/workflows/ci.yml`).
- Only `native/src/platform/platform_win32.cc` and `Linux/native/*` may include OS headers (`windows.h`, `sys/ptrace.h`, ...). Enforced by Task 5.
- Linux baseline: Ubuntu 22.04 (glibc 2.35). Docker build image and CI use it.
- Never set `PTRACE_O_EXITKILL`; never leave a target stopped after detach, error, or app exit.
- Remote-call ABI is chosen per target module type: PE module -> Microsoft x64; ELF module -> System V.
- Commits in this repo carry no `Co-Authored-By` or session trailers.
- Packaging targets: AppImage, deb, and an Arch tarball + `PKGBUILD` (no Flatpak/Snap). File capabilities (`setcap`) apply only to installed packages (deb, PKGBUILD), never to an AppImage (read-only mounted); the AppImage path relies on `ptrace_scope` or root and the app shows the exact fix command on denial.

## Review Focus

1. Wine process whose name has spaces, exceeds 15 chars, or whose `/proc/<pid>/cmdline` holds a Windows path with backslashes: the listed name is the exe basename (`Schedule I.exe`).
2. Target exits mid-operation (ESRCH/ENOENT during read, ptrace, or remote call): operation returns false, never hangs, and no other thread is left stopped.
3. ptrace denied by Yama (EPERM): the user sees an actionable message naming `ptrace_scope`/`cap_sys_ptrace`, not a generic failure; read-only features still work.
4. App quits or crashes while threads are stopped: target resumes (no EXITKILL; detach in every exit path).
5. Memory write straddling a mapping boundary or hitting an unmapped page: all-or-nothing false, nothing partially written without report.

---

## Stage 1 — Finish the abstraction (Windows only)

### Task 1: Process and region primitives in `platform.h`

**Files:**
- Modify: `native/src/platform/platform.h`, `native/src/platform/platform_win32.cc`, `native/src/platform/platform_linux.cc` (stub additions only)
- Test: `tests/native/platform.test.ts` (extend), `native/src/addon.cc` (expose a test-only `platformListProcesses` if no existing export reaches it)

**Interfaces:**
- Produces (in `namespace platform`):
  - `struct ProcessEntry { uint32_t pid = 0; std::string name; };`
  - `bool ListProcesses(std::vector<ProcessEntry>& out);` (name = exe file name incl. `.exe` for Windows)
  - `ProcessHandle OpenProcess(uint32_t pid, std::string& error);` returns 0 and fills `error` on failure
  - `void CloseProcess(ProcessHandle);`
  - `bool IsAlive(ProcessHandle);`
  - `Region` gains `bool writable = false;`
  - `uintptr_t MainModuleBase(ProcessHandle);` (0 on failure)

- [ ] **Step 1: Write failing test** in `tests/native/platform.test.ts`: `it('lists the harness process by name')` spawns via `spawnHarness()`, asserts `addon.listProcesses()` contains `{ pid: harness.pid, name: 'harness.exe' }`; `it('attach returns handle and baseAddress for the harness')`; `it('reports writable regions')` queries the harness's data region and expects `writable === true` through whichever existing export exposes `QueryRegion`.
- [ ] **Step 2: Run** `npx vitest run tests/native/platform.test.ts` — expect FAIL on the new tests.
- [ ] **Step 3: Implement** the declarations in `platform.h` and Win32 bodies in `platform_win32.cc` (Toolhelp snapshot, `OpenProcess` with the same access mask `Attach` uses today, `GetExitCodeProcess`, `EnumProcessModules`, `VirtualQueryEx` protection bits -> `readable/writable/executable`). Add `false`/`0` stubs to `platform_linux.cc` so the Linux target still compiles.
- [ ] **Step 4: Rebuild addon, run** `npx vitest run tests/native` — expect PASS.
- [ ] **Step 5: Commit** `git add native tests && git commit -m "refactor: process and region primitives behind platform.h"`

### Task 2: Port process_utils, module_info, chain_walk, memory_ops, scanner, pointer, snapshot to `platform::`

**Files:**
- Modify: `native/src/process_utils.cc`, `process_utils.h`, `module_info.cc`, `chain_walk.h`, `memory_ops.cc`, `scanner.cc`, `pointer.cc`, `snapshot_ops.cc`, `addon.cc`
- Test: existing `tests/native/{process_utils,module_info,memory_ops,scanner,pointer,snapshot_ops,signature_golden}.test.ts` are the regression suite; add `tests/native/noHandleLeak.test.ts`

**Interfaces:**
- Consumes: Task 1 primitives, `platform::ReadMemory`, `platform::QueryRegion`, `platform::ListModules`.
- Produces: these files contain no `HANDLE`, `DWORD`, `windows.h`, `VirtualQueryEx`, `ReadProcessMemory`. `IsProcessAlive(uintptr_t)` in `process_utils.h` forwards to `platform::IsAlive`. `chain_walk.h::FindModuleBase(platform::ProcessHandle, const std::string&)`.

- [ ] **Step 1: Write failing test** `noHandleLeak.test.ts`: attach/detach the harness 200 times, expect the Node process handle count (via `process.getActiveResourcesInfo()` or `/proc`-free Windows approach: `process.report.getReport().libuv` length) not to grow. This pins `Attach`/`Detach` still pair `OpenProcess`/`CloseProcess` after the port.
- [ ] **Step 2: Run** — expect PASS already (baseline); keep it as the guard.
- [ ] **Step 3: Implement** the port file by file; scanner iterates regions with `QueryRegion` using `readable`/`writable`/`executable` instead of `MEM_COMMIT`/`PAGE_*` masks. Preserve exact scan results: `signature_golden` must remain byte-identical.
- [ ] **Step 4: Rebuild, run** `npx vitest run tests/native tests/replay` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "refactor: read-side native ops use platform layer"`

### Task 3: Port write-side and injection callers

**Files:**
- Modify: `native/src/protected_write.h`, `patch_ops.cc`, `cave_ops.cc`, `script_ops.cc`, `mono_call.cc`, `mono_bridge.cc`, `thread_ops.cc`, `sigbuild.cc`
- Test: existing `tests/native/{patch_ops,cave_ops,script_ops,mono_call,mono_bridge,thread_ops}.test.ts`

**Interfaces:**
- Consumes: `platform::WriteMemory`, `AllocateNear`, `FreeMemory`, `CreateRemoteThread`, `WaitForRemoteThread`, `SuspendAll`, `ListThreads`, `GetThreadRegisters`.
- Produces: `protected_write.h` keeps `ProtectedCodeWrite(platform::ProcessHandle, uintptr_t, const void*, size_t)` and `ProtectedDataWrite(...)` with the same all-or-nothing and page-straddle semantics, now implemented as `platform::WriteMemory` plus a lock; `PageSize()` comes from `platform::PageSize()` (add to `platform.h`).

- [ ] **Step 1: Write failing test** in `tests/native/patch_ops.test.ts`: `it('rejects a write straddling into an unmapped page without partial effect')` — write 16 bytes across the end of a harness allocation, expect `false` and the first bytes unchanged.
- [ ] **Step 2: Run** — expect FAIL or PASS depending on current behaviour; if it passes, keep it as the pin.
- [ ] **Step 3: Implement** the port; replace direct `VirtualProtectEx`/`WriteProcessMemory` with `platform::WriteMemory` (Windows impl keeps its protection dance, restoring protection as found).
- [ ] **Step 4: Rebuild, run** `npx vitest run tests/native` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "refactor: write and injection ops use platform layer"`

### Task 4: DebugSession abstraction and write_watch port

**Files:**
- Modify: `native/src/platform/platform.h`, `platform_win32.cc`, `native/src/write_watch.cc`
- Test: `tests/native/write_watch.test.ts`

**Interfaces:**
- Produces:
  - `struct WatchEvent { uint32_t tid; uint64_t rip; int slot; ThreadRegisters regs; bool detached; };`
  - `class DebugSession { public: static std::unique_ptr<DebugSession> Attach(uint32_t pid, std::string& error); bool SetHwBreakpoint(uint32_t tid, int slot, uintptr_t address, size_t len, bool enable); bool Wait(uint32_t timeoutMs, WatchEvent& out); void Continue(const WatchEvent&); void Detach(); ~DebugSession(); };` — `Wait` returns false on timeout. Destructor calls `Detach` (target never left stopped).
  - `bool SupportsHardwareWatch();`
- Consumes: `ListThreads`, `GetThreadRegisters`.

- [ ] **Step 1: Write failing test** `it('stops watching and the target keeps running after stop')` in `write_watch.test.ts`: start watch, stop, then confirm the harness still answers a ping. Also keep every existing watch test.
- [ ] **Step 2: Run** `npx vitest run tests/native/write_watch.test.ts` — expect PASS on existing tests (baseline), new test defines the contract.
- [ ] **Step 3: Implement** `DebugSession` in `platform_win32.cc` by moving the current `DebugActiveProcess`/`WaitForDebugEvent`/Dr7 logic from `write_watch.cc` (including the drain-on-stop behaviour); `write_watch.cc` keeps instruction decoding (Zydis) and the session loop, calling only `DebugSession`. The loop must run `Attach` and `Wait` on the same thread (Windows requirement; Linux ptrace has the same one).
- [ ] **Step 4: Rebuild, run** `npx vitest run tests/native` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "refactor: DebugSession abstraction; write_watch platform-neutral"`

### Task 5: Enforce "no OS headers outside platform"

**Files:**
- Create: `tests/native/noWin32OutsidePlatform.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the test:** reads every file under `native/src` except `native/src/platform/platform_win32.cc`; fails if any contains `#include <windows.h>`, `<tlhelp32.h>`, `<psapi.h>`, `<sys/ptrace.h>`, or identifiers `HANDLE`, `DWORD`, `OpenProcess(`, `VirtualQueryEx`, `ReadProcessMemory`, `WriteProcessMemory`, `CreateRemoteThread(` outside the `platform::` declaration comments. Exclude comment lines.
- [ ] **Step 2: Run** `npx vitest run tests/native/noWin32OutsidePlatform.test.ts` — expect PASS (Tasks 1-4 removed all uses); if it lists files, finish porting them first.
- [ ] **Step 3: Run full suite** `npm test` — expect PASS.
- [ ] **Step 4: Commit** `git commit -m "test: guard Win32 calls to the platform layer"`

---

## Stage 2 — Linux skeleton

### Task 6: Build scaffold, Docker/WSL scripts, CI job, Linux test harness

**Files:**
- Create: `Linux/README.md`, `Linux/docker/Dockerfile`, `Linux/scripts/build-in-docker.sh`, `Linux/scripts/build-in-wsl.sh`, `Linux/scripts/run-tests.sh`, `Linux/scripts/apprentice.sh`, `Linux/test-harness/harness.c`, `Linux/native/` (move `platform_linux.cc` here from `native/src/platform/`)
- Modify: `native/binding.gyp` (linux condition sources -> `../Linux/native/platform_linux.cc`; add `"cflags_cc": ["-std=c++17","-fexceptions"]`), `.gitignore` (`Linux/dist/`), `.github/workflows/ci.yml` (new `linux` job), `tests/helpers/spawnHarness.ts`
- Test: `tests/native/addon_smoke.test.ts` (runs unchanged on Linux)

**Interfaces:**
- Produces: `spawnHarness(): ChildProcessWithoutNullStreams` picks `test-harness/harness.exe` on win32, `Linux/test-harness/harness` on linux, speaking the same stdin/stdout protocol as `test-harness/harness.c` (read that file; the Linux harness reimplements every command the native tests use). `Linux/scripts/build-in-docker.sh` builds the addon and runs `npm test` inside the image with the repo mounted.

- [ ] **Step 1: Write failing test:** none new; target outcome is `addon_smoke` and `spawnHarness.test.ts` passing on Linux. Add the `linux` CI job running `npx vitest run tests/native/addon_smoke.test.ts tests/native/spawnHarness.test.ts`.
- [ ] **Step 2: Run on Windows** `Linux/scripts/build-in-docker.sh` (or `build-in-wsl.sh`) — expect FAIL until harness and gyp changes exist.
- [ ] **Step 3: Implement** the files above. `Linux/test-harness/harness.c` is C11, no windows.h; the build script compiles it with `gcc -O0 -g`. The Dockerfile is `ubuntu:22.04` + `build-essential python3 nodejs(22) git`; install `wine64 mingw-w64` here too (used by Task 9).
- [ ] **Step 4: Run** `Linux/scripts/build-in-docker.sh` — expect addon builds and the smoke tests pass. Then `npm test` on Windows — expect PASS (no Windows regression; `binding.gyp` win condition untouched).
- [ ] **Step 5: Commit** `git commit -m "feat(linux): build scaffold, docker/wsl scripts, CI job, ELF test harness"`

### Task 7: `/proc` process listing, naming, attach, liveness

**Files:**
- Create: `Linux/native/proc_parse.h` (header-only parsers), `Linux/native/platform_linux_process.cc`, `Linux/native/tests/proc_parse_test.cc`, `Linux/native/tests/fixtures/cmdline_wine.bin`, `Linux/native/tests/fixtures/maps_wine.txt`
- Modify: `Linux/scripts/run-tests.sh` (build and run `proc_parse_test` first)
- Test: `Linux/native/tests/proc_parse_test.cc`, `tests/native/platform.test.ts` (Task 1 tests pass on Linux)

**Interfaces:**
- Produces in `proc_parse.h` (namespace `linuxproc`):
  - `std::string ExeNameFromCmdline(const std::string& cmdlineNulSeparated, const std::string& exeLinkTarget);` — if argv[0] or argv[1] ends in `.exe` (case-insensitive) after splitting on `\`, `/`, return that basename (Wine); else basename of `exeLinkTarget`.
  - `bool ParseMapsLine(const std::string& line, MapsEntry& out);` with `struct MapsEntry { uintptr_t start, end; bool r, w, x, priv; uint64_t offset; std::string path; };`
- `platform::ListProcesses/OpenProcess/CloseProcess/IsAlive/MainModuleBase` implemented. `OpenProcess` returns a pid-based `ProcessHandle`; `IsAlive` checks `/proc/<pid>` exists and state is not `Z`.

- [ ] **Step 1: Write failing tests** in `proc_parse_test.cc` (plain `assert`s): `ExeNameFromCmdline("C:\\Games\\Schedule I\\Schedule I.exe\0", "/usr/bin/wine64-preloader")` == `"Schedule I.exe"`; a name > 15 chars; argv[0]=`Z:\home\u\game.exe`; a native case `("./Game\0", "/opt/game/Game.x86_64")` == `"Game.x86_64"`; `ParseMapsLine` on a line with a path containing spaces and a ` (deleted)` suffix.
- [ ] **Step 2: Run** `Linux/scripts/run-tests.sh` — expect FAIL (header missing).
- [ ] **Step 3: Implement** parsers and process functions; filter out kernel threads and zombies; read `/proc/<pid>/cmdline` + `exe` readlink (readlink may fail for other users' processes — fall back to `comm`).
- [ ] **Step 4: Run** `Linux/scripts/run-tests.sh` then the platform tests in Docker — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): /proc process listing with Wine-aware naming"`

---

## Stage 3 — Read-only features

### Task 8: Regions, memory read, ELF and PE module listing, export resolution

**Files:**
- Create: `Linux/native/platform_linux_memory.cc`, `Linux/native/module_parse.h`
- Test: `tests/native/{memory_ops,scanner,pointer,module_info,snapshot_ops,platform}.test.ts` (existing, now passing on Linux), `Linux/native/tests/module_parse_test.cc`

**Interfaces:**
- Produces: `platform::ReadMemory` via `process_vm_readv` (fallback `pread` on `/proc/<pid>/mem`; partial reads return false), `platform::QueryRegion` from `/proc/<pid>/maps` (gaps report `free = true`), `platform::PageSize`, `platform::ListModules` (file-backed mappings grouped by path; for a mapping whose first bytes are `MZ`, read PE `SizeOfImage`/`TimeDateStamp` from target memory; for `\x7fELF`, size = span of the file's mappings, timestamp 0), `platform::ResolveExport` handling both PE export directory and ELF `.dynsym`/`DT_GNU_HASH`-less linear symbol walk (read via the loaded `PT_DYNAMIC`).
- `module_parse.h`: `bool ParsePeExports(const std::function<bool(uintptr_t,void*,size_t)>& read, uintptr_t base, std::map<std::string,uintptr_t>& out);` and `bool ParseElfDynsym(<same read>, uintptr_t base, std::map<std::string,uintptr_t>& out);` — pure, testable against byte buffers.

- [ ] **Step 1: Write failing tests:** `module_parse_test.cc` loads two small fixture binaries (a mingw-built DLL header blob and an ELF `.so` header blob copied into `Linux/native/tests/fixtures/`) and asserts a known export resolves to the expected RVA/address. Existing tests in `tests/native/` define the rest.
- [ ] **Step 2: Run** `Linux/scripts/build-in-docker.sh` — expect failures listing unimplemented platform calls.
- [ ] **Step 3: Implement** per the Interfaces. Address-space note: `uintptr_t` addresses above 2^47 never occur on x86-64 Linux user space; no special handling.
- [ ] **Step 4: Run** `Linux/scripts/build-in-docker.sh` — expect all read-side native tests PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): maps, memory read, module listing, export resolution"`

### Task 9: Proton path test harness (mingw + wine)

**Files:**
- Create: `Linux/test-harness/build-wine-harness.sh`, `Linux/test-harness/README.md`
- Modify: `tests/helpers/spawnHarness.ts` (env `APPRENTICE_HARNESS=wine` launches `wine Linux/test-harness/harness-wine.exe`), `.github/workflows/ci.yml` (second linux step with the env set), `Linux/scripts/run-tests.sh`
- Test: `tests/native/platform.test.ts`, `memory_ops.test.ts`, `module_info.test.ts` run under both harness modes

**Interfaces:**
- Produces: `Linux/test-harness/harness-wine.exe` = `test-harness/harness.c` compiled with `x86_64-w64-mingw32-gcc`. The Wine process must be listed as `harness-wine.exe` (Task 7 naming) and its PE modules must list `harness-wine.exe`, `kernel32.dll`.

- [ ] **Step 1: Write failing test:** in `tests/native/module_info.test.ts` add `it('lists a PE module with version info under Wine')`, skipped unless `APPRENTICE_HARNESS=wine`.
- [ ] **Step 2: Run** `APPRENTICE_HARNESS=wine Linux/scripts/build-in-docker.sh` — expect FAIL.
- [ ] **Step 3: Implement** the build script and spawn switch. The PE `ResolveExport` of `kernel32.dll!GetProcAddress` must return a non-zero address inside a mapping marked executable.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "test(linux): wine/mingw harness for the Proton path"`

---

## Stage 4 — Writes

### Task 10: WriteMemory via `/proc/<pid>/mem`

**Files:**
- Create: `Linux/native/platform_linux_write.cc`
- Test: `tests/native/{patch_ops,memory_ops}.test.ts`, plus new `it('write into read-execute page succeeds and leaves protection unchanged')` in `patch_ops.test.ts`

**Interfaces:**
- Produces: `platform::WriteMemory` using `pwrite` on `/proc/<pid>/mem`; a short write or error returns false and the caller sees unchanged-or-reported state: verify by reading back before returning true is NOT required; but a straddle into an unmapped page must pre-check with `QueryRegion` for every page and refuse before writing (all-or-nothing, Review Focus 5).

- [ ] **Step 1: Write failing tests** as above, plus `it('refuses a write straddling an unmapped page and writes nothing')`.
- [ ] **Step 2: Run** `Linux/scripts/build-in-docker.sh` — expect FAIL.
- [ ] **Step 3: Implement.** Cache one `/proc/<pid>/mem` fd per `ProcessHandle`, closed by `CloseProcess`; reopen when `IsAlive` flips false.
- [ ] **Step 4: Run** same — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): memory writes through /proc/pid/mem"`

---

## Stage 5 — ptrace, allocation, remote execution

### Task 11: ptrace core: attach, stop, registers, suspend/resume, EPERM reporting

**Files:**
- Create: `Linux/native/ptrace_core.h`, `Linux/native/ptrace_core.cc`
- Modify: `Linux/native/platform_linux_process.cc` (`SuspendAll`, `ResumeAll`, `ListThreads`, `GetThreadRegisters`, `SleepMs`)
- Test: `tests/native/thread_ops.test.ts` (existing), new `tests/native/linuxPtrace.test.ts` (skipped on win32)

**Interfaces:**
- Produces (namespace `linuxptrace`):
  - `struct StopGuard { StopGuard(pid_t tid, std::string& err); ~StopGuard(); bool ok() const; };` attaches (`PTRACE_SEIZE` + `PTRACE_INTERRUPT`, waits for stop), detaches in the destructor on every path.
  - `bool GetRegs(pid_t tid, user_regs_struct&)`, `bool SetRegs(pid_t tid, const user_regs_struct&)`.
  - `bool PtraceDenied(const std::string& err)` and a stable error text constant `kPtraceDeniedMessage` = `"ptrace denied: run with CAP_SYS_PTRACE or set /proc/sys/kernel/yama/ptrace_scope to 0"`.
- `SuspendAll` keeps the documented non-reentrant, all-or-nothing contract from `platform.h`; `ResumeAll` detaches every held thread.

- [ ] **Step 1: Write failing tests:** `it('suspends all harness threads then resumes: harness ping answers only after resume')`; `it('GetThreadRegisters returns rip inside a mapped executable region')`; `it('SuspendAll refuses when ptrace is denied and leaves nothing stopped')` using `prctl(PR_SET_DUMPABLE,0)` on a child or a harness command that drops privileges; `it('second SuspendAll before ResumeAll refuses')`.
- [ ] **Step 2: Run** in Docker — expect FAIL.
- [ ] **Step 3: Implement** with `process_vm_*`-independent ptrace; threads enumerated from `/proc/<pid>/task`; new threads spawned between enumeration and stop are re-enumerated once before returning true.
- [ ] **Step 4: Run** — expect PASS. Docker must run with `--cap-add=SYS_PTRACE`; encode that in `build-in-docker.sh`.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): ptrace core, suspend/resume, registers"`

### Task 12: Remote syscalls, AllocateNear/FreeMemory, thread-hijack remote execution

**Files:**
- Create: `Linux/native/remote_exec.h`, `Linux/native/remote_exec.cc`
- Modify: `Linux/native/platform_linux_process.cc` (wire `AllocateNear`, `FreeMemory`, `CreateRemoteThread`, `WaitForRemoteThread`, `CloseRemoteThread`)
- Test: `tests/native/{cave_ops,mono_call,patch_ops}.test.ts`, new cases in `tests/native/linuxPtrace.test.ts`

**Interfaces:**
- Produces: `bool RemoteSyscall(pid_t tid, long nr, const uint64_t args[6], uint64_t& result);` (writes `syscall; int3` into scratch space the thread's stack red zone cannot reach: use a page found via `QueryRegion` executable mapping, restore original bytes and registers after).
- `platform::AllocateNear` = `RemoteSyscall(SYS_mmap, hint near `nearAddr`, `MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE`, RWX)` trying candidate addresses within ±2GB (step by 64KB) until one succeeds; `FreeMemory` = `munmap`.
- `platform::CreateRemoteThread(handle, start, param)`: picks one stopped thread, saves registers, sets `rip=start`, argument register per ABI (rcx for Microsoft x64 targets, rdi for System V) and a return address pointing at an `int3` in a one-page trampoline cave, aligns `rsp` so `rsp+8` is 16-aligned at entry, runs it, and treats the trap as thread exit; `WaitForRemoteThread` returns true when that trap is reached, false on timeout (thread left running only if the caller promised never to free; document). The target process never has a thread created or destroyed (addresses the crash-on-thread-churn hazard in `platform.h`).
- `Abi PlatformAbiFor(ProcessHandle, uintptr_t moduleBase)` declared in `platform.h` (add `enum class Abi { Ms64, SysV };` in Task 13).

- [ ] **Step 1: Write failing tests:** `it('AllocateNear returns an address within 2GB of the hint, RWX, and FreeMemory unmaps it')`; `it('remote call returns a value written by a trampolined function')` (harness exposes a tiny function; call it with param 7 and expect the result 7+1); `it('target keeps answering ping after 500 remote calls in 5s')` (no churn crash).
- [ ] **Step 2: Run** in Docker — expect FAIL.
- [ ] **Step 3: Implement.** Always restore registers and original bytes before detach, including on timeout paths; if the hijacked thread is inside a syscall, rewind `rip` by 2 and set `rax = -1` per the restart convention before reusing it.
- [ ] **Step 4: Run** — expect PASS; also run the Wine harness variant.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): remote syscalls, near-allocation, thread-hijack execution"`

### Task 13: ABI-aware stub generation

**Files:**
- Modify: `native/src/platform/platform.h` (add `enum class Abi { Ms64, SysV };`), `native/src/mono_call.cc`, `native/src/mono_call.h`, `native/src/mono_bridge.cc` (stub emitters at the byte-array sites), `native/src/cave_ops.cc` if it emits call stubs
- Test: `tests/native/mono_call.test.ts` (Windows unchanged golden bytes), new `tests/native/stubAbi.test.ts`

**Interfaces:**
- Produces: `std::vector<uint8_t> BuildCallStub(Abi abi, uintptr_t function, const std::vector<uint64_t>& args, uintptr_t resultSlot);` — for `Ms64`: args in rcx, rdx, r8, r9, shadow space `sub rsp,0x28`, current bytes exactly; for `SysV`: args in rdi, rsi, rdx, rcx, r8, r9, no shadow space, stack aligned to 16 before `call`. Max 6 register args; more args throw/return empty.

- [ ] **Step 1: Write failing tests** `stubAbi.test.ts` (exposes the builder through a test-only addon export): `Ms64` output for `(fn=0x1122334455667788, args=[1,2])` equals the byte sequence the current Windows code emits (capture it from the current `mono_call.cc` implementation as the golden); `SysV` output starts with `mov rdi` imm64 and contains no `sub rsp,0x28`; `SysV` 7 args returns an error.
- [ ] **Step 2: Run** `npx vitest run tests/native/stubAbi.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**, replacing the inline byte arrays; Windows callers pass `Abi::Ms64`.
- [ ] **Step 4: Rebuild, run** `npm test` on Windows and the Docker suite — expect PASS on both; Windows `mono_call.test.ts` unchanged.
- [ ] **Step 5: Commit** `git commit -m "refactor: ABI-parameterised remote call stubs"`

### Task 14: Mono and IL2CPP on Linux (Proton first, then native)

**Files:**
- Modify: `native/src/mono_bridge.cc` (module lookup by name list: `mono-2.0-bdwgc.dll` / `libmonobdwgc-2.0.so`, `GameAssembly.dll` / `GameAssembly.so`; use `PlatformAbiFor`), `Linux/native/platform_linux_memory.cc` (`PlatformAbiFor`)
- Create: `Linux/test-harness/probe_mono.c` (ELF port of `test-harness/probe_mono.c` exporting the same fake mono API)
- Test: `tests/native/mono_bridge.test.ts` under both harness modes

**Interfaces:**
- Consumes: `BuildCallStub`, `platform::ResolveExport`, `platform::CreateRemoteThread`.
- Produces: `platform::PlatformAbiFor(ProcessHandle, uintptr_t moduleBase)` returns `Abi::Ms64` when the module starts with `MZ`, `Abi::SysV` for `\x7fELF`.

- [ ] **Step 1: Write failing test:** run existing `mono_bridge.test.ts` cases against `harness-wine.exe` + the mingw `probe_mono.dll` (Proton path) and against the ELF harness + `probe_mono.so` (native path); expect the same class/method resolution results as Windows.
- [ ] **Step 2: Run** both harness modes in Docker — expect FAIL.
- [ ] **Step 3: Implement** the module-name tables and ABI selection; do not alter lookup logic otherwise.
- [ ] **Step 4: Run** — expect PASS in both modes, and `npm test` on Windows PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): Mono/IL2CPP bridges for Proton and native targets"`

---

## Stage 6 — Write-watch, snapshots, registers

### Task 15: Linux DebugSession and hardware breakpoints

**Files:**
- Create: `Linux/native/platform_linux_debug.cc`
- Test: `tests/native/write_watch.test.ts` (same cases as Windows), new `it('reports a clear error when debug registers are unavailable')` using an env hook `APPRENTICE_FORCE_NO_DEBUGREGS=1` honoured only in the Linux backend

**Interfaces:**
- Produces: `platform::DebugSession` on Linux: `Attach` = `PTRACE_SEIZE` every tid with `PTRACE_O_TRACECLONE` (new threads inherit debug registers via `Dr7` re-arm on clone events); `SetHwBreakpoint` = `PTRACE_POKEUSER` to `offsetof(struct user, u_debugreg[slot])` and `[7]`; `Wait` = `waitpid(-1, __WALL)` with timeout via `WNOHANG` polling at 5ms; SIGTRAP with `Dr6` bit set maps to `WatchEvent{slot}`; non-watch signals are re-injected with `Continue`. `SupportsHardwareWatch()` probes by arming and disarming Dr0 on one thread.
- `Detach` clears Dr7 on every thread then `PTRACE_DETACH`; destructor calls `Detach` (Review Focus 4).

- [ ] **Step 1: Write failing tests** as listed plus `it('app teardown mid-watch leaves the harness running')` (call stop, assert ping answers).
- [ ] **Step 2: Run** in Docker (requires `--cap-add=SYS_PTRACE`) — expect FAIL.
- [ ] **Step 3: Implement.** Dispatch all `waitpid` calls from the same thread that called `Attach` (ptrace tracer-thread rule).
- [ ] **Step 4: Run** — expect PASS (or SKIP-with-message when the CI runner kernel exposes no debug registers; the unavailable-registers test must still PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(linux): ptrace-based DebugSession for write watch"`

---

## Stage 7 — TypeScript and UX

### Task 16: Steam discovery, process hiding, platform messaging

**Files:**
- Modify: `src/main/steamLibrary.ts` (`realReadRegistry` stays win32; add `linuxSteamRoots(env)`), `src/renderer/src/screens/ProcessPicker.tsx` (hidden list), `src/main/ipc.ts` (error mapping for `kPtraceDeniedMessage`, unsupported platform)
- Test: `tests/main/steamLibrary.test.ts`, `tests/main/ipc.test.ts`

**Interfaces:**
- Produces: `export function linuxSteamRoots(env: NodeJS.ProcessEnv, fs: SteamFs): string[]` returning existing directories from `[$HOME/.steam/steam, $HOME/.local/share/Steam, $HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam]`, de-duplicated by realpath. `realSteamDeps()` uses it when `process.platform === 'linux'`. Library detection reuses the existing `libraryfolders.vdf` parsing.
- The picker's hidden list gains `wineserver`, `wine64-preloader`, `winedevice.exe`, `services.exe`, `explorer.exe`, `plugplay.exe`, `svchost.exe`, `rpcss.exe`, `conhost.exe`, `steam.exe`, `pressure-vessel*`.

- [ ] **Step 1: Write failing tests** in `steamLibrary.test.ts`: `it('finds ~/.local/share/Steam and a symlinked ~/.steam/steam once')`, `it('reads libraryfolders.vdf from the Linux root and lists steamapps/common games')`, and in `ipc.test.ts` `it('maps the ptrace denied error to an actionable user message')` asserting the message contains `ptrace_scope`.
- [ ] **Step 2: Run** `npx vitest run tests/main/steamLibrary.test.ts tests/main/ipc.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the signature and mappings above.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: Linux Steam discovery, Wine process hiding, ptrace error messaging"`

---

## Stage 8 — Packaging and release

### Task 17: AppImage and deb, launcher, ptrace permission handling, release job

**Files:**
- Create: `Linux/packaging/electron-builder.linux.json`, `Linux/packaging/after-install.sh`, `Linux/packaging/apprentice.desktop`
- Modify: `Linux/scripts/apprentice.sh`, `Linux/scripts/build-in-docker.sh` (adds `--package`), `.github/workflows/ci.yml` (linux job uploads `Linux/dist/*`; release job attaches them), `Linux/README.md`

**Interfaces:**
- Produces: `electron-builder --linux --config Linux/packaging/electron-builder.linux.json` writing to `Linux/dist/` with artifact names `Apprentice-${version}.AppImage` and `Apprentice-${version}.deb`; the deb `afterInstall` runs `setcap cap_sys_ptrace+ep` on the installed binary (`after-install.sh`), exits 0 even if `setcap` is missing. The AppImage gets no capability (it cannot carry one): `Linux/packaging/99-apprentice-ptrace.conf` is a sysctl drop-in (`kernel.yama.ptrace_scope = 0`) documented in the README as the opt-in route, and `kPtraceDeniedMessage` (Task 11) is extended to include the exact command `sudo sysctl kernel.yama.ptrace_scope=0` plus the persistent drop-in path. `ptraceHelp()` in `src/main/ipc.ts` returns whether the running binary is an AppImage (`process.env.APPIMAGE` set) so the UI message picks the right fix (sysctl for AppImage, reinstall note for packages). Packaged files list mirrors `package.json` `build.files` but with the Linux `memory_addon.node`. The README states that AppImages need `fuse2` (`libfuse2` on Ubuntu) and the extract-and-run fallback `--appimage-extract-and-run`.

- [ ] **Step 1: Write failing test:** CI step `Linux/scripts/smoke-package.sh` extracts the AppImage (`--appimage-extract`), runs it under `xvfb-run` with `--no-sandbox --smoke-test`, and expects exit code 0 and a window title. Add a `--smoke-test` flag handled in `src/main/index.ts` only if no equivalent exists (exit 0 after the main window's `ready-to-show`).
- [ ] **Step 2: Run** `Linux/scripts/build-in-docker.sh --package` — expect FAIL.
- [ ] **Step 3: Implement** config, scripts, README (Yama setup, setcap, Proton notes, troubleshooting).
- [ ] **Step 4: Run** the same command, then `Linux/scripts/smoke-package.sh` — expect AppImage and deb in `Linux/dist/`, smoke exit 0.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): AppImage/deb packaging, launcher, CI artifacts"`

---

### Task 18: Arch Linux / CachyOS package

**Files:**
- Create: `Linux/packaging/arch/PKGBUILD`, `Linux/packaging/arch/apprentice.install`, `Linux/scripts/package-arch.sh`
- Modify: `.github/workflows/ci.yml` (linux job also builds the tarball), `Linux/README.md` (Arch/CachyOS section)
- Test: `Linux/scripts/smoke-arch.sh` (runs in an `archlinux:latest` container)

**Interfaces:**
- Produces: `Apprentice-${version}-linux-x64.tar.gz` in `Linux/dist/` (the unpacked electron-builder `linux-unpacked` directory); `PKGBUILD` with `depends=('gtk3' 'nss' 'alsa-lib' 'libxss' 'libxtst')` and `optdepends=('steam: library discovery')`, installing to `/opt/apprentice` with `/usr/bin/apprentice` symlink and a `.desktop` file; `apprentice.install` `post_install()`/`post_upgrade()` run `setcap cap_sys_ptrace+ep /opt/apprentice/apprentice` (never fails the install).

- [ ] **Step 1: Write failing test:** `smoke-arch.sh` builds the package in `archlinux:latest` (`makepkg` as a non-root user), installs it with `pacman -U`, asserts `getcap /opt/apprentice/apprentice` shows `cap_sys_ptrace`, and that `apprentice --smoke-test` under `xvfb-run` exits 0.
- [ ] **Step 2: Run** `Linux/scripts/smoke-arch.sh` — expect FAIL.
- [ ] **Step 3: Implement** the tarball script, `PKGBUILD` (source is the tarball from Task 17's output), install hook, README section (notes `fuse2` for AppImage users, CachyOS Steam path `~/.local/share/Steam`, Proton-CachyOS works unchanged).
- [ ] **Step 4: Run** `Linux/scripts/smoke-arch.sh` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(linux): Arch/CachyOS tarball and PKGBUILD"`

---

## Self-review

- **Spec coverage:** layout (Task 6), Windows abstraction first (1-5), Linux backend table rows: process list/name (7), regions/modules/read/exports (8), write (10), allocate/protect/remote exec (12), thread list/regs/suspend (11), hardware watch (15); per-target ABI (13, 14); permissions/Yama (11, 16, 17); TS changes (16); build/CI/tests incl. wine+mingw (6, 9, 17); staging mirrors spec stages 1-8. Non-goals respected (no profile content, no Flatpak, MCP server untouched).
- **Type consistency:** `ProcessHandle`/`Abi`/`DebugSession`/`WatchEvent` names are defined once (Tasks 1, 4, 13) and reused unchanged; `PlatformAbiFor` is declared in Task 12 and defined in Task 14.
- **Proportion/granularity:** signatures and test assertions only; bodies left to the implementer except the stub ABI contract and trampoline rules, which the tests do not determine.
- **Known unknowns for the implementer:** the exact exports in the Windows `test-harness/harness.c` command protocol (Task 6 reads it); whether the CI kernel exposes debug registers (Task 15 handles both).

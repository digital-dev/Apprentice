# Live Registers Panel — Design

## Problem

Memory Viewer shows raw bytes and disassembly, but nothing about the live
CPU state of the target process. Looking at a `cmp` or `mov` instruction
touching `rax`/`rcx`/etc. gives no way to see what that register actually
holds right now. Users want a live view of register values while stepping
through disassembly (e.g. to correlate a `cmp` against a health value with
the actual comparand in a register).

## Scope

- New "Registers" panel in Memory Viewer: thread picker + live grid of
  general-purpose registers, polled at the same 250ms cadence as the rest
  of the viewer.
- Windows-only, matching the rest of the native addon (breakpoints,
  suspend-all, etc. are all win32-only already; `platform_linux.cc` is a
  44-line stub).
- Not in scope: inline per-instruction register annotations in the
  disassembly rows (e.g. "cmp eax, 0x64 ; eax=100"). Panel-only for now.

## Native addon

New file `native/src/thread_ops.cc`, following the existing pattern in
`write_watch.cc` (`SetHwBreakpointOnThread`, `SetHwBreakpointAllThreads`)
and `platform_win32.cc` (`SuspendAll`'s Toolhelp32 thread enumeration).

### `listThreads(pid: number): { tid: number }[]`

`CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD)`, walk with
`Thread32First`/`Thread32Next`, filter `th32OwnerProcessID == pid`, collect
`th32ThreadID`. Same loop shape as `SuspendAll` in `platform_win32.cc`.

### `getThreadRegisters(tid: number): Record<string, string> | null`

`OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME, FALSE, tid)` →
`SuspendThread` → `CONTEXT ctx{}; ctx.ContextFlags = CONTEXT_INTEGER |
CONTEXT_CONTROL; GetThreadContext(th, &ctx)` → `ResumeThread` →
`CloseHandle`. Returns `null` if `OpenThread`/`GetThreadContext` fails
(thread exited between listing and reading — same "point-in-time
snapshot" race `SuspendAll` already documents).

Fields returned as `0x`-prefixed hex strings (matches how addresses are
passed everywhere else in this codebase): `rax, rbx, rcx, rdx, rsi, rdi,
rbp, rsp, rip, r8, r9, r10, r11, r12, r13, r14, r15, rflags`.

Brief single-thread suspend per read (~microseconds), not a whole-process
suspend — same cost class as the existing hardware-breakpoint set/clear
path, done every poll tick.

### `addon.cc`

Register both functions as addon exports, same shape as `attach`/
`suspendThreads`.

## Main process (`nativeAddon.ts`, `ipc.ts`)

- `nativeAddon.ts`: typed wrappers `listThreads(pid)`,
  `getThreadRegisters(tid)`.
- `ipc.ts`: two new IPC handlers, `threads:list` and
  `threads:registers`, both guarded on `attachedPid`/`attachedHandle`
  being set (return `[]`/`null` otherwise — mirrors every other handler
  in this file).
- Preload/`tamper.d.ts`: `listThreads(): Promise<{tid:number}[]>`,
  `getThreadRegisters(tid: number): Promise<Record<string,string> | null>`.

## Renderer (`MemoryViewer.tsx`)

New panel, same visual slot/pattern as the existing Structure Dissect
panel (own `<h3>`, own toolbar, shown once `baseAddress` is set) —
independent of `viewMode` (hex vs disasm) and of the scrolling window
(`windowStart`), since registers aren't tied to any address range.

- **Thread select**: populated from `listThreads()`, refreshed every 2s
  (own `setInterval`, not the 250ms register poll — thread lists churn
  constantly in a live game, no need to re-render the dropdown that
  often). If the currently-selected tid drops out of a refreshed list,
  clear the selection rather than silently pointing at a stale/reused
  tid. First populate selects the first thread in the list.
- **Register grid**: while a tid is selected, poll
  `getThreadRegisters(tid)` every 250ms (own `setInterval`, mirrors the
  existing hex/disasm poll and the Structure Dissect poll — three
  independent polling loops already coexist in this file). Render
  rax..r15, rip, rsp, rbp, rflags as monospace hex. A `null` result
  (thread exited) shows "thread exited" and clears the selection so the
  thread-list refresh can pick a live one.
- No interaction with `editingRef`/`editingOffset` — this is a pure read
  path, unrelated to the hex-byte edit-in-progress guard.

## Testing

- Native: manual verification against a running process (existing addon
  has no unit test harness for win32-only syscall wrappers — same as
  `SuspendAll`/breakpoint code, which are also untested at that layer).
- Renderer: vitest coverage for the polling/selection logic in
  `MemoryViewer.tsx` — thread list refresh replacing a dead tid, register
  poll rendering values, panel hidden with no `baseAddress`.

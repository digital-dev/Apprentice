# Find What Writes an Address (#5) — Design

## Purpose

Add Cheat-Engine-style "find what writes this address" to Tamper. Given a
target address the user found by scanning, catch the game's own code that
writes to it, decode that instruction, and turn it into a high-quality,
restart-resilient cheat.

This is the single biggest robustness upgrade available: the instruction
that writes a value tells us the *object base pointer* and *field offset*
the game itself uses, which produces a far more rooted pointer chain than
blindly scanning memory for pointer-shaped values. It is also the
prerequisite that makes AOB code-patching cheats (#6, a separate later
spec) authorable without hand-reverse-engineering the game.

## Scope

**In scope (#5):**
- A debugger-based capture that catches writes to an address via a hardware
  breakpoint.
- Decoding each writing instruction (via the vendored Zydis disassembler)
  to extract instruction length, base register, displacement, and the
  runtime base address.
- Generating a wildcarded AOB signature for each instruction (produced and
  displayed now; *used* by #6 later).
- A "Create pointer cheat from this" action that resolves a pointer chain
  to the captured object base and appends the field displacement, saving it
  through the existing multi-target cheat model.

**Out of scope (deferred to #6):**
- Applying AOB patches (NOP-ing the instruction, restoring on disable). #5
  produces and shows the signature but does not patch.

## Global constraints

- Windows only.
- No network calls anywhere in the stack.
- **Safety (non-negotiable):** the debugger must never take the game down
  with it. `DebugSetProcessKillOnExit(FALSE)` is called immediately after
  attaching; the debugger is attached only for the duration of a capture
  and detached on stop, on error, and on any unwind path; every debug event
  receives a matching `ContinueDebugEvent`.
- One capture session at a time (a process-global singleton in the native
  addon).

## Architecture

### Capture mechanism (native)

Catching a hardware breakpoint's `#DB` exception requires being the target
process's debugger. A capture therefore:

1. `DebugActiveProcess(pid)`, then immediately
   `DebugSetProcessKillOnExit(FALSE)`.
2. Spawn a dedicated **debug-event-loop thread** (`std::thread`). All
   `WaitForDebugEvent` / `ContinueDebugEvent` calls happen on this one
   thread — the OS requires the debugger to be single-threaded per target.
3. Arm a **hardware write breakpoint** on the target address: for every
   thread of the target (enumerated via `Thread32First/Next`), open the
   thread, `GetThreadContext` with `CONTEXT_DEBUG_REGISTERS`, set `Dr0` =
   target address and `Dr7` for a local+global enabled write breakpoint of
   length 4, then `SetThreadContext`. Threads created mid-capture are armed
   when their `CREATE_THREAD_DEBUG_EVENT` arrives.
4. Loop: `WaitForDebugEvent` (with a short timeout so the loop can observe a
   stop request), handle events, `ContinueDebugEvent`.

On each `EXCEPTION_SINGLE_STEP` whose address matches our breakpoint:
- Read `RIP` and the general-purpose + relevant registers from the faulting
  thread's context.
- `ReadProcessMemory` ~20 bytes at `RIP`.
- Zydis-decode the instruction → length, the memory-operand base register,
  and displacement.
- Compute `baseAddress` = the runtime value of the base register from the
  thread context (for a RIP-relative global, base is derived from RIP + the
  instruction length + displacement instead).
- Record `{instructionAddress, bytes, length, signature, baseRegister,
  displacement, baseAddress, moduleName, moduleOffset}`, **deduplicated by
  instruction address** (a tight write loop hits the same instruction
  repeatedly and must produce one entry, not thousands).

On stop: set a stop flag the loop observes, clear `Dr0`/`Dr7` on every
thread, `DebugActiveProcessStop(pid)`, join the thread.

### AOB signature generation

For each caught instruction, produce a byte pattern string with `??`
wildcards over the bytes most likely to change between game builds/loads —
specifically any RIP-relative displacement field Zydis reports. Opcode and
ModRM/register bytes stay literal. This signature is stored/displayed for
#6; #5 does not consume it.

### Zydis integration

Vendor Zydis as its amalgamated `Zydis.c` + `Zydis.h` (generated with
Zydis's `ZydisC` amalgamation) under `native/third_party/zydis/`. Add
`Zydis.c` to `binding.gyp` sources and the include dir to `include_dirs`.
It compiles as part of the addon — no external build system.

### Native API surface

```
startWriteWatch(pid: number, address: string): void
  // Attaches the debugger, arms the breakpoint, starts the loop thread.
  // Throws if a session is already active or attach fails.

pollWriteWatch(): CaughtInstruction[]
  // Snapshot of distinct instructions caught so far. Safe to call
  // repeatedly while a capture is running.

stopWriteWatch(): CaughtInstruction[]
  // Signals the loop to exit, clears breakpoints, detaches, returns the
  // final list. Idempotent-safe: calling with no active session returns [].
```

```ts
interface CaughtInstruction {
  instructionAddress: string // hex
  bytes: string              // hex, the instruction's bytes
  length: number
  signature: string          // AOB with ?? wildcards
  baseRegister: string       // e.g. "rax", or "rip" for RIP-relative
  displacement: string       // signed hex field offset
  baseAddress: string        // hex, runtime value of base reg = object base
  moduleName: string | null  // module containing the instruction
  moduleOffset: string | null // instructionAddress - module base, hex
}
```

### Main process / IPC

- Store `attachedPid` at attach time (needed for `DebugActiveProcess`;
  currently only the handle and base are stored).
- Handlers: `writeWatch:start` (address), `writeWatch:poll`,
  `writeWatch:stop`. These are stateful and delegate to the native
  singleton.
- The freeze loop is paused for the duration of a capture (defensive; our
  `WriteProcessMemory` writes do not trip the target's hardware breakpoints,
  but pausing avoids any confusion in the caught list).

### UI flow (extends the Scanner)

After the user narrows to a candidate address, each candidate offers **"Find
what writes this"**. Selecting it opens a capture panel:

1. **Arm** — calls `writeWatch:start` on that address; status shows
   *"Watching — trigger the change in-game (take damage, use stamina…)."*
2. While armed, the renderer polls `writeWatch:poll` ~4×/sec and renders a
   live, growing list of caught instructions, each showing its decoded base
   register, displacement, and module+offset.
3. **Stop** — calls `writeWatch:stop`, freezes the final list.
4. Per caught instruction:
   - **Create pointer cheat from this** — resolves a pointer chain to
     `baseAddress` (reusing `resolvePointerChain`), appends `displacement`
     as the final field offset, and saves it as a target via the existing
     multi-target `CheatDefinition` model. This is #5's payoff: a rooted
     chain the game itself validated.
   - **Create patch** — shown but disabled/"coming soon" (that's #6).

### Data flow summary

```
scan → narrow to target address
  → Find what writes this (arm HW breakpoint via debugger)
  → user triggers change in-game → instructions caught + decoded
  → pick one → resolve chain to its baseAddress + displacement
  → saved as a cheat target (existing freeze/revalidation machinery)
```

## Error handling

- `DebugActiveProcess` fails (already debugged, access denied, process
  gone) → surface a clear error, do not leave any partial debugger state.
- A thread can't be opened / `SetThreadContext` fails for some threads →
  arm the ones that succeed, continue (a game has many threads; missing a
  few rarely matters), but if *zero* threads could be armed, fail the
  capture with an error.
- Zydis fails to decode the bytes at RIP (unexpected/garbage) → record the
  instruction with raw bytes but null base/displacement rather than
  crashing; it just won't offer "create pointer cheat."
- Stop is always safe to call and always fully detaches, even if the loop
  already exited due to the target closing.
- If the target process exits during capture (`EXIT_PROCESS_DEBUG_EVENT`),
  the loop ends cleanly and the session is torn down.

## Testing

- **Harness:** add a `watchloop` command that spawns a thread repeatedly
  (throttled, e.g. `Sleep(10)`) writing a changing value through a
  pointer to `g_player.stamina`, producing a real `mov [reg+disp], val`
  object-write instruction (base = a GPR holding the object pointer, disp =
  16). The write must go through a pointer whose value is not known at
  compile time — otherwise MSVC may emit a RIP-relative direct store to the
  field address (base = RIP, disp = 0-relative), which is a valid but
  different case that wouldn't exercise the object-base extraction the real
  game path depends on. Force the indirect form with a `volatile`
  pointer (or by passing the pointer through an out-of-line, non-inlined
  helper). A `stoploop` command ends it.
- **Native tests:** arm `startWriteWatch` on `&g_player.stamina`, send
  `watchloop`, poll until ≥1 instruction is caught, then assert the decode:
  `baseAddress == &g_player`, `displacement == 16` (offset of `stamina`),
  `baseAddress + displacement == target`, and that the list is deduped to a
  single entry despite thousands of writes. `stopWriteWatch` returns the
  final list; the harness must still respond to a `get`-style command
  afterward, proving a clean detach that didn't kill or freeze it.
- Debugging is inherently stateful and OS-level; these tests run against the
  real harness process (consistent with every other native test), not mocks.

## Sub-project sequencing

This spec is **#5 only**. #6 (AOB patch-apply engine — scan by signature on
enable, patch/NOP, restore on disable, re-scan on restart) is a separate
spec that builds on #5's signature output. #5 is independently valuable: it
produces rooted pointer cheats even with #6 never built.

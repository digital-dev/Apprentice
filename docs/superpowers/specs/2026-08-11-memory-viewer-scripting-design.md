# Memory viewer and Lua scripting

## Problem

Apprentice can locate and freeze/patch individual values, but it has no way
to look at raw memory around an address, and no way to author cheat logic
more complex than "write this constant" or "nop/force this instruction."
Cheat Engine covers both gaps with its memory-view window and its embedded
Lua scripting. Apprentice has neither.

## Goal

Two related additions:

1. A live memory viewer with a structure-dissect panel, for looking at
   memory directly instead of only through scan results.
2. A Lua-scripted cheat kind, for cheat logic that reading/writing a single
   value can't express.

These are separable subsystems sharing one native dependency (the ability
to read a raw memory block) and one entry point (both are reachable from
existing scan/cheat-list rows), so they're specced together but expected to
become two implementation plans.

## Design

### Memory Viewer

New `src/renderer/src/screens/MemoryViewer.tsx`:

- Address-jump input (hex), Prev/Next page buttons (page = 256 bytes,
  matching a comfortable 16-bytes-per-row × 16-rows grid).
- Live hex+ASCII grid, refetched every 250ms while the screen is open (same
  interval `Scanner.tsx`'s write-watch poll already uses).
- Click a byte to inline-edit its hex value; Enter commits the write,
  Escape cancels — same inline-edit interaction rename/hotkey-capture
  already use elsewhere in this app.
- Entry points: a "View in Memory" action on Scanner candidate rows (once
  resolved to an address) and on CheatList target rows, navigating to
  `MemoryViewer` pre-jumped to that address.

Structure Dissect panel, alongside the hex grid, not a separate screen:

- Rows of `{ offset: string (hex, relative to the viewed base address),
  dataType: DataType, label: string }`, added/removed by the user.
- Each row decodes live from the same fetched block — no separate native
  call — using `value_type.h`'s existing `InterpretAsDouble`/`SpecForDataType`
  logic (already shared between `scanner.cc` and `memory_ops.cc`).
- Session-only: dissect rows reset when the screen unmounts. Not persisted
  to the profile. This is a diagnostic tool, not a saved artifact — if a
  dissected field turns out useful, the existing Scanner/cheat-creation flow
  is how it becomes a real cheat.

Native addition — `memory_ops.cc` gains one export:

```cpp
// Reads `length` bytes starting at `address` from the attached process.
// Thin wrapper around ReadProcessMemory; no new file needed, this sits
// alongside the existing single-value read/write exports in memory_ops.cc.
Napi::Value ReadMemoryBlock(const Napi::CallbackInfo& info);
```

Bounds: `length` is capped (e.g. 4096 bytes per call) — the viewer only
ever requests one page at a time, so this is a safety cap against a
malformed call, not a real constraint on the UI.

IPC (`ipc.ts`): `memory:readBlock(address, length)`, `memory:writeByte(address, value)`
(the latter reuses the existing single-byte write path already used by
`writeCheat`).

### Lua Scripting

#### Data model (`store.ts`)

A cheat's existing `kind` field (today implicit-'value' vs `'patch'`) gains
a third value:

```ts
export interface ScriptCheat {
  kind: 'script'
  id: string
  name: string
  enableScript: string
  disableScript: string
  hotkey?: string
}
```

`CheatDefinition | PatchCheat | ScriptCheat` becomes the stored-cheat union
everywhere `StoredCheat` is used today (`profile.ts`, `ipc.ts`,
`hotkeys.ts`). No `mode`/`dataType`/`targets` — a script cheat's only state
is "which script last ran," tracked the same way freeze state is tracked
today (a `Set<cheatId>` of currently-enabled script cheats, alongside
`FreezeLoop`'s existing `active` set — new small `ScriptRuntime` class
mirroring `FreezeLoop`'s shape: `enable(cheat)` runs `enableScript` and adds
to the set, `disable(cheatId)` runs `disableScript` and removes, `isEnabled`
mirrors `FreezeLoop.isEnabled`).

Toggling a script cheat in `CheatList.tsx` calls enable/disable exactly
like a freeze cheat's checkbox does today, and hotkey firing
(`hotkeys.ts`'s per-cheat-kind switch) gains a third branch calling the
same `ScriptRuntime` methods `HotkeyDeps` already exposes `isEnabled`-style
hooks for freeze/patch — `ScriptRuntime`'s methods are added to
`HotkeyDeps` the same way `FreezeLoop`'s were.

#### Native Lua binding

Lua 5.4's amalgamated C source is vendored into `native/src/lua/` (the
handful of `.c`/`.h` files Lua's own build recommends for embedding — no
external package manager dependency, consistent with this project's
existing from-source native code).

New `native/src/script_ops.cc` exposes one export:

```cpp
// Runs `source` (a full Lua chunk) against the attached process, in the
// role given by `phase` ("enable" or "disable") purely for error-message
// context — the binding surface is identical either way.
// Returns { success: bool, output: string[], error: string | null }.
Napi::Value RunScript(const Napi::CallbackInfo& info);
```

Bound Lua globals, each a thin wrapper over the same process handle
`memory_ops.cc`'s existing single-value read/write already uses:

- `readInt8/16/32/64(address) -> number`, `readFloat/readDouble(address) -> number`
- `writeInt8/16/32/64(address, value)`, `writeFloat/writeDouble(address, value)`
- `readBytes(address, length) -> string`, `writeBytes(address, string)`
- `resolveChain(moduleName, offsets) -> address string | nil` — wraps the
  existing `pointer.cc` chain-resolution walk (module base + offsets, same
  semantics `ChainTarget` already has), letting a script locate a dynamic
  address itself instead of only ever being handed one.
- `print(...)` — appends a formatted line to the run's `output` array
  (returned once the script finishes; not streamed live in v1).

Execution safety: a Lua debug hook (`lua_sethook` with `LUA_MASKCOUNT`)
checks elapsed wall-clock time every N instructions and raises a Lua error
past a fixed cap (5 seconds) — a script that infinite-loops errors out
instead of hanging the native thread (and, transitively, the whole app,
since N-API async work still funnels through libuv's thread pool). Runs on
a background thread via `Napi::AsyncWorker`, the same pattern
`scanFirst`/`resolveChain` already use to keep the main/JS thread responsive
during slow native calls.

No sandboxing beyond the timeout: a trainer already grants full read/write
of the target process through every other feature (patches, freeze cheats,
find-what-writes) — a script is no more privileged than a hand-authored
patch. This is local, single-player, offline tooling; the trust boundary is
"the user trusts scripts they themselves wrote or pasted," same as it
already is for everything else in this app.

#### Renderer UI

New `ScriptEditor` panel (reachable from CheatList, mirroring how the
existing patch-capture flow opens its own panel):

- Two textareas: Enable script, Disable script.
- Save persists a `ScriptCheat` via the existing `saveCheat` IPC path
  (`cheats:save` already validates hotkey conflicts generically across all
  stored-cheat kinds; no change needed there beyond the widened type).
- "Run enable now" / "Run disable now" test buttons call `scripts:run`
  directly against the textarea contents (not yet saved), for iterating on
  a script before committing it.
- Output console below the textareas shows the returned `output` lines, or
  the error message on failure — same visual treatment (a dismissible
  banner) the app already uses for patch/hotkey errors.

IPC: `scripts:run(source: string, phase: 'enable' | 'disable') -> { success, output, error }`,
used both by the test buttons and by `ScriptRuntime`'s enable/disable calls.

## Out of scope

- No CT Lua-script import — Cheat Engine's Lua Cheat Table entries are a
  different XML shape than the Auto Assembler entries `ctImport.ts` already
  parses; teaching CT import to recognize embedded Lua tables is a separate
  project.
- No live-streaming `print()` output while a script runs — output appears
  once the script (or its timeout) finishes.
- No Lua standard library beyond what Lua 5.4 ships with by default (string,
  table, math, os.time via os library minus shell-out functions — `os.execute`
  and `io.*` are removed from the bound environment; a trainer's script
  should not need filesystem/process access beyond the game it's attached
  to).
- Memory Viewer's structure-dissect rows are not persisted or exportable —
  purely a scratch working area.
- No disassembler view — the memory viewer is hex+ASCII only.

## Testing

- `value_type.h`'s decode logic is already covered by `scanner.cc`/
  `memory_ops.cc`'s existing tests — the dissect panel's decoding reuses it
  without new native test surface.
- `ReadMemoryBlock`'s bounds cap gets a native test alongside the existing
  `memory_ops` tests (request over the cap → truncated/rejected, per
  whatever `scanner.cc`'s existing over-cap convention is).
- `ScriptRuntime` (`enable`/`disable`/`isEnabled`) is tested the same way
  `FreezeLoop` already is — a fake `RunScript` dependency, no real Lua or
  Electron involved.
- `script_ops.cc`'s Lua binding correctness (each bound global reads/writes
  the right width, the timeout actually fires) is verified against
  `test-harness/harness.exe`, the same manual-plus-scripted verification
  approach the numeric-data-types feature used for its native changes — a
  real Lua interpreter and real process memory aren't practical to unit
  test in the DI-fake style everything else uses.
- No renderer test harness exists for `CheatList.tsx`/new screens today
  (consistent with the rest of this app) — `MemoryViewer` and
  `ScriptEditor`'s UI is verified manually.

# Memory viewer and Lua scripting

## Problem

Apprentice can locate and freeze/patch individual values, but it has no way
to look at raw memory around an address, and no way to author one-shot
cheat logic more complex than "write this constant" or "nop/force this
instruction" — e.g. "double whatever health is right now" needs to read
before it writes. Cheat Engine covers both gaps with its memory-view window
and its embedded Lua scripting. Apprentice has neither.

## Goal

Two related additions:

1. A live memory viewer with a structure-dissect panel, for looking at
   memory directly instead of only through scan results.
2. A Lua-scripted cheat kind for one-shot enable/disable logic that a
   single value write can't express. **Not** a replacement for continuous
   logic — freeze cheats and patches keep owning anything that has to keep
   running every tick; a script cheat runs once per toggle, same as a
   one-shot value cheat does today.

These are separable subsystems sharing one native primitive (reading a raw
memory block) and one entry point (both reachable from existing
scan/cheat-list rows), so they're specced together but expected to become
two implementation plans — the Lua half is roughly 4x the work of the
viewer half and depends on nothing the viewer half produces.

## Design

### Memory Viewer

New `src/renderer/src/screens/MemoryViewer.tsx`:

- Address-jump input (hex), Prev/Next page buttons (page = 256 bytes,
  16 bytes/row × 16 rows).
- Live hex+ASCII grid, refetched every 250ms while the screen is open (same
  interval `Scanner.tsx`'s write-watch poll already uses). **The poll
  pauses while a byte is mid-edit** (an open inline editor suppresses that
  cell's refresh, or the whole poll — either way an in-progress edit is
  never overwritten by the next tick).
- Click a byte to inline-edit its hex value; Enter commits the write,
  Escape cancels — same interaction rename/hotkey-capture already use.
- Entry points: a "View in Memory" action on Scanner candidate rows (once
  resolved to an address) and on CheatList target rows, navigating to
  `MemoryViewer` pre-jumped to that address.

Structure Dissect panel, alongside the hex grid, not a separate screen:

- Rows of `{ offset: string (hex, relative to the viewed base address),
  dataType: DataType, label: string }`, added/removed by the user.
- Each row decodes **in the renderer**, from the same fetched block, via a
  new pure module `src/renderer/src/dissect.ts` using `DataView`:
  `getUint8` (int8 — unsigned, matching `value_type.h`'s int8 convention),
  `getInt16`, `getInt32`, `getBigInt64` (int64 — kept as `BigInt`, not
  widened to `number`, since a hex viewer showing a raw 64-bit value should
  not lose precision the way `value_type.h`'s `InterpretAsDouble` deliberately
  does for scan comparisons), `getFloat32`, `getFloat64`, all little-endian.
  This is intentionally a **second, independent implementation** of the
  same width/interpretation rules `value_type.h` encodes in C++ — a renderer
  module cannot call into the native addon's inline functions — so it gets
  its own test (`tests/renderer/dissect.test.ts`) covering every width
  including the unsigned-int8 case, to catch drift between the two.

Native addition: **reuse and extend `patch_ops.cc`'s existing `ReadBytes`
export** (`native/src/patch_ops.cc:179`, already registered in `addon.cc`,
already wrapped as `nativeAddon.readBytes`) rather than adding a parallel
`ReadMemoryBlock`. Today it's capped at 64 bytes and returns a hex string;
raise the cap to 4096 and add a `raw?: boolean` parameter so the viewer can
request a `Napi::Buffer<uint8_t>` instead of a hex string (a 256-byte page
decoded 6 different ways in the dissect panel wants a `Buffer`/`DataView`,
not a hex string it has to re-parse). Keep the existing throw-on-failure
behavior (matches `patch_ops.cc`'s convention), and add a
**non-throwing `tryReadBytes`-style wrapper** at the `nativeAddon.ts` layer
(mirroring the existing `tryReadValue`/`tryReadBytes` split there) so a
250ms poll landing on partially- or fully-unmapped memory returns `null`
for the failing page instead of rejecting the IPC call. The viewer renders
an all-`??` row for a page that fails outright; a straddling region (readable
start, unmapped tail) is out of scope for v1 — show the whole page as
unreadable rather than guessing a partial boundary.

IPC (`ipc.ts`): `memory:readBlock(address, length)` (wraps the extended
`readBytes`, throws `'not attached'` when nothing is attached, matching the
convention `cheats:oneShot` already uses) and `memory:writeByte(address,
value)`, which reuses the existing single-value write path
(`nativeAddon.writeValue(handle, address, [], 'int8', value)` — the same
call `writeCheat` makes for an int8 target; `int8` is Apprentice's unsigned
1-byte width, exactly what a hex editor's 0-255 byte field wants).

### Lua Scripting

#### Data model (`store.ts`)

A new stored-cheat kind:

```ts
export interface ScriptCheat {
  kind: 'script'
  id: string
  name: string
  enableScript: string
  disableScript: string
  hotkey?: string
}

export function isScriptCheat(cheat: StoredCheat): cheat is ScriptCheat {
  return (cheat as ScriptCheat).kind === 'script'
}
```

`StoredCheat` (wherever it's defined as `CheatDefinition | PatchCheat`)
becomes `CheatDefinition | PatchCheat | ScriptCheat`. This touches more
than the three files the original draft of this spec named — every one of
these needs an explicit `isScriptCheat`/`isPatchCheat` branch rather than
an implicit "not a patch means value" assumption, because several existing
checks assume exactly two kinds:

- `ipc.ts`'s `cheats:save` hotkey-conflict-with-anchor-target check
  (`cheat.hotkey && !isPatchCheat(cheat) && cheat.targets.some(...)`) —
  `!isPatchCheat` today wrongly includes `ScriptCheat`, which has no
  `targets`. Add the `isScriptCheat` guard.
- `ipc.ts`'s CT-export split (`allCheats.filter((c) => !isPatchCheat(c))` as
  "value cheats") — needs a third bucket; a `ScriptCheat` has no CT
  equivalent at all (see Out of scope) and should be reported skipped, not
  silently mis-bucketed into the value-cheat export path.
- `hotkeys.ts`'s `fire()` dispatch (`isPatchCheat(cheat) ? firePatch :
  fireValueCheat`) — gains a third branch for `isScriptCheat`, described
  below.
- `CheatList.tsx`'s own local `isPatch` type guard (kept local deliberately,
  per its existing comment, rather than importing `main`'s) needs a sibling
  `isScript`.
- `profile.ts`'s `migrateByteDataType` (iterates cheats touching
  `dataType`) needs to skip script cheats, which have no `dataType`.
- `preload/index.ts` and `tamper.d.ts` — every new IPC channel
  (`memory:readBlock`, `memory:writeByte`, `scripts:run`) needs an entry in
  both, per this app's existing convention for every other channel.

#### Enable/disable state handoff

A disable script frequently needs a value the enable script computed (e.g.
"restore original health" needs the health that was overwritten). `RunScript`
therefore takes and returns a small persistent key-value table, bound in Lua
as a global `state`:

- Backed by a `Map<cheatId, Record<string, LuaValue>>` held in-memory by the
  new `ScriptRuntime` (main process only — never persisted to the profile,
  never survives an app restart).
- `enableScript` writing `state.original = readInt32(addr)` makes
  `state.original` available when `disableScript` next runs for the same
  cheat.
- Cleared for a cheat whenever it's removed from the enabled set (see
  Lifecycle, below).

#### `ScriptRuntime` (new `src/main/scriptRuntime.ts`)

Structurally mirrors `FreezeLoop`'s shape (an `active`-style set,
`isEnabled`), but — unlike `FreezeLoop.enable`/`disable`, which are
synchronous and cannot fail — `ScriptRuntime.enable`/`disable` are async and
can fail (a Lua runtime error, a timeout):

```ts
interface ScriptRuntime {
  enable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
  disable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
  isEnabled(cheatId: string): boolean
}
```

- On success, the cheat id is added to (enable) or removed from (disable)
  the enabled set; on failure, the set is left unchanged and the error is
  returned to the caller — never optimistically updated.
- A per-cheat in-flight guard (a `Set<cheatId>` of currently-running
  toggles) makes a second toggle while one is still running a no-op rather
  than launching a second overlapping Lua run against the same `state`
  entry.
- `hotkeys.ts`'s new script branch is modeled on `fireValueCheat`'s
  **one-shot** path (already async, already produces `HotkeyOutcome`
  `'error'` on failure/rejection) rather than its freeze path, which is
  sync/infallible and the wrong model here. A failed enable/disable fires
  `hotkey:fired` with `outcome: 'error'`, same as a failed one-shot does
  today.
- The `ScriptEditor`'s own "Run enable/disable now" buttons surface errors
  through the same dismissible-banner treatment already used for
  patch/hotkey errors — not a separate error UI.

#### Lifecycle

Unlike patches (which `releaseTarget`/`attachTo`/`watcher.onVanish` always
restore before switching or quitting) a script cheat has no native "undo"
Apprentice can perform on its behalf — only `disableScript` knows how, and
running it requires an attached, live process.

- `watcher.onVanish` and `attachTo`'s process-switch branch **clear the
  enabled set and each cheat's `state` table** without running
  `disableScript` — the process handle is already dead, so running it would
  fail anyway. The UI's enabled/disabled indicator resets to disabled on
  reattach.
- `releaseTarget` (app quit) does the same — clears state, does not attempt
  to run `disableScript` (the quit path doesn't await async work). Any
  memory the enable script wrote stays written; this residue is the same
  category of risk a freeze cheat or an armed patch already carries at
  quit today (neither is guaranteed clean either), and is called out
  explicitly here rather than solved.
- The enabled set is never persisted to the profile — every script cheat
  loads as disabled.

#### Native Lua binding

Lua 5.4's full source (lua.org's release tarball — roughly 34 `.c`/`.h`
files; there is no official single-file amalgamation in the release
tarball) is vendored into `native/third_party/lua/` (matching this
project's existing vendoring convention, e.g. Zydis at
`native/third_party/zydis/` — not under `src/`, correcting this spec's
earlier draft). `lua.c` and `luac.c` (each define `main()`) are excluded
from `binding.gyp`'s `sources`.

**Compiled as C++, not C**, via a per-file `binding.gyp` override
(`cflags`/`msvs_settings` scoped to the Lua source list, not the
target-wide settings that apply `/std:c++17` to everything). This is a
deliberate choice, not an oversight: Lua's error path
(`lua_error`/`luaL_error`, including this feature's own execution-timeout
hook) uses `longjmp` by default, which unwinds past any C++ destructor on
the stack — a `std::vector<uint8_t>`/`std::string` local inside one of
`script_ops.cc`'s bound functions would leak or worse. Compiling Lua as C++
and defining `LUAI_THROW`/`LUAI_TRY`/`LUAI_JMPBUF` (per `luaconf.h`'s own
documented hook for this) to use C++ `try`/`catch` instead makes
`lua_error` an ordinary C++ exception that unwinds destructors correctly,
removing the need to constrain every binding to trivially-destructible
locals. If `binding.gyp`'s existing `OS=='linux'` branch is kept in sync,
Lua's Linux build additionally needs `LUA_USE_LINUX` and links `-ldl -lm`
— Apprentice itself stays Windows-only; this is purely about not leaving
the existing cross-OS `binding.gyp` scaffolding inconsistent.

New `native/src/script_ops.cc` exposes one export:

```cpp
// Runs `source` (a full Lua chunk) against the attached process, in the
// role given by `phase` ("enable" or "disable") purely for error-message
// context — the binding surface is identical either way. `stateIn` seeds
// the `state` global; `stateOut` is its contents after the run.
// Returns { success: bool, output: string[], error: string | null,
//           stateOut: Record<string, LuaValue> }.
Napi::Value RunScript(const Napi::CallbackInfo& info);
```

Runs on a background thread via `Napi::AsyncWorker` — the same pattern
`scanFirst`/`resolveChain`/`scanAob` already use — so a long-running script
occupies one of libuv's worker-pool threads rather than blocking the
Electron main/JS thread. (Not, as an earlier draft of this spec claimed,
because it would otherwise "hang the whole app" via the thread pool — a
spinning `AsyncWorker` only ties up one pool slot. The timeout below is
still required: the pool is shared with `fs`/`dns`/`crypto` and this app's
own other native calls, and a script left to run forever is still a bug.)

**Execution environment — explicit allowlist, not "open everything, then
remove a few names":**

```cpp
// Opens only: base library minus dofile/loadfile/load/collectgarbage,
// plus string, table, math, and a hand-built 3-function os table
// (time, clock, date). Deliberately never calls luaL_openlibs — a future
// Lua release adding a new base/os function would otherwise silently
// widen this environment. debug, io, package, and os.execute/os.exit are
// never registered at all, not merely deleted after the fact (a deleted
// global can be reintroduced by a script that recreates the table from
// a captured upvalue in some library functions; never-registered cannot).
```

This replaces the earlier draft's "no sandboxing beyond the timeout"
framing, which was wrong: `script_ops.cc`'s Lua VM runs **inside
Apprentice's own process**, not the target game's — stock Lua's
`package.loadlib`, `os.execute`, `os.exit`, and `io.*` would be arbitrary
code execution against the user's own machine, a materially different
trust boundary than "this cheat can write bytes into the attached game."
This matters concretely because script cheats are saved into profile JSON
(`games/*.json`), and this app already has a sharing/import story for
profiles (CT import/export) — an unsandboxed script is a code-execution
vector the moment a profile is shared.

Also **never opens `debug`**, specifically because `debug.sethook` would
let a script clear the execution-timeout hook below, defeating the one
safety mechanism this design otherwise relies on.

**Execution timeout:** a `lua_sethook` count hook (`LUA_MASKCOUNT`) checks
elapsed wall-clock time every N instructions and raises a Lua error past a
5-second cap, re-arming itself each check rather than assuming a one-shot
install persists correctly across the whole run. Because Lua is compiled as
C++ (above), this error unwinds as a normal C++ exception.

**Memory cap:** the Lua state is created via `lua_newstate` with a custom
allocator enforcing a fixed byte budget (a few MB — generous for a trainer
script, far below what would pressure the main process). Past the cap the
allocator returns `NULL`, which Lua surfaces as a clean out-of-memory error
rather than growing unbounded. This is necessary in addition to the
timeout: an allocation loop (e.g. repeated string concatenation) can
exhaust memory in well under 5 seconds, before the instruction-count hook
would ever fire. `print()` output is similarly capped (1000 lines, with a
truncation marker past that) before being marshalled back through
`RunScript`'s return value and over IPC.

**Bound Lua globals**, each a thin wrapper implemented directly in
`script_ops.cc` against the attached process handle (not reusing
`patch_ops.cc`'s `ReadBytes`/`WriteBytes`, whose semantics — hex-string
encoding, a 64-byte cap, page-straddle refusal, flipping pages to
`PAGE_EXECUTE_READWRITE` — are specific to code-patching and would be
confusing under the same names in a general scripting context):

- `readInt8/16/32/64(address) -> integer`, `readFloat/readDouble(address) -> number`
- `writeInt8/16/32/64(address, value)`, `writeFloat/writeDouble(address, value)`
- `readBytes(address, length) -> string` (a raw, binary-safe Lua string —
  Lua strings may contain any byte value — not hex), `writeBytes(address, string)`
- `resolvePointer(moduleName, offsets) -> address | nil` (renamed from this
  spec's earlier `resolveChain` to avoid colliding with the existing,
  semantically different `resolveChain` already exposed to the renderer for
  the reverse address→chain pointer scan). Wraps a **forward** base+offsets
  walk — module base plus a chain of dereferences — which today exists only
  as an unexported function in `memory_ops.cc`'s anonymous namespace
  (`native/src/memory_ops.cc:15-28`) alongside `ParseHex`; both are hoisted
  into a new shared header `native/src/chain_walk.h` so `memory_ops.cc` and
  `script_ops.cc` share one implementation, together with the module-base
  lookup `pointer.cc` already has (`GetModuleBase`).
- `print(...)` — appends a formatted line to the run's `output` array
  (returned once the script finishes; not streamed live, per Out of scope).

**Addresses are represented as Lua integers** (Lua 5.4 has native 64-bit
integers) end to end — `readInt32(0x7ff6a1b2c3d4)`,
`resolvePointer("game.exe", {0x18, 0x20})` returning an integer usable
directly as the next call's address. This is a deliberate divergence from
the hex-string convention `ChainTarget`/`getModuleBase` use elsewhere in
this codebase: those are string-serialized for JSON storage, while a Lua
script is manipulating addresses as arithmetic values within a single run,
where a native integer type is the natural fit and avoids every bound
function doing string⇄integer conversion.

#### Renderer UI

New `ScriptEditor` panel (reachable from CheatList, mirroring how the
existing patch-capture flow opens its own panel):

- Two textareas: Enable script, Disable script.
- Save persists a `ScriptCheat` via the existing `saveCheat` IPC path
  (`cheats:save`'s hotkey-conflict validation already runs generically
  across stored-cheat kinds; needs the `isScriptCheat` guard described
  above, no other change).
- "Run enable now" / "Run disable now" test buttons call `scripts:run`
  directly against the textarea contents (not yet saved, and with a
  throwaway `state`), for iterating on a script before committing it.
- Output console below the textareas shows the returned `output` lines, or
  the error message on failure, via the same dismissible-banner treatment
  patch/hotkey errors already use.

IPC: `scripts:run(source: string, phase: 'enable' | 'disable', stateIn:
Record<string, LuaValue>) -> { success, output, error, stateOut }`, throwing
`'not attached'` when nothing is attached (matching `memory:readBlock`'s
convention above). Used both by the test buttons (with an empty/throwaway
`stateIn`) and by `ScriptRuntime`'s enable/disable calls (with the real
per-cheat `state`).

## Out of scope

- No CT Lua-script import — Cheat Engine's Lua Cheat Table entries are a
  different XML shape than the Auto Assembler entries `ctImport.ts` already
  parses; teaching CT import to recognize embedded Lua tables is a separate
  project. CT export skips script cheats entirely (reported, not silently
  dropped — see the CT-export bucket note above).
- No continuous/tick-driven scripts — v1 is one-shot enable/disable only,
  matching a one-shot value cheat's shape. Anything that needs to run every
  frame stays on freeze cheats/patches.
- No live-streaming `print()` output while a script runs — output appears
  once the script (or its timeout) finishes.
- No Lua standard library beyond the explicit allowlist above — no `debug`,
  `io`, `package`, `os.execute`, `os.exit`, `dofile`, `loadfile`, or `load`.
- Memory Viewer's structure-dissect rows are not persisted or exportable —
  purely a scratch working area.
- No disassembler view — the memory viewer is hex+ASCII only.
- No handling for a memory page that's partially readable (readable start,
  unmapped tail) — v1 shows the whole requested page as unreadable if any
  part of the read fails.

## Testing

- `ReadBytes`'s raised cap and new `raw` mode get a native test alongside
  the existing `patch_ops`/`memory_ops` tests (over-cap still throws;
  `raw: true` returns a `Buffer` of the requested length).
- `dissect.ts`'s decode logic gets `tests/renderer/dissect.test.ts` —
  a pure module, tested the way `tests/renderer/monoSearchIndex.test.ts`
  already tests a pure renderer module — covering every `DataType` width,
  explicitly including the unsigned-int8 case and the int64-as-`BigInt`
  case, since both are places this second implementation could silently
  drift from `value_type.h`'s.
- `ScriptRuntime` (`enable`/`disable`/`isEnabled`, the in-flight guard, and
  the `state` handoff) is tested the way `tests/main/freezeLoop.test.ts`
  already tests `FreezeLoop` — a fake `RunScript` dependency, no real Lua
  or Electron involved.
- `script_ops.cc`'s Lua binding gets `tests/native/script_ops.test.ts`,
  following the exact pattern `tests/native/memory_ops.test.ts` already
  uses: spawn `test-harness/harness.exe`, attach, drive it over stdin, and
  assert from the outside. Concretely: each bound global reads/writes the
  right width against a harness global; a `while true do end` script
  returns `success: false` within roughly the 5-second cap, not hung
  indefinitely; and — the highest-value case here — a script calling
  `os.execute(...)`, `package.loadlib(...)`, or `debug.sethook(...)` fails
  (those globals are `nil`), proving the allowlist actually holds rather
  than merely being described in this document.

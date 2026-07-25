# Code-Patch Cheats (#6) — Design

## Purpose

Add "patch the instruction" cheats to Tamper: take an instruction caught by
Find-What-Writes (#5) and overwrite it with no-ops so that write never
executes. This is the reliable way to do "infinite stamina / no drain"
style cheats — instead of freezing a value (which fights the game and often
pins a mirror copy), you disable the code that changes it.

#5 is the prerequisite: it finds and decodes the writing instructions and
already produces a wildcarded AOB signature for each. #6 consumes that to
apply and re-locate a NOP patch.

## Scope

**In scope:**
- NOP-fill patches only: replace a caught instruction with `0x90 × length`.
- Apply a patch at the instruction's current address immediately (same
  session).
- Restore-on-disable and restore-on-detach/exit (never leave the game's
  code modified when Tamper lets go).
- Best-effort relocation across restarts: by module+offset for a named
  module, or by scanning executable memory for the AOB signature for JIT
  code.
- A new patch cheat kind, its create action in the capture panel, and its
  toggle/status/delete in the cheat list.

**Out of scope:**
- Custom / arbitrary byte patches (only NOP-fill).
- Code caves / trampolines / injected assembly.
- Making JIT-code patches survive a game *update* (the AOB scan handles
  ASLR and same-build relaunches; a recompiled game may need re-capture).

## Global constraints

- Windows only. No network calls anywhere in the stack.
- **Safety (non-negotiable):** never write NOPs to an address whose current
  bytes do not match the captured original (or the signature). Always
  restore original bytes on disable and on detach/app-exit. If relocation
  is ambiguous (AOB scan yields 0 or >1 match), mark the patch
  "can't relocate" rather than patching a guess.
- The native addon's `Init()` warm-up `Napi::Number::New(env, 0.0)` line
  must remain.
- One capture session at a time (unchanged from #5).

## Architecture

### Native primitives

- `readBytes(handle, address, length): string` — read `length` bytes at
  `address`, return as hex. Used to verify-before-patch and to inspect.
- `writeBytes(handle, address, hexBytes): boolean` — write bytes into the
  target, handling executable pages: `VirtualProtectEx` to
  `PAGE_EXECUTE_READWRITE`, `WriteProcessMemory`, restore the previous
  protection, `FlushInstructionCache`. Returns success.
- `scanAob(handle, signature): string[]` — scan committed, executable
  (`PAGE_EXECUTE_*`) regions for the masked byte pattern (`??` tokens match
  any byte; two-hex tokens match literally), returning matching addresses as
  hex. One bulk read per region (same pattern as the value scanner), so it
  stays responsive; runs on a background thread (AsyncWorker) like the other
  whole-memory walks.

### Patch storage (new cheat kind)

The game JSON holds a mixed array of value cheats (existing) and patch
cheats. A `kind` discriminator distinguishes them; absence means `'value'`
(backward compatible with existing files).

```ts
type StoredCheat = ValueCheat | PatchCheat

interface ValueCheat {           // existing shape, kind optional/'value'
  kind?: 'value'
  id: string; name: string
  dataType: DataType; mode: CheatMode
  targets: ChainTarget[]; value: number
}

interface PatchCheat {
  kind: 'patch'
  id: string
  name: string
  originalBytes: string   // captured instruction bytes (hex)
  length: number          // bytes to NOP (== instruction length)
  signature: string       // AOB with ?? wildcards (relocation for JIT code)
  moduleName: string | null   // named module, or null for JIT/anonymous
  moduleOffset: string | null // hex offset within module (if moduleName)
}
```

`store.ts` loads/saves the mixed array; `loadCheats` returns the union.
`saveCheat`/`deleteCheat` work by `id` regardless of kind.

### Application (main process)

Patches are apply-once / restore-once — they do **not** enter the freeze
loop. `ipc.ts` gains:

- `locatePatch(handle, patch): { address: string | null, applicable: boolean }`
  — resolve the instruction's current address:
  1. If `moduleName` is set: `address = getModuleBase(moduleName) + moduleOffset`.
  2. Else: `scanAob(signature)` → exactly one match → that address; 0 or >1
     → not locatable.
  Then read `length` bytes there and confirm they match `originalBytes` (or
  are already all-NOP, meaning still-applied). `applicable` is false if not
  found or the bytes don't match.
- `applyPatch(handle, patch)` — locate; if applicable and not already NOP,
  write `0x90 × length`; record `{id, address, originalBytes}` in an
  in-memory applied-set.
- `restorePatch(handle, patch)` — if in the applied-set, write
  `originalBytes` back at the recorded address; remove from the set.
- On process detach and on app quit: restore every entry in the applied-set.

An in-memory applied-set (id → {address, originalBytes}) is the source of
truth for what must be restored; it is authoritative over the stored
definition in case relocation shifts.

### IPC / preload / renderer

New channels: `patch:apply`, `patch:restore`, `patch:locate` (returns
status for the cheat-list readout). Preload exposes
`applyPatch(patch)` / `restorePatch(patch)` / `locatePatch(patch)`; the
renderer supplies the patch, main injects the handle. `tamper.d.ts` gains
the `PatchCheat` type and methods.

### UI

- **Capture panel (Scanner):** the "Create patch" button (currently
  disabled) becomes active for any caught instruction with `length > 0`
  (patching needs only the instruction's bytes/length/address/signature, not
  a base register — so it works for `rip`-relative and otherwise-undecoded
  writes too). Clicking builds a `PatchCheat` from the caught instruction and
  saves it.
- **Cheat list:** patch cheats render alongside value cheats with a toggle
  (on → applied NOPs, off → restored), a located/can't-relocate status
  chip (checked on attach via `patch:locate`), the broken/"can't relocate"
  error state, and Delete. Toggling on calls `patch:apply`; off calls
  `patch:restore`. Enabling one that can't be located surfaces an error and
  stays off.

### Data flow

```
capture (#5) → caught instruction (bytes, length, signature, module info)
  → "Create patch" → saved PatchCheat
  → cheat list toggle ON → locate (module+offset or AOB scan)
      → verify current bytes match original → write NOPs
  → toggle OFF / detach / quit → write original bytes back
```

## Error handling

- Locate fails (module not loaded, AOB 0/>1 matches, bytes don't match
  original) → patch shows "can't relocate", toggle refuses to enable, no
  write attempted.
- `writeBytes` fails (VirtualProtectEx/WriteProcessMemory error) → report
  failure, leave state consistent (don't mark applied if the write didn't
  land).
- Detach/quit with patches applied → restore all; a restore that fails
  (e.g. process already gone) is ignored (the code goes away with the
  process).
- Applying an already-applied patch (bytes already NOP) is a no-op, not an
  error.

## Testing

- **Harness:** add a `drainloop`/`stopdrain` pair that spawns a thread
  repeatedly decrementing a global counter through a dedicated, non-inlined
  store instruction (throttled), plus a `getcount` command returning the
  counter. The decrement store is the "drain" instruction under test.
- **Native tests:**
  - `readBytes`/`writeBytes`: read the drain instruction's bytes, NOP them
    while `drainloop` runs, confirm via `getcount` that the counter **stops**
    decreasing; write the original bytes back and confirm it **resumes** —
    exercising the full VirtualProtectEx → write → FlushInstructionCache →
    restore path against live executing code.
  - `scanAob`: build a signature from the drain instruction's bytes and
    confirm `scanAob` finds its address (and that patching at that found
    address has the same stop-the-drain effect), exercising the JIT-style
    relocate-by-signature path.
- Renderer patch UI has no automated test (consistent with the other
  screens); covered by build + manual validation.
- **Manual (Valheim):** capture a stamina writer, Create patch, toggle on,
  confirm stamina stops draining; toggle off, confirm it drains again;
  confirm the game stays stable; detach and confirm the code is restored.

## Relationship to prior work

This builds directly on #5 (Find-What-Writes): #5 produces the caught
instruction with its bytes, length, AOB signature, and module info; #6 is
the apply/restore/relocate engine plus the patch cheat kind and UI. It is a
separate sub-project with its own plan.

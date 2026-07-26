# Code Injection and Persistent Anchors (#7) — Design

## Purpose

Make cheats survive a game restart.

#6 can disable a write by NOPping it. That is enough to stop a value
changing, but not to control what it becomes, and it is the only durable
cheat Tamper has: value cheats reach their target through pointer chains
found by scanning, and those chains do not survive a restart of a
garbage-collected runtime. Real-game testing against Valheim confirmed
this — a stamina freeze worked in-session and resolved to nothing after a
relaunch.

This sub-project adds the technique every mature trainer uses instead: a
code cave. Redirect an instruction into memory we allocate, run the
game's own instruction there, and then do something extra — force a
constant, or record where the object lives. Because the injection site is
found again by byte-pattern scan, both survive restarts.

The two modes together mean nothing in Tamper is session-only:

- **force** — after the game writes a field, overwrite it with a constant.
  Persistent infinite stamina, ammo, durability.
- **capture** — record the object's base pointer into our own memory as the
  game runs, giving value cheats a stable anchor that a scanned chain
  cannot provide.

## Scope

**In scope:**
- A code-cave engine: allocate, assemble, install, restore.
- Injection mode `force`: `mov dword ptr [reg+offset], imm32` after the
  displaced original instruction. Covers int32 and float — the same
  encoding, differing only in the 32 bits of the immediate.
- Injection mode `capture`: store the instruction's base register into a
  slot in the cave, so the current object address is always readable.
- A new value-cheat target type anchored to a captured pointer, alongside
  the existing scanned-chain targets.
- Unifying #6's NOP patch into one patch cheat kind with a `mode`
  (`nop` | `force` | `capture`), absent meaning `nop`.

**Out of scope:**
- Arbitrary user-typed assembly. One instruction template, encoded by us.
- Arithmetic modes (add/multiply/scale) — `force` first; the machinery
  admits them later without redesign.
- Auto-applying cheats on attach. Relocation is heuristic for JIT code; a
  patch that relocated to the wrong site must not be installed unattended.
- Mono/IL2CPP runtime detection or metadata traversal. Byte-pattern
  anchoring makes it unnecessary for these cheats.
- Freeing caves. See Safety.

## Global constraints

- Windows only, x86-64. No network calls anywhere in the stack.
- **Safety (non-negotiable):**
  - Never install an injection whose displaced run contains a RIP-relative
    instruction. Relocating one silently changes what it addresses.
  - Never install when the bytes at the located address don't match what
    was captured, or when relocation is ambiguous (0 or >1 signature
    matches) — unchanged from #6.
  - Suspend every thread in the target while writing or restoring an
    injection site. A thread mid-instruction inside the region being
    rewritten is a crash.
  - Never free a cave while the process lives. A thread suspended inside
    one must still have valid code to return through.
  - Restore every installed injection on disable, on detach, and on app
    exit — as #6 already does for NOP patches.
- The addon's `Init()` warm-up `Napi::Number::New(env, 0.0)` stays.
- Reuse #6's relocation, verify-before-write, applied-set and status chip
  rather than parallel implementations.

## Architecture

### Native primitives

Small, individually testable, no policy:

- `allocateCave(handle, nearAddress): string | null` — `VirtualAllocEx` one
  4KB `PAGE_EXECUTE_READWRITE` page within ±2GB of `nearAddress`, walking
  free regions outward from it. Null if no free region is in range: a
  5-byte `jmp rel32` cannot reach further, and we do not fall back to a
  wider jump (see Rejected alternatives).
- `decodeRun(handle, address, minBytes): { length, ripRelative, decodable }`
  — decode forward until at least `minBytes` of whole instructions are
  covered. Reports the exact run length and whether any instruction in it
  is RIP-relative. This is what makes "displace 5 bytes" safe: we always
  displace whole instructions.
- `encodeStore(baseRegister, offset, imm32): string` — Zydis's encoder
  emits `mov dword ptr [reg+offset], imm32`. The vendored amalgamation
  already includes the encoder. int32 and float share this one template:
  the caller passes the raw 32 bits, so `350.0f` arrives as `0x43AF0000`
  and no separate floating-point path exists.
- `encodeCapture(baseRegister, slotAddress): string` — emits
  `mov [rip+disp], reg` writing the base register into the cave's slot.
  RIP-relative is safe *here*, unlike in a displaced instruction: we
  assemble it at a cave address we chose, so the displacement is computed
  against where the instruction will actually execute, and it never moves
  afterwards.
- `encodeJump(from, to): string` — the 5-byte `jmp rel32`.
- `suspendThreads(pid) / resumeThreads(pid)` — every thread of the target.

`readBytes` / `writeBytes` / `scanAob` from #6 are reused unchanged.

### Cave layout

One cave per installed injection:

```
+0x00  captured pointer slot (8 bytes, capture mode only; zero otherwise)
+0x08  displaced original instruction(s), verbatim
       injected effect:
         force   → mov dword ptr [base+offset], imm32
         capture → mov [rip+slot], base
       jmp rel32 back to site + displacedLength
```

Putting the slot first keeps its address trivially derivable from the cave
address, which is what a value cheat stores.

### Installation

`PatchEngine` orchestrates in TypeScript, as in #6, so the decision logic
stays testable against a fake process:

1. Locate (module+offset, or exactly one AOB match) — unchanged.
2. Verify the bytes there match `originalBytes` — unchanged.
3. `decodeRun(address, 5)`. Refuse if undecodable or RIP-relative.
4. `allocateCave(near: address)`. Refuse if null.
5. Assemble the cave body and write it.
6. `suspendThreads` → write `jmp rel32` + `0x90` padding to
   `displacedLength` → `resumeThreads`.
7. Record `{ id, address, originalBytes, caveAddress, mode }` in the
   applied-set, which stays authoritative for restoration.

Disable reverses step 6 only: suspend, restore the original bytes, resume.
The cave stays allocated until the process exits.

### Storage

`PatchCheat` gains `mode` and the fields `force`/`capture` need. Absent
`mode` means `nop`, so every patch saved by #6 keeps working through the
code path it already uses.

```ts
interface PatchCheat {
  kind: 'patch'
  mode?: 'nop' | 'force' | 'capture'
  id: string; name: string
  originalBytes: string; length: number
  signature: string
  moduleName: string | null; moduleOffset: string | null
  // force and capture: which register holds the object
  baseRegister?: string        // 'rdi', from the capture
  // force only:
  fieldOffset?: string         // hex, base register → the field to overwrite
  value?: number
  dataType?: 'int32' | 'float' // decides how `value` becomes 32 bits
}
```

A value cheat's target becomes a union: the existing scanned chain, or an
anchor naming a capture patch.

```ts
type CheatTarget = ChainTarget | AnchorTarget

interface AnchorTarget {
  kind: 'anchor'
  patchId: string    // the capture-mode patch supplying the base pointer
  offset: string     // hex, added to the captured pointer
}
```

Resolution: read the pointer from that patch's cave slot, add `offset`.
If the capture patch is not currently installed, or its slot still reads
zero because the game has not executed the instruction yet, the target is
simply not live — the same "not resolving" state the freeze loop already
handles, and the cheat list already reports as `N/M live`.

### UI

The capture panel's **Create patch** grows a mode choice: *disable the
write*, *force a value* (with a value box inheriting the scan's data
type), or *capture this object* (naming the anchor). The cheat list is
unchanged: same toggle, same status chip, same delete. Creating a value
cheat from a capture anchor is offered where the anchor exists.

## Error handling

Every refusal names the actual cause, as #6's `relocationError` does:

- RIP-relative in the displaced run → "This instruction sits next to code
  that refers to its own address; moving it would change what it reads."
- No free page within range → "No memory available near the instruction."
- Undecodable bytes → refuse; never guess a run length.
- Suspension failure on any thread → abort before writing anything, resume
  whatever was suspended.
- Cave write failure → free that cave (nothing is executing in it yet) and
  refuse.
- Site write failure after a successful cave write → the cave leaks
  harmlessly; report failure, install nothing.
- Anchor slot reads zero → target not live, not an error.

## Testing

The harness gains a field written in a loop through a plain
register-addressed store, plus commands to read it:

- **force**: inject a constant while the loop runs; assert the field
  becomes that constant and stays there across several samples while the
  game keeps running; restore; assert it resumes changing. This is the
  first end-to-end proof of a working cheat rather than a disabled write.
- **capture**: inject capture mode; assert the slot fills with the object's
  real address, and that address + offset reads the expected field value.
- **decodeRun**: a RIP-relative instruction is reported as such and refused.
- **allocateCave**: returns an address within ±2GB of a target.
- **restore**: after disable, the site's bytes are byte-identical to the
  original and the loop behaves as before.
- **Engine tests** against a fake process cover mode selection, every
  refusal path, and that a failed install records nothing.
- **Manual (Valheim)**: force stamina to a constant, confirm it holds;
  restart the game, re-attach, confirm the patch relocates and works
  again. That last step is the whole point of this sub-project.

## Rejected alternatives

- **14-byte absolute jump** (`jmp [rip+0]` + address), which would remove
  the ±2GB constraint. It displaces three or four instructions instead of
  one or two, multiplying the chance of swallowing a branch target or a
  RIP-relative access. The tighter footprint is worth the allocation
  search.
- **In-place immediate store**, replacing the original instruction with
  `mov [reg+off], imm32` and no cave. The immediate form is usually longer
  than the register form, so it fits only occasionally and fails
  confusingly otherwise.
- **Freeing caves on disable**, as CE does. A thread suspended inside a
  cave resumes into freed memory. A leaked 4KB page per patch is nothing.
- **Mono metadata traversal** for persistent value cheats. Byte-pattern
  anchoring plus pointer capture achieves the same result without teaching
  Tamper about a specific runtime, and works equally for native games.

## Relationship to prior work

#5 finds the instruction that writes an address and produces its bytes,
length, AOB signature, base register and field offset. #6 relocates that
instruction across restarts and applies/restores a NOP over it, with
verify-before-write and an authoritative applied-set. #7 keeps all of
that and replaces "write 0x90" with "redirect through a cave", adding the
two modes that make a cheat do something useful and give value cheats a
durable anchor.

## Sequencing

Two stages, each independently testable, in one plan:

1. **Cave engine and `force`** — primitives, cave assembly, install and
   restore, mode-aware storage and UI. Delivers persistent value-forcing
   cheats on its own.
2. **`capture` and anchored value cheats** — the capture mode, the anchor
   target type, and resolution through the cave slot. Depends on stage 1's
   machinery and nothing else.

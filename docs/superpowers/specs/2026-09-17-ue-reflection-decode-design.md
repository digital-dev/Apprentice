# UE reflection decode (Phase 1a of the UE5 reflection bridge) — design

## Problem

`2026-09-03-ue5-reflection-design.md` scoped a full UE5 reflection bridge
mirroring Mono's: resolve a `UClass` by name, list/resolve its
`FProperty`s, get an instance field's address. Phase 0 (byte-pattern
port for Palworld) shipped; Phase 1 (the actual reflection walk) never
started. This picks up Phase 1.

## What research changed since that doc was written

Pulled the real, currently-maintained reference implementation
(`Encryqed/Dumper-7`, a UE SDK generator) rather than reconstructing the
struct/name layout from memory, since a wrong layout here is silently
wrong forever, not a crash — worth getting right rather than fast.

Two findings that reshape scope from the original doc:

1. **No remote code injection needed.** Unlike Mono (whose only
   enumeration primitive, `mono_assembly_foreach`, is callback-based —
   the reason `mono_bridge.cc` hand-encodes remote stub bytes), UE's
   `UClass`/`FField`/`FProperty` metadata is walked with plain
   `ReadProcessMemory`-style reads. This project already has that
   primitive end to end (`mcp-server`'s `tryReadBytes`/`tryReadValue`),
   so this needs **no new native code at all** — a pure TS module,
   exactly like `cheatVerify.ts`'s `resolveMonoTargetAddress` port.
2. **`GNames` decoding is a calibrated formula, not a fixed one.**
   Dumper-7's `NameArray.cpp` (700 lines) *auto-detects* four numbers
   per engine build by probing live memory for known strings ("None",
   "ByteProperty", "/Script/CoreUObject") — `BlockOffsetBits` (seen as
   both `0x10` and `0xE` in different builds), `NameEntryStride`
   (`2` or `4`), `StringOffset`, and `LengthShiftCount`. These are
   genuinely build-dependent; freehand-hardcoding a "typical" value
   would repeat the exact mistake this project already paid for twice
   (trusting an unverified constant against a real game — see
   `2026-09-07-il2cpp-symbol-resolution-design.md`'s ICF landmine and
   `2026-09-03-ue5-reflection-design.md`'s own stale-signature session
   finding).

**Consequence**: this phase builds the *decode/walk given known
config* half only — the same relationship `monoDllBase` already has to
every `mono_*` tool (an input, not something the tool discovers). The
four `GNames` calibration numbers, plus `GUObjectArray`'s own base and
chunking layout, are a **one-time-per-game manual calibration**,
documented below as a recipe using tools that already exist
(`scan_aob`, `read_bytes`) — not new automated discovery code. No live
UE5 process is running in this environment right now (only
`Schedule I.exe`, Unity/IL2CPP, was up when this was written) to verify
an auto-discovery heuristic against even if one were built.

## Goal

A pure TS module, `mcp-server/src/ueReflect.ts`, implementing:

- `decodeFName(readBytes, poolConfig, comparisonIndex) -> string | null`
- `walkProperties(readBytes, classAddress) -> { fieldAddress, nameComparisonIndex, offsetInternal }[]`
- `resolveClass(readBytes, arrayConfig, poolConfig, className) -> string | null`
- `resolveField(readBytes, poolConfig, classAddress, fieldName) -> { offset: number } | null`

Plus MCP tool wrappers (`ue_decode_name`, `ue_list_field_names`,
`ue_resolve_field`, `ue_resolve_class`), mirroring `mono.ts`'s shape —
read-only, no remote calls, no writes.

## Non-goals

- No `GNames`/`GUObjectArray` auto-discovery (see above) — both are
  caller-supplied config.
- No `UClass`/`FProperty` *instance* reads beyond field offsets — an
  instance's field address is `instancePointer + offset`, already
  trivial arithmetic the caller (or a future `UeTarget` in
  `store.ts`, out of scope here) can do without a dedicated tool.
- No method calling (`ueCallFunction` from the original doc) — that
  needs `ProcessEvent`'s vtable slot, itself another build-dependent
  calibration number nobody has found yet for any tracked game.
- No renderer UI (`UEExplorer.tsx`) or `store.ts`/`UeTarget` wiring —
  this phase is the resolution primitives only, same incremental slice
  size as `mono_resolve_class`'s own first landing.

## Design

### Struct offsets (from the confirmed layout in
`2026-09-03-ue5-reflection-design.md`, sourced from
`PalworldModding/UsefulFiles/MemberVariableLayout.ini` — stable across
the UE4.20+/UE5 ABI family, not this-project-live-verified beyond that
community source):

```
UObjectBase.ClassPrivate   @0x10
UObjectBase.NamePrivate    @0x18  (FName, 8 bytes: {int32 ComparisonIndex, int32 Number})
UField.Next                @0x28
FField.Next                @0x20
FField.NamePrivate         @0x28
FProperty.Offset_Internal  @0x4C
UStruct.ChildProperties    @0x50
```

### `decodeFName`

Given `poolConfig = { gNamesBase, blockOffsetBits, nameEntryStride, stringOffset, headerOffset, lengthShiftCount }`
(the four calibrated numbers above, plus `gNamesBase` itself and
`headerOffset`, defaulted to `0` — Dumper-7's own default, only `4` in
a rare edge case this phase doesn't handle):

1. `chunkIdx = comparisonIndex >> blockOffsetBits`
2. `inChunkOffset = (comparisonIndex & ((1 << blockOffsetBits) - 1)) * nameEntryStride`
3. `blockPtrAddress = gNamesBase + 0x10 + chunkIdx * 8` (the `+0x10`
   is Dumper-7's own default `ChunksStart` — the block-pointer array
   sits right after the pool's small header)
4. Read 8 bytes at `blockPtrAddress` as a little-endian pointer ->
   `blockBase`. Null/unreadable -> return `null`.
5. `entryAddress = blockBase + inChunkOffset`
6. Read 2 bytes at `entryAddress + headerOffset` as a little-endian
   `uint16` -> `header`.
7. `nameLen = header >> lengthShiftCount`. If `nameLen === 0`, return
   `null` (the numbered-name fallback case — rare for gameplay class/
   field names, not handled this phase, matching the "don't fabricate
   the untested path" principle applied everywhere else in this spec).
8. If `header & 1` (the wide-string flag — Dumper-7's `NameWideMask`):
   read `nameLen * 2` bytes at `entryAddress + stringOffset`, decode
   UTF-16LE. Else: read `nameLen` bytes, decode ASCII/UTF-8.

### `walkProperties`

Given a `UStruct`/`UClass` address: read `ChildProperties` (`+0x50`),
then follow `FField.Next` (`+0x20`) until null, collecting each
node's `NamePrivate` (`+0x28`, read as the raw
`{comparisonIndex, number}` pair — decoding to a string is the
caller's job via `decodeFName`, keeping this function name-decode-
config-free) and `Offset_Internal` (`+0x4C` — only meaningful if the
node is actually an `FProperty`; every node in this chain in practice
is, matching the design doc's own algorithm, which doesn't
distinguish either). Cap iterations at a fixed bound (matching every
other unbounded-walk primitive in this codebase, e.g.
`kMaxScanResults`) to avoid an infinite loop on a corrupt/misread
chain.

### `resolveClass`

Given `arrayConfig = { chunksArrayBase, numElementsPerChunk, itemStride, itemInitialOffset }`
(the `FChunkedFixedUObjectArray` shape — `chunksArrayBase` points at
an array of 64KB block pointers, each block holding
`FUObjectItem`s of `itemStride` bytes, the object pointer itself at
`itemInitialOffset` within each item — `itemStride = 0x10`,
`itemInitialOffset = 0x0` are Dumper-7's own defaults for the common
case) and `poolConfig`: walk every object up to
`numElementsPerChunk * <however many chunks are populated>`
(bounded — see below), for each one read `UObjectBase.NamePrivate`
(`+0x18`), decode via `decodeFName`, and return the first object whose
decoded name equals `className` **and** whose own `ClassPrivate`
(`+0x10`) decodes (one more `decodeFName` hop through that pointer's
own `NamePrivate`) to `"Class"` — the standard "is this actually a
UClass, not just any object with this name" check every public UE
reflection tool uses. Since this phase has no live way to learn how
many chunks/objects actually exist, `resolveClass` takes an explicit
`maxObjectsToScan` parameter (caller-supplied, no silent default) — a
full unbounded scan is a caller decision, not this function's to make
alone, given how easy an ill-configured `arrayConfig` makes it to loop
over garbage memory harmlessly-but-uselessly for a long time.

### `resolveField`

`walkProperties(classAddress)`, decode each entry's name via
`decodeFName`, return `{ offset: matchingEntry.offsetInternal }` for
the first match, `null` if none.

### Calibration recipe (documented, not automated)

New section in a design doc (this one) rather than new code — the
manual, one-time-per-game procedure to find `poolConfig`/`arrayConfig`,
using only tools that already exist:

1. **Find `GNames`**: `scan_aob` for the ASCII bytes of a string
   guaranteed to be in the name pool early (`"None"`,
   `4E 6F 6E 65 00`) is too common to be useful alone (matches
   thousands of unrelated bytes) — instead, per Dumper-7's own
   technique, first locate a highly distinctive literal like
   `"/Script/CoreUObject"` (`2F 53 63 72 69 70 74 2F 43 6F 72 65 55 4F
   62 6A 65 63 74`) with `scan_aob` bounded to the heap (not
   `scan_aob`'s code-only search — see the sharp-edge note in
   `authoring-tamper-cheats/SKILL.md`; this needs a heap search, so use
   `scan_first`-style value scanning or a manually bounded `scan_aob`
   range over committed heap regions, not the default code-search
   path), then work backward from that hit to the containing 64KB-
   aligned block start, then to the block-pointer array holding it
   (the array holds many such block pointers — find which slot holds
   this block's address via a second scan for the block's own address
   as a QWORD value).
2. **Calibrate `blockOffsetBits`/`nameEntryStride`/`stringOffset`/
   `lengthShiftCount`**: read raw bytes around a name known to be in
   entry index 0 (always `"None"`) and entry index a few past it,
   compare against the `decodeFName` formula above with candidate
   parameter values (`blockOffsetBits` is almost always `0x10`;
   `nameEntryStride` almost always `2`) until a decode round-trips to
   a real, expected string.
3. **Find `GUObjectArray`**: same technique — a known singleton
   `UObject` (e.g. the default `UEngine` instance's class) is
   findable via a value scan for a plausible object-count/pointer
   pattern, per Dumper-7's own `InitializeFUObjectItem`-style
   validation (a run of non-null, in-range pointers spaced
   `itemStride` apart).

This recipe is intentionally a starting point for whoever does the
first live calibration against a real, running UE5 game — not a
finished, tested procedure (nothing in it has been run against a live
process in this session, per the "no UE5 game running" constraint
above). Expect to refine it the same way every other recipe in this
project's skills was refined: against real, live friction.

## Testing

Every function above is pure (takes a `readBytes`-style callback, no
direct native call), so all four are unit-testable with synthetic byte
buffers standing in for remote memory — construct a fake `GNames`
pool and a fake `UClass`/`FField`/`FProperty` chain in a
`Map<string, Buffer>` or similar in-memory fixture, verify
`decodeFName`/`walkProperties`/`resolveClass`/`resolveField` against
known-correct answers. No live process, no native rebuild, no synthetic
mock harness command needed — this is strictly less native-testing
infrastructure than `cheatVerify.test.ts` needed, since there's no
native code here at all.

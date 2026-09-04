# UE5 reflection support (`ue_bridge.cc`) — design

Status: **spec drafted, Phase 0 (profile port) executing, Phase 1 (native
reflection) not started.** Written for Palworld (`Palworld-Win64-Shipping.exe`,
UE 5.1.1.0 custom engine build) as the driving target; designed to be
UE-version-general where the source material allows it.

## Why this exists

Tamper has full Mono introspection (`mono_bridge.cc`) but nothing for
Unreal Engine. Palworld (and any future UE target) needs the equivalent:
resolve a `UClass` by name, walk its `FProperty` chain for a named field's
byte offset, resolve a live object's field address. Mirrors Mono parity:
`ueResolveClass`/`ueListFieldNames`/`ueResolveField`/instance-offset
resolution, methods listing + calling (main-app only, MCP stays read-only —
same split as `monoCallAttached` vs the read-only MCP mono tools).

## Key finding: most cheats need none of this

Reverse-engineered a third-party CE trainer
(`Palworld v1.0 Plus 48 Trainer.exe`) for this exact build — its Auto
Assembler script is embedded as plain text in the binary (not obfuscated,
unlike the game's own strings — confirmed zero hits scanning for ASCII and
UTF-16 "FullStomach" and "/Script/CoreUObject" against the live process, so
the game's strings ARE stripped/obfuscated; the trainer's own strings are
not).

Two different techniques in that script:

1. **Immediate-capture (`sN` wildcards)** — CE's AA compiler captures the
   displacement byte(s) already baked into the compiled instruction by the
   engine's own compiler (e.g. `cmp [rdi+s1],eax` — `s1` is whatever offset
   the compiler used for that field in *this* build). No reflection needed;
   this is exactly `write_watch.cc`'s signature-capture idea already built
   into Tamper. Covers: temperature immunity, weapon durability, item
   spoilage, stealth mode, rare-pal spawn odds, craft/build material
   requirements, inventory stack size.
2. **Named pointer-chain (`PC_CharacterParameterComponent` etc)** — real
   offsets into named UE classes/structs
   (`PalPlayerCharacter → PalCharacterParameterComponent →
   PalIndividualCharacterParameter → PalIndividualCharacterSaveParameter`),
   gated behind a runtime `UE_OFFSETS_CHECKED` flag the trainer sets after
   its own reflection resolves them. Only this class needs `ue_bridge.cc`.
   Covers: HP, shield, stamina, food/hunger, craft speed, stat points, max
   weight, tech points, boss tech points, capture rate, damage
   dealt/taken multiplier, drop rate, work speed, time scale.

So: **Phase 0** ports category 1 directly into `games/Palworld-Win64-
Shipping.exe.json` using Tamper's *existing* patch engine (no native
changes). **Phase 1** builds `ue_bridge.cc` for category 2 only.

## Phase 0 — direct port (no new native code)

Each entry: verify the trainer's `aobscanmodule` signature still matches
live bytes in the running process (`scan_aob`, read-only, via MCP) before
writing the profile entry — never trust the extracted string blindly.
Signatures ported 1:1, `*` wildcards become `??`. Target `mode: 'replace'`
for the disable-time db-patch shapes (most of these — the trainer's
`[DISABLE]` block is a fixed-length byte replace, which is exactly
Tamper's `replace` mode), one `'force'` cave where the trainer's enable
path computes a value rather than just substituting bytes (`aobdurability`,
`aobcraftreq`, `aobbuildingreq`).

## Phase 1 — `ue_bridge.cc`

### GObjects / GNames discovery

Dead end: no literal-string anchor exists in this build (verified — see
above). `MemberVariableLayout.ini` from `PalworldModding/UsefulFiles` (the
Palworld UE4SS fork's own community-maintained file) gives the **struct
layout** offsets below for this exact engine build, but not the two global
**pointers** (`GUObjectArray`, `FNamePool` base). Those are only ever
runtime-discovered, never static data — UE4SS's own `SigScanner` finds them
via structural code-pattern scanning (heuristics: bounds-check idioms
around array growth, `ProcessEvent` vtable slot, etc.), not string xrefs.

Next concrete step for Phase 1: port/adapt UE4SS's (`Okaetsu/RE-UE4SS`,
Palworld fork) `SigScanner` GObjects/GNames heuristics into
`ue_bridge.cc`, verified live against this process before trusting any
resulting address (never skip that verification step — this is the same
discipline `anchor.ts` already enforces for Mono/module patches: an
address is never trusted without a live byte check).

### Struct layout (UE 5.1.1.0, this build — verified via
`PalworldModding/UsefulFiles/MemberVariableLayout.ini`)

```
UObjectBase (size 0x28)
  ObjectFlags     @0x8
  InternalIndex   @0xC
  ClassPrivate    @0x10   -> UClass*
  NamePrivate     @0x18   -> FName (8 bytes)
  OuterPrivate    @0x20   -> UObject*

UField : UObjectBase (size 0x30)
  Next            @0x28   -> UField*

FField (size 0x38)
  ClassPrivate    @0x8
  Owner           @0x10   -> FFieldVariant
  Next            @0x20   -> FField*
  NamePrivate     @0x28   -> FName
  FlagsPrivate    @0x30

FProperty : FField (size 0x78)
  ArrayDim            @0x38
  ElementSize         @0x3C
  PropertyFlags       @0x40
  RepIndex            @0x48
  Offset_Internal     @0x4C   <- the field's byte offset, what we want
  RepNotifyFunc       @0x50
  PropertyLinkNext    @0x58
  NextRef             @0x60
  DestructorLinkNext  @0x68
  PostConstructLinkNext @0x70

UStruct : UField (size 0xB0)
  SuperStruct     @0x40   -> UStruct*
  Children        @0x48   -> UField*  (functions, old-style)
  ChildProperties @0x50   -> FField*  (linked list via FField.Next; walk
                                       this for FProperty-by-name)
  PropertiesSize  @0x58
  MinAlignment    @0x5C
  Script          @0x60   (TArray<uint8>, bytecode)
  PropertyLink    @0x70   -> FProperty*
  RefLink         @0x78
  DestructorLink  @0x80
  PostConstructLink @0x88

UClass : UStruct (size 0x230)
  ClassDefaultObject @0x110  -> UObject* (the CDO)
```

### Resolution algorithm (once GObjects/GNames are found)

1. `ueResolveClass(handle, className)`: walk `GUObjectArray` (a chunked
   array of `FUObjectItem` — layout also needs confirming from UE4SS
   source once ported), for each entry read `UObjectBase.ClassPrivate`,
   compare `NamePrivate` against `className` via the `GNames` pool (decode
   `FName.ComparisonIndex` into a string, or precompute the target index by
   scanning the name pool for the matching string once — cheaper if
   resolving many classes against one small worklist, which is Tamper's
   case: a fixed set of Palworld struct names).
2. `ueListFieldNames(handle, classAddr)`: walk `ChildProperties` via
   `FField.Next` (@0x20) until null, read each `FField.NamePrivate`
   (@0x28), decode via GNames.
3. `ueResolveField(handle, classAddr, fieldName)`: same walk, stop at
   match, read `FProperty.Offset_Internal` (@0x4C).
4. Instance field address = `instancePtr + Offset_Internal`. No
   dereference beyond that — `PC_CharacterParameterComponent` etc are
   themselves just `Offset_Internal` values into their owning class,
   resolved once and cached, exactly like `monoStaticFieldAddress`.

### API surface (mirrors `mono_bridge.cc` / `monoResolver.ts` naming)

Native exports: `ueFindGlobals`, `ueResolveClass`, `ueListFieldNames`,
`ueResolveField`, `ueListMethodNames`, `ueResolveMethod`,
`ueCallFunction` (main-app only, via `UObject::ProcessEvent` — needs the
`ProcessEvent` vtable slot, TBD during implementation, same "ask the trainer's
own patches" style verification as GObjects/GNames).

MCP tools (read-only, mirrors `mcp-server/tools/mono.ts`):
`ue_resolve_class`, `ue_list_field_names`, `ue_resolve_field`,
`ue_list_method_names`, `ue_resolve_method`.

Main app: `ueResolver.ts` (mirrors `monoResolver.ts`), `ueTargetResolve.ts`
(mirrors `monoTargetResolve.ts`) for `UeTarget` — a new `store.ts` type
alongside `MonoTarget`. Renderer: `UEExplorer.tsx` mirroring
`MonoExplorer.tsx`, reachable the same way, new IPC channels `ue:*`
mirroring the `mono:*` set.

### Testing

The existing native harness (`test-harness/harness.c`) is a static MSVC
binary with no UObject system — same limitation the doc already states for
Mono ("almost every defect found in-game was invisible here"). Add a
synthetic in-memory mock: a `ue_mock` command building a fake
`UObjectBase`/`UClass`/`FField`/`FProperty` chain at the documented offsets
above, enough to unit-test the walking logic in isolation. It cannot
validate GObjects/GNames discovery — that only ever gets proven against the
real, running game, the same caveat this file gives Mono signature work.

## Live findings, this session (verified against the running process)

- **HP is not a float.** It's a `FixedPoint64` (the trainer's own comment:
  `//Pal.FixedPoint64=FP64`) — an int64 storing the displayed value × 1000.
  Confirmed live: scanning for plain `9660` (float/int32) only ever matched
  GPU-driver-owned memory (`nvwgf2umx.dll`'s generic buffer-copy routine —
  confirmed via `start_write_watch`/`poll_write_watch`, same
  `instructionAddress` fired for two different candidate addresses, meaning
  it's a generic copy loop, not gameplay code). Scanning for int64
  `9660000` instead found 4 candidates process-wide, one of which write-
  watched straight into `Palworld-Win64-Shipping.exe+0x33604a3` on taking
  damage — real anchor, not driver noise.
- That address is a **shared leaf setter**: `48 8B 02 48 89 01 48 8B C1 C3`
  = `mov rax,[rdx]; mov [rcx],rax; mov rax,rcx; ret` — almost certainly
  `FixedPoint64::operator=`, called from every site that writes *any*
  FixedPoint64 field (HP, MaxHP, Stamina, ShieldHP, ...), so hitting it
  once doesn't by itself say which field. Distinguishing HP from MaxHP
  from Stamina this way needs the **caller's** address (this tool has no
  call-stack — `poll_write_watch` gives the writing instruction, not its
  return address), so isolating each field is one write-watch round-trip
  per field plus manual caller correlation. Real method, proven working,
  just not fast — budget several more sessions to run it across every
  needed field, or finish the GObjects/GNames port instead and get all of
  them at once generically.
- Lesson for whoever continues: **when a scan for a game's displayed stat
  value comes up as GPU-driver-owned memory instead of the game's own
  module, suspect a fixed-point/scaled encoding before suspecting a wrong
  process or a bad scan** — the naive value was never in game memory to
  begin with.

## Live-verified struct layout — `PalIndividualCharacterSaveParameter`, this build

Derived empirically (read a 1.5KB window around the confirmed HP address,
matched known values from what was on-screen in-game at the time — HP
9660/9660, hunger 97/100, stamina 1520/1520 — against the raw bytes). No
reflection needed for this: same technique as the `FixedPoint64` find
above, just widened to a memory dump instead of one write-watch. Offsets
are relative to the struct instance base captured this session
(`0x27250862528` for HP specifically — **not stable across a restart**,
heap allocation; see "durable anchor" below for why this table is still
valuable without a fixed base address).

```
+0    HP            int64, ×1000  = 9660000   (displayed 9660)
+12   FullStomach   float         = 97.8      (displayed hunger 97/100)
+136  (SP field A)  int64, ×1000  = 1520000   (displayed STAM 1520)
+144  (SP field B)  int64, ×1000  = 1520000   (likely MaxSP — equal because
                                                full stamina at capture time)
+160  (stat)        int64, ×1000  = 100000    (100 — CraftSpeed candidate)
+168  (stat)        int64, ×1000  = 600000    (unidentified — not yet
                                                correlated to an on-screen
                                                value)
+180  MaxFullStomach float        = 100.0
```

MaxHP not yet found — not in the ±72-byte window read around HP. Either
further out, or genuinely not cached in this struct (computed on read from
level/stats elsewhere, only ever *written* here by the cheat).

## Durable anchor — the open problem this table doesn't solve

The struct base above is a heap address, gone next launch. What's actually
launch-stable is code: `Palworld-Win64-Shipping.exe+0x33604a0` (the tiny
`FixedPoint64::operator=` leaf — `mov rax,[rdx]; mov [rcx],rax; mov
rax,rcx; ret`, confirmed live via write-watch, see above). Problem: it's
shared by every FixedPoint64 field (HP, MaxHP, Stamina, ShieldHP, ...), so
a `capture`-mode patch installed there catches whichever field wrote most
recently, not reliably HP. What's actually needed is the **caller's**
address — the specific call site that's setting HP and only HP — and nothing
available through this MCP surface exposes a return address
(`poll_write_watch` gives the writing instruction, not its caller; no
execution-breakpoint / call-stack primitive is exposed, only the
data-write kind). Concretely still open:

- Find HP's specific caller (one `call` site in `Palworld-Win64-
  Shipping.exe`, out of however many call this setter) — needs either an
  execution breakpoint at the setter's entry with stack-read-back (not
  currently exposed by the MCP tool, though the underlying native
  `write_watch.cc` debugger loop may already be capable of it — worth
  checking before building something new), or brute-force disassembly of
  the whole module hunting `E8` opcodes whose relative target lands on
  `0x33604a0` (expensive, `scan_aob` can't compute relative targets on its
  own).
- Once found: a `capture`-mode `PatchCheat` (`moduleName:
  "Palworld-Win64-Shipping.exe"`, `moduleOffset` = that call site) anchors
  HP the same way Mono targets already do — durable across restarts, no
  reflection needed for this one field.
- Repeat per field (Stamina, Shield, FullStomach, ...) — same method, same
  cost each time. This is the "targeted" scope that was passed over in
  favor of full UE Explorer; it's turned out to be the faster path to a
  *working Palworld cheat specifically*, while GObjects/GNames reflection
  remains the right investment for *general* UE support (any class, any
  future UE game, not just these known fields).

## Open items for whoever picks up Phase 1

- Port UE4SS `SigScanner` GObjects/GNames heuristics (`Okaetsu/RE-UE4SS`,
  Palworld experimental branch) — read their source, don't re-derive from
  scratch.
- `FUObjectItem`/chunked-array layout for `GUObjectArray` iteration — not
  in `MemberVariableLayout.ini`'s excerpted sections above; re-fetch that
  file for the `[FUObjectArray]`/`[FChunkedFixedUObjectArray]` sections
  before writing the walker.
- `FNamePool` layout for decoding `FName` → string — same, not yet pulled
  from the ini.
- `ProcessEvent` vtable slot for `ueCallFunction` — UE5.1 stock is a known
  constant community-wide, but this is a customized engine build; verify
  live, don't assume upstream UE5.1's slot number holds.

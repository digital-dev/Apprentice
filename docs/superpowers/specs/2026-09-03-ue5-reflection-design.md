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

MaxHP not found anywhere in a 2KB window around the struct base — resolved
why: the trainer's *own* script hooks it with a separate signature
(`aobeditmaxhealth`) patching a **computed** max-health formula's result
(`cvtdq2ps`, int-to-float convert), not a stored field read. It isn't
cached in `SaveParameter` at all. Not a blocker for "unlimited health" —
freezing current HP high is sufficient for invincibility; MaxHP only
matters for the UI cap and overheal clamp, both irrelevant once HP is
force-frozen.

Struct offsets confirmed this round (cross-checked live against on-screen
values — HP 9660, Shield 1520, hunger 95 → read back 94.7, all exact):

```
+0x448  SParam_HP           int64, ×1000
+0x454  SParam_FullStomach  float
+0x4D0  SParam_ShieldHP        int64, ×1000  (was misidentified as
+0x4D8  SParam_ShieldMaxHP     int64, ×1000   Stamina earlier this session
                                               — corrected once the user
                                               clarified the on-screen
                                               number was Shield, not STAM)
+0x4FC  SParam_MaxFullStomach  float
```

Two more candidates seen but **not shipped** — no on-screen value to
cross-check them against, and this project's rule is never install
without verification: `+0x4E8` (100000, plausible `SParam_CraftSpeed`
default) and `+0x4F0` (600000, unidentified — possibly a base
Attack/Defense/Support stat).

**Current Stamina/MaxSP is NOT in this struct** — confirmed from the
trainer's own script: it writes current stamina through `Param_SP` on
`PC_CharacterParameterComponent`, a *different* object than
`SaveParameter`. Needs its own capture (same method, different anchor)
— not done yet.

## SOLVED for HP — real durable anchor found

The new `registers`/`stackTop` capture (this session, `write_watch.cc`)
found it directly: watching the HP address again, `stackTop[0]` landed at
`Palworld-Win64-Shipping.exe+0x2F7FFA2` — inside the module, a genuine
return address (this call site has no prologue push before the setter
call, so slot 0 was exactly right). Disassembling the caller confirmed
everything:

```asm
Palworld-Win64-Shipping.exe+0x2F7FF91: lea rcx, [rbx+0x448]   ; rcx = &SaveParameter.HP
Palworld-Win64-Shipping.exe+0x2F7FF98: lea rdx, [rsp+0x58]    ; source value
Palworld-Win64-Shipping.exe+0x2F7FF9D: call Palworld-Win64-Shipping.exe+0x33604a0  ; FixedPoint64::operator=
```

**`SParam_HP = +0x448`** into `PalIndividualCharacterSaveParameter`, and
`rbx` at that call site is the struct base — confirmed against the
struct-layout table above (`0x27250862528` [HP's live address this
session] − `0x272508620e0` [rbx, the struct base] = `0x448`, exact match).
This is a real, module-relative, restart-durable anchor — a Tamper
`capture`-mode patch at `+0x2F7FF91` (capture `rbx`) chained to a freeze
value cheat at `captured + 0x448` gives a genuine, durable "Unlimited
Health" cheat, no reflection needed for this field at all.

Method now proven end to end: watch → find the shared setter → watch again
and read `stackTop[0]` → disassemble the caller → real field offset +
real durable anchor. Repeat per field (MaxHP, Stamina, Shield, ...) — same
cost each time, but now every step of it is a known, working recipe.

**Correction, live-tested**: shipped a `Never Hungry` cheat (freeze
`FullStomach` at `+0x454` to 100.0) alongside HP/Shield, off the same
anchor. HP and Shield both confirmed genuinely working live (froze at
99999000, held). Never Hungry did not — the app's own Verify panel showed
"alive" (reads fine) but a permanent mismatch, and independent MCP reads
showed a smooth, uninterrupted decline with no write-induced spikes at
all. Root cause: `FullStomach` decays continuously via game logic every
tick — a 100ms freeze loop repeatedly setting it structurally cannot win
that race regardless of which offset it targets (confirmed the offset
itself was correct: cross-checked live against on-screen hunger multiple
times, including through a value change). The trainer's own script never
freezes `FullStomach` for this — it writes `SParam_HungerType` to `0`
**once**, a flag that disables the decay system itself:
```asm
mov eax,[SParam_HungerType]
mov byte ptr [rcx+rax],0
```
Looked for `HungerType`'s offset the same way as everything else (a byte
dump around the confirmed `MaxFullStomach` field at `+0x4FC`, since the
trainer's code touches it right after) — found nothing distinctively
enum-like, all zero through `+0x500`–`+0x530`. Pinning this down needs a
live differential write-test (try a candidate offset, observe whether
decay actually stops), which only the real app can do — MCP is read-only,
can't test writes itself. **Pulled `Never Hungry` from the shipped
profile** rather than leave a cheat that silently does nothing; HP and
Shield stay.

**Shipped as a real cheat**: `games/Palworld-Win64-Shipping.json` — an
internal `capture`-mode patch at `Palworld-Win64-Shipping.exe+0x2F7FF91`
(captures `rbx`, the `PalIndividualCharacterSaveParameter` base) chained to
an `Unlimited Health` freeze cheat at `captured + 0x448`. Signature
verified live (`scan_aob`, exactly 1 match in the module) before writing
it. Not yet verified by an actual install through the app (that needs a
live Tamper session — deliberately didn't bypass the app's own safety
layers, suspend-threads/protect-write-restore/byte-verify-before-install,
with a raw script) — next person to touch this: launch Tamper, attach to
Palworld, toggle it, confirm HP goes to 99999 and stays there.

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

## The framework — five recipes, not one

Cataloged every cave block in the trainer's script (`label(...)` groups —
each maps to one or more of its 48 UI toggles). Every one of them fits
exactly one of five recipes; there is no sixth kind. This is the actual
answer to "how do we get the rest of these into Tamper" — pick a cheat,
find which recipe it is, follow that recipe's known steps.

**Recipe A — struct-field freeze off a captured anchor.** What HP/Shield
are. Cost: one memory-dump + cross-check against an on-screen value (no
new live-RE once an anchor for that struct already exists). Cheapest
recipe there is, once its anchor is captured.
- Done: `SParam_HP`, `SParam_ShieldHP`/`ShieldMaxHP` (off
  `palworld-capture-save-parameter`).
- Same anchor, offset not yet confirmed against an on-screen value:
  `+0x4E8` (CraftSpeed candidate), `+0x4F0` (unidentified stat).
- Same anchor, offset known, mechanism WRONG for this field — see
  Recipe B: `SParam_FullStomach` (don't freeze it — see below).
- **Different anchor needed** (one hop further — `SaveParameter →
  Individual_IndividualActor → PC_CharacterParameterComponent →
  Param_SP`): current Stamina. Same method as HP, extra hop.
- **Different anchor entirely** (`PalPlayerState`, not `SaveParameter` —
  `PPS_InventoryData`/`PPS_TechnologyData`): Weight, Tech Points, Boss
  Tech Points.
- Pal (non-player creature) stats — `SParam_IsPlayer` check inverted
  (`je code` skips *players*) in the trainer's `aobpalstats` block. Same
  struct type, different instances (one per owned Pal, not the fixed
  player singleton) — needs iterating a roster, not just one capture.
  Lower priority; distinct sub-problem from everything else here.

**Recipe B — one-time flag/mode write, not a freeze.** A field the game
itself continuously drains/recomputes; the fix disables the *system*, not
the symptom. Diagnosed live this session (`Never Hungry`) — don't repeat
that mistake on anything that looks like a rate/decay field.
- `SParam_HungerType = 0` (Never Hungry) — offset not yet found (see
  "Correction, live-tested" above).
- Anything else phrased as "no X" rather than "unlimited X" in the
  original wishlist is a candidate for this recipe, not Recipe A — worth
  checking the trainer's own cave shape (freeze vs. one-time write) before
  assuming.

**Recipe C — compiler-offset AOB capture, no reflection at all.** The `sN`
CE wildcard captures the offset straight out of the compiled instruction.
Portable to Tamper's `nop`/`replace` patch modes directly — no capture
patch, no anchor, just a verified signature. **Caveat found earlier**:
some of these need genuinely NEW instruction logic inserted (e.g.
temperature-immunity's `xor eax,eax` ahead of a compare), which none of
Tamper's fixed cave encoders express — those need a Lua script cheat
instead (poke the field directly on a tick, once its address is knowable
some other way) rather than a code patch.
- Durability, Temperature, Stealth mode, Item spoilage, Craft/Build
  material requirement removal, Rare-pal spawn odds, Inventory max stack
  size — signatures already extracted from the trainer's script earlier
  this session (see conversation, not yet re-copied into this file).
  Every one needs a fresh `scan_aob` live-uniqueness check before
  shipping (stealth mode's 3 signature variants all missed on this build
  last time this was tried — confirms verify-before-ship isn't optional).

**Recipe D — a captured "player" pointer, not a per-field anchor.** GodMode,
Movement Speed, Infinite Jumps, EXP multiplier all gate on comparing some
register against a resolved `player` object pointer (the trainer's own
`label(player)`), then read/write a field directly on it
(`PC_CustomTimeDilation`, `PC_JumpMaxCount`, `PC_JumpCurrentCount`). This
is its own capture target — same method as HP (write-watch a known player
field's write, e.g. jump count changing, disassemble the caller) — not
yet attempted. Once captured once, every Recipe D cheat is cheap (Recipe A
math against that one pointer).

**Recipe E — a world/global options object, not per-player.** Capture
rate, damage dealt/taken multiplier, drop rate, work speed, freeze/scale
time — all one shared cave (`aobgameoptions`) writing `OS_*` fields.
Likely the SIMPLEST anchor to capture of all of them: a world-settings
singleton is far more likely to be a stable global (module-static or
one-per-session) than a per-player heap struct, meaning it may not even
need a capture patch at all — worth checking with a plain value scan
first (Scanner screen, or `scan_first`/`scan_next` via MCP) before
reaching for the capture-patch machinery Recipes A/D need.

**Priority order for picking the next one up**: Recipe E first (cheapest
to even ATTEMPT — try the plain-scan shortcut before assuming a capture
patch is needed), then finish Recipe A's already-half-open anchor
(Stamina, Weight/Tech Points — new anchors but same proven method), then
Recipe D (GodMode — highest wishlist value), then Recipe B
(`HungerType` — needs the live differential-write session flagged
above), then Recipe C (mechanical but many small verify-and-ship cheats,
plus the Lua-script fallback design for the ones that don't fit a patch
mode).

## Session finding — most Recipe C/E signatures are stale against the live build

Attempted the priority-1 pickup (Recipe E, `aobgameoptions`) and several Recipe
C candidates (`aobspoil`, `aobcraftreq`/`aobbuildingreq` short variant,
`aobstealthmode`) against the currently-running process
(`Palworld-Win64-Shipping.exe`, module version still reports UE `5.1.1.0` —
that's the engine build tag, not the game's own patch level). Every one of
those signatures, `scan_aob`'d live with the wildcard counts translated
carefully (double-checked `sN.m`-style CE placeholders against actual
instruction encoding, e.g. confirmed `s1.2 00 00` is a 4-byte disp32 with a
zeroed high half, not 6 wildcard bytes), came back **zero matches** — not
"shifted a little," gone entirely. The one exception: `aobdurability` (`F3 0F
10 41 08 0F 2E C2 74 ?? F3 0F 11 ?? ?? F3 0F 11`) matched exactly once, live,
unchanged.

Conclusion: the trainer ("Palworld v1.0 Plus 48 Trainer.exe") was built
against an earlier game patch. The engine build tag staying at 5.1.1.0 says
nothing about the game's own code — Palworld ships frequent content/balance
patches that recompile game code against the same engine version, which is
exactly the kind of drift this doc's own Phase 0 instructions warned about
("never trust the extracted string blindly"). Practical effect: **most of the
trainer's 48 toggles cannot be ported by signature-copy alone anymore** — each
one needs its AOB re-derived against the live process before it's usable,
the same live-RE cost as an anchor discovered from scratch. This materially
changes the "cheap, mechanical" framing Recipe C was given in the priority
order below — it no longer skips live-RE, it just skips *reflection*.

`aobdurability` surviving is also not a clean win: its cave inserts new
register logic (`movss xmm2,[rcx+0C]` ahead of the original
`movss xmm0,[rcx+08]`), not a constant value or a fixed-length byte swap —
it doesn't fit either of Tamper's existing `force` (write a computed value)
or `replace`/`nop` (fixed bytes) patch modes, matching the Lua-script-fallback
caveat Recipe C already called out. Not shipped this round — needs that Lua
path designed first, and the offset semantics (`+0x08`/`+0x0C` — which is
current durability vs. an unidentified second field) aren't confirmed against
an on-screen value yet either.

Net effect on the priority order below: **re-derive before reuse** now
applies across Recipe C too, not just E. Whoever continues should budget a
live `scan_aob` sweep per cheat before assuming any extracted trainer
signature is still valid, and treat every subsequent "recipe" pickup as a
fresh anchor hunt unless proven otherwise on this exact running build.

## Stamina anchor found — corrects an earlier assumption in this doc

Earlier in this doc: "Current Stamina/MaxSP is NOT in this struct" (i.e. not
in `PalIndividualCharacterSaveParameter`, the HP/Shield struct) — reasoning
was that the trainer's own script writes current stamina through a
different-looking symbol (`Param_SP` on `PC_CharacterParameterComponent`).
That symbol name is real, but this session found the actual live write site
by value-scanning for the on-screen Stamina number directly (int64 ×1000,
same `FixedPoint64` encoding as HP — confirmed exact: on-screen 110 read
back as raw `110000`) and write-watching that address. The setter is the
same shared `FixedPoint64::operator=` leaf as HP
(`Palworld-Win64-Shipping.exe+0x33604a0`), called this time from
`+0x2c2965e`:

```asm
Palworld-Win64-Shipping.exe+0x2c2965e: lea rcx, [rdi+0x4B0]   ; rcx = &Stamina
Palworld-Win64-Shipping.exe+0x2c66665: lea rdx, [rsp+0x50]    ; source value
Palworld-Win64-Shipping.exe+0x2c66... : call +0x33604a0        ; FixedPoint64::operator=
```

Checked whether `rdi` here is the *same* struct instance HP/Shield anchor to
(offset `+0x4B0` sits suspiciously close to HP's `+0x448`) — it isn't:
`rdi+0x448` and `rdi+0x4D0` both read `0`, not HP/Shield's live values, so
this is a different object with its own layout (consistent with the
`PC_CharacterParameterComponent`-not-`SaveParameter` claim after all — the
numeric proximity of `0x4B0` to `0x448` was coincidence, not evidence of a
shared struct). Whatever this object actually is, `+0x4B0` off of it is
confirmed, live, exact, twice (100 and 110 on-screen both matched).

**Shipped**: `palworld-capture-stamina-anchor` (internal capture patch,
captures `rdi` at `+0x2c2965e`, signature verified unique — 1 match) chained
to `Unlimited Stamina` (freeze at `captured+0x4B0`). Same caveat as every
other patch in this file: signature-unique and value-confirmed via MCP, not
yet installed through the actual app (needs a live Tamper session to confirm
the freeze holds without silently doing nothing, same discipline that caught
the `Never Hungry` mistake).

Method note for whoever continues: the value-scan approach that failed for
this same field earlier in the session (chat-latency race against a
continuously-regenerating stat, two rounds of `scan_first`/`scan_next`
returning no plausible survivor) worked on retry once the user could report
a she-said-go-live number immediately before the narrowing scan and the
stat was actively *decreasing* rather than recovering — timing matters more
than technique here. Async chat is a bad substitute for the app's own pause,
but a real second try with fresh values found it before regen finished.

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

# UE method calling via ProcessEvent (Phase 1c of the UE5 reflection bridge) — design

## Problem

The original `2026-09-03-ue5-reflection-design.md` scoped
`ueCallFunction` (main-app only, mirroring `monoCallAttached`) as part
of Phase 1 — calling a live `UFunction` on an object (e.g. triggering
an ability, granting an item) the way `mono_call.cc` already lets the
app call arbitrary Mono methods.

## Why this is a separate spec from the rest of Phase 1

Every other Phase 1 piece (`ueReflect.ts`'s decode/walk,
`UeTarget`/`ueTargetResolve.ts`) needed only the `GNames`/
`GUObjectArray` calibration numbers, which — while build-dependent —
are static data lookups: read some bytes, compute an address. Calling a
UFunction needs `UObject::ProcessEvent`'s **vtable slot index**, a
different kind of unknown: it's not data sitting in memory to be found
by a byte-pattern scan of known strings, it's *which vtable slot number*
a given build's compiler assigned to a specific virtual function — and
unlike `GNames`'s calibration (four numbers, checkable against a known-
correct decode of `"None"`), there is no static way to verify a
candidate slot number is right without actually *calling through it*
and observing whether the target crashes or behaves correctly. This is
the same class of risk `mono_bridge.cc`'s own history warns about
(`MonoCallAttached`'s design doc note: "a bad pointer argument crashes
the game, not just the call") — but worse, because a wrong vtable slot
doesn't just fail cleanly, it calls *some other virtual function
entirely* with unrelated arguments, which is a much more dangerous
failure mode than a null/garbage pointer.

**This spec is deliberately design-only — no code ships against this
spec until a live UE5 game is available to find and verify the slot
number against.** Documenting the mechanism now means whoever picks
this up next (with a live game) has a concrete plan rather than a
green field, matching this project's own established pattern for
"spec what's knowable now, defer what needs live iteration" (see
`2026-09-03-ue5-reflection-design.md`'s own "Open items for whoever
picks up Phase 1" section, which this spec is one item off of).

## Design

### Finding `ProcessEvent`'s vtable slot (manual, live-verification-gated)

No community-published "universal" slot number is trustworthy to
hardcode — UE4SS's own documentation and Dumper-7's `Offsets.cpp`
(both consulted for `2026-09-17-ue-reflection-decode-design.md`) treat
this as a per-build constant found by scanning, not a stable ABI fact.
The recipe, once a live UE5 process is available:

1. Resolve any `UObject` instance's vtable pointer (`UObjectBase` has
   no explicit vtable field in the struct layout this project already
   confirmed — it's implicit as the first 8 bytes of the object, C++
   ABI convention for a class with virtual functions).
2. `UObject::ProcessEvent(UFunction* Function, void* Parms)` has a
   recognizable calling convention at its call sites: every Blueprint-
   callable function invocation in compiled game code calls through
   this slot with a `UFunction*` first argument. Find one real call
   site (e.g. disassemble around a known, frequently-called
   Blueprint event like `Tick` or `ReceiveBeginPlay`) and read which
   vtable slot the `call [rax+N]`-shaped instruction uses — this is
   the same "read the actual compiled code, don't guess a formula"
   discipline this project's `authoring-tamper-cheats` skill already
   documents for anchor discovery generally.
3. **Verify before trusting**: call through the candidate slot with a
   known, side-effect-free `UFunction` (if one can be identified) and
   confirm the result matches calling it a different, already-trusted
   way (e.g. its effect is independently observable in-game) before
   using it for anything real. This mirrors `MonoCallAttached`'s own
   "verify with a cheap, side-effect-free call first" rule exactly.

### `ueCallFunction` (once the slot is known and verified)

Mirrors `MonoCallAttached`'s shape (`mono_bridge.h:50`, main-app only —
never exposed via the read-only MCP server, same split every other
write/call primitive in this codebase already follows):

```
Napi::Value UeCallFunction(const Napi::CallbackInfo& info)
// (handle, objectAddress, functionAddress, paramsBufferHex) -> result buffer hex | null
```

Unlike Mono (where `mono_compile_method` gives a real, directly-callable
function pointer), `ProcessEvent` takes the **target object** as the
implicit `this`/receiver and the **`UFunction*`** as an explicit
argument — the actual function body isn't called directly; every UE
function invocation goes through this one dispatcher. So the native
call shape is: resolve `objectAddress`'s vtable, read the
`ProcessEvent` slot, call it with `(objectAddress, functionAddress,
paramsBufferAddress)` — `paramsBufferHex` is caller-supplied raw bytes
(a `UFunction`'s parameter struct layout is itself something the
caller must already know, out of scope for this bridge to introspect
automatically; matches how `call_remote_function`'s args are already
opaque hex the caller assembles).

**This needs actual remote code execution** (unlike the rest of Phase
1) — `ProcessEvent` must run on a real game thread, not be read
directly like `UClass`/`FProperty` metadata. Reuses
`RunRemoteCall`/the `call_remote_function` primitive family already
built for IL2CPP (`mono_call.cc`), not a new injection mechanism —
the "call an arbitrary address with pointer args on a throwaway
thread" primitive is exactly as generic as `2026-09-07-il2cpp-symbol-
resolution-design.md` already found it to be.

### Landmines to carry over from the two prior bridges

- **A wrong `paramsBufferHex` layout crashes the target**, same
  severity as `mono_call.cc`'s bad-pointer landmine — `ProcessEvent`
  writes return values back into the same buffer it reads arguments
  from, so an undersized buffer is a real out-of-bounds write in the
  game process, not just a bad read.
  - **A wrong vtable slot calls a DIFFERENT virtual function with the
  wrong arguments** — strictly worse than a null pointer (which fails
  visibly) because it can silently do something unrelated and harmful
  before anyone notices the slot was wrong.
- Space out calls, same thread-churn caution
  `authoring-tamper-cheats/SKILL.md` already documents for
  `call_remote_function`.

## Non-goals

- No MCP tool exposure — main-app only, same split as `MonoCallAttached`.
- No automatic `UFunction` parameter-struct layout introspection —
  caller-assembled raw bytes, same as `call_remote_function`'s
  existing args convention.
- No implementation in this pass — this document is the plan for
  whoever has a live UE5 game to verify against.

## Testing

Blocked on a live UE5 process for the one part that actually matters
(is the vtable slot correct) — no synthetic mock can validate a vtable
slot guess, since the whole risk is "this number looks plausible but
calls the wrong function," which only manifests against real compiled
game code. Once a slot is found and provisionally verified, the
`RunRemoteCall`-shaped plumbing around it is unit-testable the same way
`mono_call.cc`'s equivalent already is (a static-binary test harness
call, not a live game) — only the slot-number *discovery* step is
irreducibly live-only.

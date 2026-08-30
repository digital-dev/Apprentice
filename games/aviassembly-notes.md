# Aviassembly — investigation notes

**Update:** the `Singleton<T>` blocker below is fixed. `games/aviassembly.json`
now has working cheats. This file is kept as a record of what was broken, what
fixed it, and what's still open — read it before touching the mono tooling or
this profile again.

**Game**: Unity 6000.0.69 (Mono, not IL2CPP), Steam, Facepunch.Steamworks.
Build/model your own airplane, fly cargo contracts. `mono-2.0-bdwgc.dll` is
the runtime.

## The two tooling bugs that blocked everything (both fixed)

Every economy/state manager (`MoneyManager`, `ResearchManager`,
`PlaneContainer`, `GameManager`, ...) is a MonoBehaviour that inherits Unity's
generic `Singleton<T>` for its static instance pointer — the class itself
declares no static field of its own. Two separate native-tooling bugs made
this and method listing look unreachable:

1. **`mono_list_method_names` returned `[]` for every class, always.** Root
   cause: `mono_class_get_methods` needs the class's metadata fully set up
   first (`mono_class_setup_methods`, triggered by `mono_class_init`) —
   `mono_class_get_fields` happens not to need this, which is why field
   listing looked fine while method listing looked universally broken. Fix:
   `native/src/mono_bridge.cc`'s `BuildMemberListStub` now calls
   `mono_class_init(classHandle)` once, right after attach, before the
   iteration loop (optional — skipped if the export is absent, matching
   every other "older Mono build" fallback in that file).

2. **`mono_static_field_address` couldn't resolve an inherited static field**
   (`Singleton<T>`'s `m_Instance`). Two compounding causes:
   - The old resolver (`ResolveMemberSingleThread`/`BuildMemberSearchStub`)
     manually iterated `mono_class_get_fields` and string-compared names —
     that iterator only ever sees a class's OWN declared fields, never a
     parent's. Fixed by replacing it with `ResolveMemberByNameSingleThread`,
     which calls Mono's own `mono_class_get_field_from_name` /
     `mono_class_get_method_from_name` directly — those walk the class
     hierarchy in Mono's native code, including to an inflated generic
     parent like `Singleton<MoneyManager>`.
   - Even with the field found, using the ORIGINAL class's vtable
     (`mono_class_vtable(classHandle)`) to locate the static-data blob was
     wrong for an inherited field: C# static-field storage is never
     duplicated per subclass, so it belongs to whichever class actually
     DECLARES the field. Fixed with a new dedicated resolver
     (`ResolveStaticFieldAddressSingleThread` / `BuildStaticFieldAddressStub`)
     that calls `mono_field_get_parent(fieldPtr)` to get the field's real
     owning class, and composes the vtable/static-data address off of
     *that*, not the originally-passed classHandle.

Both fixes are native-only (`native/src/mono_bridge.cc`), covered by
`tests/native/mono_bridge.test.ts` (the fake host, `test-harness/probe_mono.c`,
needed `mono_class_get_field_from_name`, `mono_class_get_method_from_name`,
`mono_class_init`, and `mono_field_get_parent` added to it — none existed
before), and verified live against the real game: `MoneyManager.money`,
`ResearchManager.researchPoints`/`advancedResearchPoints`, and
`PlaneContainer`'s fields all resolve and read back values matching the
in-game HUD in real time.

## Field map (confirmed live, current as of this write-up)

| Class | Field | Type | Notes |
|---|---|---|---|
| `MoneyManager` | `money` | `float` | Not int32 — this was *also* why 6 straight int32 value-scans failed before the Singleton<T> fix existed. Save-format cross-reference: [L-at-nnes/aviassembly-tools](https://github.com/L-at-nnes/aviassembly-tools) (legit save-file editor, no scam links). |
| `ResearchManager` | `researchPoints` | `int32` | "scrap" in the save format |
| `ResearchManager` | `advancedResearchPoints` | `int32` | "advancedScrap" |
| `PlaneContainer` | `fuel` / `fuelCapacity` | `float` | current / max |
| `PlaneContainer` | `electricity` / `electricityStorageCapacity` | `float` | current / max |
| `PlaneContainer` | `mass` | `float` | |
| `PlaneContainer` | `<cargoVolume>k__BackingField` | `float` | property-backed field — needs the literal `<Name>k__BackingField` form |
| `PlaneContainer` | `controller` | object ref | → `PlaneController` instance |
| `PlaneController` | `<Exploded>k__BackingField` | `int8`/bool | reached via `PlaneContainer.controller` (two-hop) |

`PlaneContainer` is also `Singleton<T>`-based and holds the currently
active/built plane — this is the root the whole Vehicles cheat category
needed and didn't have before.

## What's in `games/aviassembly.json` now

Unlimited Money, Set Research Points, Set Advanced Research Points,
Unbreakable Plane (two-hop via `PlaneContainer.controller` +
`pointerFieldOffset`), Unlimited Cargo Space, Unlimited Fuel (freezes both
`fuel` and `fuelCapacity` together so the UI bar doesn't look broken),
Unlimited Electricity (same pattern), Low Plane Mass.

## Still open — needs patch-mode (`scale`/`guard`), not a field freeze

`mono_list_method_names` now works, which is the one thing this whole list
was blocked on — none of these are structurally hard anymore, just
unstarted:

- **Money Spent % / Money Gain Multiplier**: `MoneyManager.ChangeMoneyAmount`
  is the method (confirmed to exist: `["Start","ChangeMoneyAmount",
  "HasEnoughMoney","Save","Load",".ctor"]`). Needs `mono_compile_method` to
  get its JIT'd entry address, then disassemble to find the actual
  add/subtract instruction to scale — same technique as Valheim's
  `mono-damage-multiplier` patch.
- **Fuel/Electricity Consumption %**: same idea, on whatever method decrements
  `fuel`/`electricity` per tick (not yet identified — check `PlaneContainer`'s
  `FixedUpdate`/`ApplyLiniarDrag` or similar).
- **No Wing Stress / Wing Stress Resistance**: needs the `Wing` class's own
  stress field/method — not yet inspected. `PlaneContainer.planeParts` holds
  the part list; reaching a *specific* part instance (not just the container)
  isn't expressible in the current `MonoTarget` schema (no array-index hop),
  so this may need a different approach (an AOB-anchored patch inside `Wing`
  itself, keyed off `this`, rather than a value-freeze target).
- **Plane Mass %**: `Low Plane Mass` (a freeze) is in the profile now as a
  practical stand-in; a true scale-mode version would patch `ChangeMass`.

## Process stability (unrelated to any of the above)

Aviassembly crashed repeatedly early in this investigation — faults inside
`mono-2.0-bdwgc.dll` (`0xc0000005`) and once in `KERNELBASE.dll`
(`0xe0000001`), per Windows Event Log. Ruled out the scanning tool as cause
(read-only, skips `PAGE_GUARD`, no writes) — more likely this build is just
unstable on its own. Didn't recur once the session moved off blind scanning
onto direct mono resolution.

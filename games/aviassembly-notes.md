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

## Survey of live singletons (2026-09-20) and drafted candidates

`mcp-server/scripts/surveyMono.js` lists every game class with a live `Singleton<T>` instance (32 in a loaded save) with
field offsets and current values. `author_cheats` now also finds these roots (inherited `m_Instance`), so it drafts
`Unlimited Money` on its own. It has no plane-game categories, so the rest came from the survey, then
`scripts/monoReaders.js` (compiles a class's methods, prints who touches an offset, with context) checked the code.

**Code-supported, drafted in `aviassembly.draft.json` (not run in-game):**

| Draft | Field | Evidence |
|---|---|---|
| Weightless Fuel | `PlaneContainer.fuelWeight` (0.4) | `FuelTank.UpdatePart` and `GetPartStats` read `[container+0x80]` from the container singleton |
| Low Drag | `DragSimulator.dragMultiplier` (1.2) | `DragSimulator.CalculateDragFactor` multiplies its result by `this+0x4C` |

**Leads with no reader found (not drafted):**

| Field | What the search showed |
|---|---|
| `PlaneContainer.liftMultiplier` (1.0, +0x74) | written in `Awake`, read in `GetLiniarDamping`. The lift force path, `Wing.GetMaxLiftForce`, reads its own `this+0x74`, so an effect on lift is not shown |
| `PlaneContainer.planeGravityMultiplier` (1.5, +0x6c) | no reader in PlaneContainer, PlaneController, FuelTank, PlaneStats, Wing, Engine, Airbreak, Balloon, Fuselage, PartDrag, AirTurbine |
| `Map.useFogOfWar` (1, +0xb8) | no reader in Map, FogOfWar, MapBackground, MapIcon, AirportMapIcon, MapInspector |
| `GameManager.unlockRaces` (0, +0x64) | only hit is `GameManager.Load` using +0x64 as an int counter, which contradicts a bool |

Also seen: `PlaneContainer.ApplyAngularDrag` reads `yawDrag`/`pitchDrag`, another drag knob.

Stability: the game crashed (`0xe0000001` in KERNELBASE) shortly after the first survey, the same signature as the early
crashes above; it survived the light check and eight `monoReaders` runs over the classes named here. Treat heavy passes as a
possible trigger.

## Unlimited Cargo Space was a dead field (fixed 2026-09-20)

The original cheat froze `PlaneContainer.<cargoVolume>k__BackingField`. Nothing reads it: it read 150.99 while the real
capacity was 40, and no cargo, contract or stats class calls `get_cargoVolume` or `ChangeCargoVolume`. The capacity is
computed fresh: `CargoInventory.Update` does `this+0x50 (<MaxVolume>) = planeContainer.GetCargoVolume()` every frame, where
`GetCargoVolume` sums the plane's cargo parts. A freeze on `MaxVolume` would lose to that per-frame write, so the cheat is now
a `force` patch (`monoClass CargoInventory`, `monoMethod Update`, `monoMethodOffset 0x45`) on the store
`movss [rsi+0x50], xmm5`, the same shape as Valheim's Infinite Weapon Durability. Bytes at the site verified live; not run in-game.

Lesson: a field that reads a plausible number is not a lever. Find its readers (`scripts/monoReaders.js`, `CALLEE=` for
callers) before shipping a freeze. `Unlimited Fuel`, `Unlimited Electricity` and `Low Plane Mass` were not re-checked this way.

## Weightless Cargo (2026-09-20)

`CargoInventory.GetCargoMass` sums `CargoType.weight * count` over `currentCargo`. Its only caller is
`PlaneContainer.ReInitializePlane`, which sets the rigidbody mass to `rb.mass + GetCargoMass() / K`. The `replace` patch
`mono-weightless-cargo` swaps the 4-byte `cvtss2sd xmm1, xmm0` at `ReInitializePlane+0x19b` (the instruction that takes the cargo
mass) for `xorpd xmm1, xmm1`, so the cargo term is zero and nothing else changes. Bytes at the site verified live; not run in-game.
Because it acts inside `ReInitializePlane`, it takes effect the next time the plane is re-initialised (loading in, or whatever
triggers that call), not instantly mid-flight. Which events call `ReInitializePlane` was not traced.

## Unbreakable Plane was a dead flag (fixed 2026-09-20)

The old cheat froze `PlaneController.<Exploded>` at 0. `ExplodePlane` sets that flag only after it has already spawned the
effects and broken the plane, so holding it at 0 undoes nothing. Breakage paths found with `monoReaders.js CALLEE=`:

- `Wing.ApplyLift` calls `PartExploder.ExplodePart` (wing overstress).
- `Wheel.CheckWheelFailure` calls `PartExploder.ExplodePart` twice (wheel failure).
- `PartExploder.ExplodePlane` calls `ExplodePart` for each part, and `PlaneController.ExplodePlane` calls it (crash).

Two `replace` patches now turn the entry of each into `xor eax,eax; ret; nop` (`55 48 8b ec` -> `33 c0 c3 90`, two whole
instructions, no stack change yet): `mono-unbreakable-plane` on `PlaneController.ExplodePlane` (keeps the `num4` hotkey) and
`mono-unbreakable-parts` on `PartExploder.ExplodePart`. Bytes and signatures verified live; not run in-game.

Not found: what calls `PlaneController.ExplodePlane` (no direct call from any part, plane, game or terrain class, so probably a
Unity event or a virtual call). `maxTriggerVelocity` / `minTriggerVelocity` on `PlaneController` suggest a velocity-based
crash check, but no code reads them in `PlaneController`. If a crash still ends the flight with both patches on, that trigger
is where to look next.

## Second pass on the open leads (2026-09-20)

- **Low Gravity (`planeGravityMultiplier`, +0x6c): reader found, cheat not useful.** `PlaneContainer.get_GravityMultiplier` lerps
  `planeGravityMultiplier` / `helicopterGravityMultiplier` by the `+0x48` blend; `get_RealGravity` is `gravityForce * GravityMultiplier`
  and `PlaneContainer.FixedUpdate` applies it. But `Wing.GetLiftForce` multiplies its result by the same `GravityMultiplier`, so lowering
  it scales gravity and wing lift down together and the flight balance barely moves. Not shipped.
- **Extra Lift (`liftMultiplier`, +0x74): wrong field.** Its only reader is `GetLiniarDamping`; `Wing.GetLiftForce` never reads
  `+0x74` of the container. A real lift lever is the value `Wing.GetLiftForce` returns (a scale patch on `xmm0` before its final
  `call r11`, signature with the `49 bb ?? x8` immediate wildcarded), but `Wing.ApplyLift` does not call either `GetLiftForce` overload
  or `GetMaxLiftForce` by direct call, so which method actually produces the applied lift is unresolved. Not shipped.
- **No Fog of War (`Map.useFogOfWar`, +0xb8):** no method of Map, FogOfWar, the map icon classes, airport classes or the game-mode
  classes reads it (it may be written only). Fog is texture-based (`FogOfWar.discoveredPartitions`, `AddNewLocation`), so a
  reveal-map cheat would come from there. Not shipped.
- **Unlock Races (`GameManager.unlockRaces`, +0x64):** still no reader.

`monoReaders.js` `CALLEE=` now takes several addresses. `GetLiftForce` has two overloads and `monoCompileMethod` resolves by name
only, so it returns the first; a lift patch needs the overload picked by signature.

Decision (2026-09-20): Extra Lift is dropped as moot. Low Plane Mass and Weightless Cargo already remove the weight the lift would have to carry. Low Gravity stays dropped for the reason above.

# UE target wiring (Phase 1b of the UE5 reflection bridge) — design

## Problem

`2026-09-17-ue-reflection-decode-design.md` shipped `mcp-server`'s
read-only `ueReflect.ts` (decode an FName, walk a `UStruct`'s
properties, resolve a `UClass` by name) plus MCP tool wrappers for
live investigation. None of that is reachable from a cheat definition
yet — there is no `UeTarget` a `games/*.json` profile can use, the way
`MonoTarget`/`AnchorTarget` already work. This closes that gap: a cheat
can name a UE class + field and have `writeCheat`/`verifyCheat` resolve
and write it every tick, mirroring `MonoTarget`'s whole shape.

## Non-goals

- No `GNames`/`GUObjectArray` auto-discovery — still config, per the
  prior spec. This phase adds where that config lives (the profile),
  not how it's found.
- No method calling (`ueCallFunction`) — separate spec
  (`2026-09-17-ue-call-function-design.md`), blocked on a different
  unresolved calibration number (`ProcessEvent`'s vtable slot).
- No renderer UI — separate spec
  (`2026-09-17-ue-explorer-ui-design.md`). This phase is store schema +
  main-process resolution only, the same slice size Mono's own first
  landing was (`monoResolveClass`/`monoTargetResolve.ts` shipped before
  `MonoExplorer.tsx` existed).

## Design

### `UeConfig` — new profile-level field

Add to `GameProfile` (`src/main/profile.ts`):

```ts
export interface UeConfig {
  gNames: {
    gNamesBase: string
    blockOffsetBits: number
    nameEntryStride: number
    stringOffset: number
    headerOffset: number
    lengthShiftCount: number
  }
  gObjectArray: {
    chunksArrayBase: string
    numElementsPerChunk: number
    itemStride: number
    itemInitialOffset: number
  }
}

export interface GameProfile {
  schema: 2
  exe: string
  modules: Record<string, ModuleFingerprint>
  cheats: StoredCheat[]
  // Calibration numbers for this game's build, found once via the manual
  // recipe in 2026-09-17-ue-reflection-decode-design.md. Absent means no
  // UeTarget in this profile can resolve (same "not live yet" null-return
  // convention every other resolver here already uses) -- every profile
  // saved before this field existed keeps loading and working unchanged.
  ueConfig?: UeConfig
}
```

No schema version bump: this follows the same incremental-optional-
field convention `CheatDefinition.offValue`/`captureOriginal` already
established — an absent field means "not using this feature," not "old
file, reject it."

### `UeTarget` — new `CheatTarget` variant (`src/main/store.ts`)

```ts
export interface UeTarget {
  kind: 'ue'
  className: string
  fieldName: string
  // GUObjectArray scan is bounded, same reasoning as ueReflect.ts's
  // resolveClass -- no silent default, a caller (here, the profile
  // author) must say how far to look.
  maxObjectsToScan: number
  // Per-target override, same convention as every other CheatTarget kind.
  value?: number
  dataType?: DataType
  bitIndex?: number
}
```

Added to `CheatTarget = ChainTarget | AnchorTarget | MonoTarget | UeTarget`,
with a matching `isUeTarget` type guard alongside the existing
`isAnchorTarget`/`isMonoTarget`.

**Why `className`+`fieldName` every resolve, not a cached class
handle**: `AnchorTarget` capture points are per-object-instance and
`MonoTarget` re-resolves its class every call already (`resolveMonoTarget`
re-runs `resolveClass` each tick, not just once) — `UeTarget` matches
that existing precedent rather than inventing a caching scheme, and a
`UClass` object's own address is launch-stable within a session anyway
(it's not per-instance heap data), so the repeated `resolveClass` walk
costs a bounded scan, not a correctness risk.

### `src/main/ueTargetResolve.ts` — new file

Direct port of `mcp-server/src/ueReflect.ts`'s pure functions (same
duplication-over-cross-package-import reasoning `cheatVerify.ts`
already established for `monoTargetResolve.ts` — `mcp-server` and the
main app are independent packages with no shared-lib precedent between
them). Exports:

```ts
export function resolveUeTargetAddress(
  target: UeTarget,
  handle: number,
  config: UeConfig,
  readBytes: (address: string, length: number) => string | null
): string | null
```

Internally: `resolveClass(readBytes, config.gObjectArray, config.gNames, target.className, target.maxObjectsToScan)`,
then `resolveField(readBytes, config.gNames, classAddress, target.fieldName)`
to get the offset, then... **a field's offset is relative to an
*instance*, not the `UClass` object itself** — resolving a `UeTarget`
only gets you the class and the field's byte offset within any instance
of it, not a concrete address to read/write. Every other `CheatTarget`
kind reaches a concrete address (an `AnchorTarget`'s captured pointer, a
`MonoTarget`'s static field's own storage, or the object it points to).
`UeTarget` has no static-field equivalent to anchor on — UE's `UClass`
default-object (`ClassDefaultObject`, confirmed at `+0x110` in the
existing struct layout) is the closest analog, but writing to the CDO
changes every future instance's *default*, not any live instance's
*current* value, which is not what a cheat wants.

**Resolution**: `UeTarget` needs a companion anchor, exactly like
`AnchorTarget` already needs a `capture`-mode `PatchCheat` for its
pointer. Add `instanceAnchorPatchId: string` to `UeTarget` — a
capture-mode patch (found via this project's existing live-RE playbook,
completely unrelated to reflection) that captures a live instance
pointer of the target class. `resolveUeTargetAddress` becomes:

```ts
export function resolveUeTargetAddress(
  target: UeTarget,
  handle: number,
  config: UeConfig,
  instancePointer: string, // from patchEngine.slotAddress(target.instanceAnchorPatchId), same as resolveAnchor
  readBytes: (address: string, length: number) => string | null
): string | null {
  const classAddress = resolveClass(readBytes, config.gObjectArray, config.gNames, target.className, target.maxObjectsToScan)
  if (classAddress === null) return null
  const field = resolveField(readBytes, config.gNames, classAddress, target.fieldName)
  if (field === null) return null
  return addHex(instancePointer, field.offset)
}
```

This makes `UeTarget` genuinely a hybrid of `MonoTarget` (name-based
field resolution) and `AnchorTarget` (instance pointer from a capture
patch) — which matches reality: UE reflection gives you the *shape*
(class, field offsets), never a live object to read, the same way
`AnchorTarget`'s whole reason to exist is that Palworld's IL2CPP/native
code has no live introspection API to find an object through either.

### `ipc.ts` wiring

`resolveUeTarget(handle, target)` (mirrors `resolveMonoTarget`,
`ipc.ts:246`): loads the current profile's `ueConfig` (via
`loadProfile`/`hasProfile`, already imported), returns `null` if
absent (routine — "not configured for this game yet," not an error,
matching every other "can't resolve right now" outcome in this file),
else resolves the `instanceAnchorPatchId`'s slot (`patchEngine.slotAddress`,
same call `resolveAnchor` already makes) and calls
`resolveUeTargetAddress`. Added as a new branch in `writeCheat` and
`verifyCheat`'s per-target `if (isAnchorTarget...) / if (isMonoTarget...)`
chains, same shape as the existing two.

## Testing

`ueTargetResolve.ts`'s pure resolution logic is unit-tested exactly
like `mcp-server/tests/ueReflect.test.ts` already tests the ported
formulas (synthetic byte fixtures, no live process) — this phase adds
one more layer of test: given a fixed `instancePointer` and `UeConfig`,
confirm `resolveUeTargetAddress` returns `instancePointer + offset`.
`ipc.ts`'s `resolveUeTarget` wiring is tested the way `resolveMonoTarget`
already is elsewhere in this codebase's `ipc.test.ts`-equivalent
coverage — with a fake profile/patchEngine, not a live game.

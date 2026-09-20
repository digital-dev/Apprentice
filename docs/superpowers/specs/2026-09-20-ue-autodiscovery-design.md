# UE auto-discovery and root-path targets — design

## Problem
`UeTarget` needs a hand-calibrated `ueConfig` with absolute addresses (GNames base, chunk array pointer). Both change every
session (ASLR, heap), and it also needs a capture patch for the instance. So no UE game can ship reflection cheats.
Found on Palworld (2026-09-20, `games/palworld-notes.md`): both roots are findable from code, the name layout can be
probed, and live instances are reachable by walking GUObjectArray.

## Design
1. **Discovery (`src/main/ueDiscover.ts`, pure, deps injected: `readBytes`, `scanAob`).** Nothing session-specific is stored.
   - GNames: scan the main module for the FName-pool init guard
     `48 8D 05 ?? ?? ?? ?? EB ?? 48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? C6 05 ?? ?? ?? ?? 01`; the `lea` target is the pool.
     Layout numbers are probed over {blockOffsetBits 16/14} x {stride 2/4} x {stringOffset 2/6} x {lengthShift 6/1};
     accepted only when index 0 decodes to `None` and index 1 to `ByteProperty`.
   - GUObjectArray: scan for `48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1` (chunk lookup); the loaded global holds the
     chunk array pointer. Item stride probed over {24, 16}; accepted only when class `Object` resolves.
   - The result is the existing `UeConfig` shape, cached in memory per attach. A profile `ueConfig` still wins if present.
2. **Root-path targets.** `UeTarget` gains `rootClass`, optional `path` (reflected pointer fields to follow) and `fieldName`.
   `instanceAnchorPatchId` becomes optional; a target has one or the other. Resolution finds the root class, takes its first
   live non-`Default__` instance, follows each `path` field by name (offset looked up on the object's own class, walking
   `SuperStruct`, because members like `CharacterMovement` live on parents), then adds the final field's offset.
3. **Cost.** The GUObjectArray walk is cached per target (instance address + class pointer); the cache entry is dropped and
   re-resolved when the class pointer at the instance no longer matches or a path pointer is null.
4. **Failure.** Everything returns `null` ("not live yet") like every other resolver; discovery runs lazily and async on the
   first UE target use, the first tick(s) resolve to null.

## Non-goals
No per-game signature UI, no `ProcessEvent` calls, no writes during discovery (read-only scan).

## Testing
Unit tests on a fake in-memory process (existing `FakeMemory` style): layout probing, both roots, superclass field lookup,
path following, instance cache invalidation. Live check on Palworld with the MCP tools.

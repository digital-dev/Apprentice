# IL2CPP cheat factory — design

Extends `2026-09-19-cheat-factory-design.md` (Mono) to Unity/IL2CPP so
`author_cheats` produces persistent cheats for both. Reuses that spec's
category table, ranker and draft-builder conventions.

## Problem

`author_cheats` refuses IL2CPP games. The existing IL2CPP recipe
(`2026-09-07-il2cpp-symbol-resolution-design.md`) resolves a symbol you
already know; nothing enumerates, ranks, or drafts cheats. A persistent
IL2CPP cheat in this project is two profile entries (see
`games/Schedule I.json`): an internal `capture` patch at a method in
`GameAssembly.dll` that records `this`, and a value cheat whose `anchor`
target writes at a field offset off that captured pointer (recipe D).

## Verified layout (Unity 2022.3.62, Schedule I, live probe 2026-09-19)

Every offset below was read from the running game and cross-checked
(a field's parent pointer equals its class; `onlineBalance` came out at
`0x128`, the same offset the shipped Infinite Money cheat was hand-hunted
for). Layouts are per Unity version: the tool re-verifies them per run
and refuses to draft if a cross-check fails.

| Struct | Offset | Field |
|---|---|---|
| `Il2CppClass` | +0x00 | image |
| | +0x10 / +0x18 | name / namespace (`const char*`) |
| | +0x58 | parent class |
| | +0x80 | `FieldInfo*` array (contiguous, stride 0x20) |
| | +0x98 | `MethodInfo*` array (pointers into contiguous records, stride 0x58) |
| | +0xB8 | static-fields block pointer |
| | +0x120 / +0x124 | `method_count` / `field_count` (u16) |
| `FieldInfo` | +0x00 / +0x08 / +0x10 / +0x18 | name, `Il2CppType*`, parent class, offset (i32) |
| `Il2CppType` | +0x08 (u16) / +0x0A (u8) | attrs (0x10 = static) / type enum (0x0C = float) |
| `MethodInfo` | +0x00 / +0x18 / +0x20 | `methodPointer` / name / class |
| | +0x4C (u16) / +0x52 (u8) | flags (0x10 = static) / parameter count |
| `Il2CppObject` | +0x00 | class pointer (gives an instance's exact class) |

The class list of an image is one contiguous pointer table (found by
scanning memory for class 0's pointer and checking the next qword is class
1), so all classes are one read, not one remote call each.

## Design

Pure, unit-tested modules under `mcp-server/src/factory/`:

1. **`il2cppLayout.ts`** — byte decoders for the structs above plus the
   type-enum to `DataType` map (R4 → float, I4 → int32, ...).
2. **`il2cppBootstrap.ts`** — finds the class table. Four remote calls
   (`il2cpp_domain_get`, `il2cpp_domain_assembly_open`,
   `il2cpp_assembly_get_image`, `il2cpp_image_get_class_count`) plus two
   `il2cpp_image_get_class` calls, then a scan. Everything after is memory
   reads. Nothing calls `class_get_fields`/`class_get_methods`: struct reads
   avoid both the folded-stub landmine and per-item remote threads.
3. **`il2cppEnumerator.ts`** — for classes matching the wishlist's class
   hints: fields (name, offset, data type, static flag), methods (pointer,
   static flag), and live singleton roots (static fields named like
   `Instance`/`Local` whose value is non-null; the instance's exact class
   comes from its `Il2CppObject` header).
4. **`hookSite.ts`** — picks a method on a field's class for the capture
   patch and builds its persistent signature.
5. **`il2cppBuild.ts`** — orchestration per category, emitting a
   capture patch (one per class) plus an anchor value cheat.

`ranker.ts` becomes generic over the candidate type so extra fields
(offset, data type) survive ranking. Type fit is now available: a field is
a candidate only if its type maps into the category's allowed data types,
and static fields are skipped.

### Hook-site rules

A method qualifies when all hold:
- non-static, not `.ctor`/`.cctor`, `methodPointer` inside `GameAssembly.dll`;
- the first bytes are not already a detour (`e9`, `eb`, `ff 25`,
  `48 b8`): this game runs MelonLoader/Harmony, which rewrite prologues;
- whole instructions cover at least 5 bytes, none rip-relative or a
  relative branch (they cannot be replayed from a cave);
- a signature of the method's leading bytes, with rip-relative and
  relative-branch displacements wildcarded, matches exactly once and the
  match is the method start. Lengths 16/24/32/48/64 are tried in order.

Update-style names (`Update`, `FixedUpdate`, `LateUpdate`) are tried first
so the capture fires constantly.

### Verification

- **Singleton-backed cheats:** if a live root's instance class equals (or
  derives from) the field's class, read `instance + offset` with the field's
  own data type and require a plausible value. Reported `verified: true`.
- **Others:** drafted with `verified: false`, meaning "only the in-game
  pass confirms it", and a `multiInstanceRisk` flag, since a capture hook
  records whichever instance ran last.
- Anchor cheats cannot be verified by `verify_cheat`, so the checklist is
  mandatory for these.

## Output

`author_cheats` dispatches on `fingerprint_process`: Mono → existing path,
`unity-il2cpp` → this path, anything else → error naming the playbook.
Drafts go to `<profile>.draft.json` (patches then cheats, plus the
`modules` fingerprint block), never the live profile.

## Non-goals

- No game-memory writes; the only write is the draft file.
- No `il2cpp` target kind in the Electron app; drafts use existing patch
  and anchor machinery.
- No static-field cheats (their values live in the statics block, a
  different mechanism) and no Unreal support.
- No attempt to disambiguate multiple live instances of a class.

## Testing

- Unit: decoders and enumerator run against byte fixtures captured from the
  live Schedule I probe; hook-site and builder run against a fake memory map
  with scripted disassembly and AOB results.
- Live: run on Schedule I and compare with `games/Schedule I.json`: the
  money category must resolve `MoneyManager.onlineBalance` at `0x128`.

## Amendments (found during the first live run on Schedule I)

- **The addon caps a read at 4096 bytes** (8192+ return null, not a short
  read). Every IL2CPP read goes through `chunkedRead`. The unit-test fakes
  had no cap, which is why this only showed up live.
- **Verification has three tiers, strongest first.**
  1. *Singleton root*, or a component the root object references (its
     qwords are scanned for a pointer whose object header is the wanted
     class, bounded by the class's `instance_size` at `+0xF8`). Authoritative:
     an implausible read rejects the candidate; a zero is accepted.
  2. *Instance scan* for classes no root reaches (e.g. singletons on a
     generic base class, whose per-instantiation class is not in the image
     table): scan memory for the class pointer, keep hits whose monitor
     word is null (metadata records have a non-null word there). Not
     authoritative: requires a plausible **non-zero** value, since zero is
     what stray hits read as, and failure only leaves the cheat unverified.
  3. *Nothing reachable*: drafted unverified for the in-game pass.
- **`instanceCount` is an upper bound.** Freed objects still in memory also
  match the scan. `multiInstanceRisk` is false only for tier 1, or a scan
  that found exactly one instance.
- **Field cheats are the wrong shape for some categories.** Two categories the
  factory drafted did not work in-game and are now `manualReview`:
  `nosearch` (police decide per officer; the lever is a method-level `replace`
  at the function every search route shares) and `cash` (an item instance
  with hundreds of look-alikes: hook a per-frame method on the holder singleton
  and reach the item with an anchor `derefOffset`). Both are documented in the
  authoring skill's evidence-loop section.
- **Tamper gained `derefOffset` on anchor targets** (`src/main/anchorResolve.ts`):
  follow a pointer field of the captured object before adding `offset`.
- **Live result (Schedule I):** money `MoneyManager.onlineBalance` `0x128`
  (matches the shipped cheat; read 56174.875), health
  `PlayerHealth.<CurrentHealth>k__BackingField` `0x11c` (100, via
  `Player.Local`), stamina `PlayerMovement.<CurrentStaminaReserve>k__BackingField`
  `0x4c` (100). Three capture patches on each class's `Update`, each with a
  signature that matched exactly once. `godmode` and `mana` correctly found
  nothing (no such fields); `hunger`/`speed` reported as manual.

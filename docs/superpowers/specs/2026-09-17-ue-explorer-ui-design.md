# UE Explorer UI (Phase 1d of the UE5 reflection bridge) — design

## Problem

`2026-09-17-ue-target-wiring-design.md` gives `UeTarget` cheats a real
resolution path, but authoring one means hand-writing JSON (class name,
field name, the ten `UeConfig` calibration numbers, a capture-patch
id) — no UI, unlike `MonoExplorer.tsx`'s point-and-click class/field
picker for `MonoTarget`. This specs the renderer screen that closes
that gap.

## Why this isn't a straight `MonoExplorer.tsx` copy

Mono's explorer leans on two things UE reflection doesn't have:

1. **Cheap full enumeration.** `mono_list_assembly_names` /
   `mono_list_classes_in_image` walk Mono's own metadata tables
   directly — fast, and naturally scoped (pick an assembly, browse its
   ~dozens-to-hundreds of classes). UE's only enumeration path is a
   linear `GUObjectArray` scan (`resolveClass`'s `maxObjectsToScan`
   loop) — a real UE5 game can have 100,000+ live `UObject`s, so a
   "browse everything" list is neither cheap nor meaningfully
   scrollable the way Mono's per-assembly class list is. **This UI
   supports resolve-by-exact-name only, not browsing** — matching
   `MonoExplorer`'s *other* mode (typing a known name from a reference
   table) but not its browse mode, since UE has no cheap equivalent of
   "list every class in this one assembly."
2. **Zero-config resolution.** Every `mono_*` call only ever needs
   `monoDllBase`, already known from `fingerprint_process`. Every
   `ue_*` call needs the ten-number `UeConfig` on top of that, and
   that config doesn't exist until someone runs the manual calibration
   recipe from `2026-09-17-ue-reflection-decode-design.md` — no
   in-app way to auto-fill it. So this screen's first, mandatory
   section is a config editor, not a class search box.

## Design

New file `src/renderer/src/screens/UEExplorer.tsx`, reachable the same
way `MonoExplorer` is (a sidebar/nav entry, gated on a game profile
being loaded — mirrors `2026-08-07-sidebar-nav-design.md`'s existing
pattern, no new navigation mechanism).

### Section 1 — `UeConfig` editor

Ten labeled numeric/hex inputs (`gNames.*` × 6, `gObjectArray.*` × 4),
pre-filled from the current profile's `ueConfig` if present. A "Save"
button writes them via a new `ue:saveConfig` IPC channel
(`ipcMain.handle('ue:saveConfig', (_e, config: UeConfig) => ...)`,
mirroring `saveCheatWithFingerprint`'s pattern of writing into the
loaded profile and persisting via `saveProfile`). No validation beyond
"is this a well-formed hex string / integer" — this project's existing
principle (`authoring-tamper-cheats/SKILL.md`'s "verify before
shipping" discipline) already treats a wrong calibration number as a
live-testing problem, not something client-side validation can catch;
a plausible-looking but wrong `blockOffsetBits` value is exactly as
"valid" a number as a correct one.

**No config yet?** The panel shows the calibration recipe's summary
(3 numbered steps, linking to the design doc) instead of empty inputs
— someone landing on this screen for a fresh game needs to know this
isn't a resolve-and-go tool the way Mono's is.

### Section 2 — Resolve by name

Two text inputs (`className`, `fieldName`) plus a `maxObjectsToScan`
number input (no default, per `ueReflect.ts`'s own "no silent default"
rule — pre-filled with a documented-as-arbitrary starting suggestion
like `100000`, editable). "Resolve" button calls a new `ue:resolveClass`
IPC channel (mirrors `mono:resolveClass`), then, on success,
`ue:listFieldNames` (mirrors `mono:listFields`) to populate a
filterable field list exactly like `MonoExplorer`'s existing
`fieldFilter`/`setFields` pattern — **this part IS a straight copy** of
that UI shape, just backed by `ue_*` IPC channels instead of `mono_*`
ones.

Each field row gets a **"Use as UE target"** button (mirrors
`onUseAsValueTarget`), which does not immediately produce a usable
`UeTarget` on its own — see below.

### Section 3 — Instance anchor picker (completes the target)

Per `2026-09-17-ue-target-wiring-design.md`, a `UeTarget` also needs
`instanceAnchorPatchId` — a `capture`-mode `PatchCheat` found via
ordinary live-RE (unrelated to reflection). Clicking "Use as UE
target" opens the **same capture-patch picker `EditCheatModal.tsx`
already has for `AnchorTarget`** (a dropdown of this profile's existing
`capture`-mode patches, `src/renderer/src/components/EditCheatModal.tsx`)
rather than building a second one — the two target kinds share this
exact sub-problem (some other capture patch supplies the instance
pointer), so they share the picker component. Selecting one assembles
the full `UeTarget` (`className`, `fieldName`, `maxObjectsToScan`,
`instanceAnchorPatchId`) and hands it to `EditCheatModal`'s existing
target-list state, the same hand-off `onUseAsValueTarget` already
does for `MonoTarget`.

### What's explicitly NOT in this screen

- **No live value preview** (`MonoExplorer`'s `watchedField`/
  `liveValue` polling section). That feature reads a field through an
  *already-resolved* address — for `MonoTarget`, a static field's own
  storage is that address with no extra step; for `UeTarget`, there is
  no address until an instance anchor is picked (Section 3), so a live
  preview would need Section 3 completed first. Worth adding once the
  rest of this screen is proven against a real game — deliberately cut
  from this pass to keep the slice small, matching every other Phase 1
  piece's "ship the primitive, defer the polish" pattern.
- **No search index** (`MonoExplorer`'s `buildSearchIndex`) — that
  exists because Mono's per-assembly class list is cheap to fully
  enumerate; UE has nothing equivalent to enumerate cheaply (see
  "Why this isn't a straight copy" above).

## IPC surface (new channels, `src/main/ipc.ts`)

Mirrors the `mono:*` channel shapes exactly:

```
ue:saveConfig       (config: UeConfig) => void
ue:resolveClass     (className: string, maxObjectsToScan: number) => string | null
ue:listFieldNames   (classAddress: string) => string[]
```

Each is a thin wrapper calling `ueTargetResolve.ts`'s pure functions
(from the wiring spec) with the current profile's `ueConfig` and the
attached handle — no new resolution logic here, purely IPC plumbing,
same relationship `ipc.ts`'s existing `mono:*` handlers already have to
`monoResolver.ts`.

## Testing

Component-level: the config editor and resolve-by-name flow are
testable with mocked `window.tamper.ue*` calls, the same pattern
`MonoExplorer`'s own tests (if any exist — check the established
convention in `src/renderer/src/screens/` before assuming a testing
harness) already use. The "use as UE target" hand-off to
`EditCheatModal`'s existing anchor picker is an integration point
between two already-separately-testable pieces, not new logic of its
own to unit test.

This entire screen is UI plumbing over already-tested primitives
(`ueReflect.ts`'s decode/walk, `ueTargetResolve.ts`'s resolution) — its
own correctness risk is wiring, not algorithm, so manual click-through
verification against a real profile (once `2026-09-17-ue-target-wiring-
design.md` ships) matters more here than automated coverage.

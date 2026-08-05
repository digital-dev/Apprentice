# Mono authoring tools: discovery search/live-values + one-hop instance arming

## Context

Comparing a third-party Cheat Engine-built Valheim trainer against `games/valheim.json`
surfaced a real feature gap (godmode, ghost mode, infinite eitr, free building, no
death penalty, etc. — see conversation of 2026-08-04). Investigating how to close it
found that the underlying capability mostly already exists on `feature/mono-resolver`:
`MonoExplorer.tsx` already hands off a resolved field to a "value target" freeze cheat,
or a resolved method to a "patch anchor" (nop/immune), all without hand-editing JSON.

Two real gaps remained once the existing UI was exercised against the missing features:

1. **Discovery**: Mono Explorer only lists field/method *names* for one class already
   picked, with no cross-class search and no way to see a field's current value. Without
   a reference CE table to crib class/field names from, there's no way to find e.g.
   "the field that holds ghost mode" other than guessing names or browsing hundreds of
   classes one at a time.
2. **Authoring**: the immune/guard arm-resolution path (`armPointerClassName`/
   `armPointerFieldName`) only dereferences one static field to get an instance pointer.
   `Skills:OnDeath` needs its arm value to be the *Skills* instance reached through
   `Player.m_localPlayer` → `.m_skills` — one hop further than the form supports today.

`SE_Rested`'s timer-reset/comfort-max cheats do **not** need this: they already fit the
existing `capture` patch mode (capture whichever `SE_Rested` instance the game touches
when `UpdateStatusEffect` runs, then a value cheat anchored to that capture). Out of
scope here as a non-issue, not a gap.

Nested-class resolution (Cheat Engine's `ItemDrop+ItemData`, `Skills+Skill` syntax) is a
separate, known gap in `mono_bridge.cc`'s class resolution — noted but explicitly out of
scope for this design; it blocks a few CE-sourced cheats (item stack/durability, instant
skill) but not the two gaps this spec addresses.

## Goals

- Search field/method names across every class in a picked assembly, not just one class
  at a time.
- Show a selected field's live current value, polled while Mono Explorer has it open, so
  a field can be identified by watching it change during play.
- Let an immune/guard patch's arm value be resolved through one instance field beyond
  the existing static-field hop (`ClassName.staticField` → instance → `.instanceField`
  → instance), matching the two-hop shape `MonoTarget` value cheats already use.

## Non-goals

- Arbitrary-depth arm chains (rejected — one hop covers every case found so far; a
  general chain builder is a bigger form with more ways to silently target the wrong
  object).
- Nested-class (`Outer+Inner`) resolution.
- Any change to `SE_Rested`-style cheats — already covered by existing `capture` mode.
- A standalone decompiled-metadata browser — the live process already exposes
  everything needed; no external dump tooling.

## Design

### Components

1. **`native/src/mono_bridge.cc`** — add `monoReadInstanceField(handle, monoDllBase,
   objectPointer, fieldOffset, dataType)`: given an already-resolved object pointer and
   a field offset (from the existing `monoResolveField`), read its current value. This
   is the "now read through it" half that today's field resolution doesn't need (value
   cheats only *write*); both the live-value poller and the new arm-chain hop need it.

2. **`src/main/monoResolver.ts`** — thin wrapper `readInstanceField`, matching the
   file's existing never-throws, resolve-or-null convention.

3. **`src/renderer/src/screens/MonoExplorer.tsx`**:
   - `buildSearchIndex(imageHandle)`: loops `listClassesInImage` →
     `listFieldNames`/`listMethodNames` per class in that assembly, cached per-assembly
     (rebuilt only when assemblies are reloaded, not on every keystroke).
   - A search box above the class list filters the index across every class in the
     current assembly; each hit shows its owning `ClassName.fieldName`/`ClassName.
     methodName()` and clicking it jumps Explorer into that class already resolved
     (reuses the existing `resolve()` call).
   - Selecting a field starts a poll (`setInterval`, ~500ms) that resolves the field's
     live address the same way the value-target hand-off would, reads it via
     `readInstanceField`, and displays it next to the field name. Stopped on unmount or
     when a different field is selected.

4. **`src/main/store.ts`** — `PatchCheat` gains `armPointerInstanceFieldName?: string`,
   documented alongside the existing `armPointerClassName`/`armPointerFieldName` block:
   absent means "static field's value IS the arm pointer" (today's behavior, unchanged);
   present means "dereference once more through this instance field first."

5. **`src/main/anchor.ts`** — the arm-value resolution path (`MonoOps.resolvePointer`
   caller / equivalent) gains one more optional dereference: with
   `armPointerInstanceFieldName` set, resolve `staticField → address → read pointer`
   as today, then `that pointer + resolveField(instanceFieldName) offset → read
   pointer` as the final arm value.

6. **`src/renderer/src/screens/CheatList.tsx`** — immune mini-form gains a checkbox
   ("reached through an instance field on that object" — same shape as the value-target
   form's existing `monoValueIsInstance` control), revealing an input for the instance
   field name when checked, wired to the new store field.

### Data flow

**Discovery**: pick assembly → index built once → type in search box → matches filtered
from the cached index → click a match → `resolve()` runs on that match's class exactly
as picking it from the class list would → for a field match, live-value polling starts
immediately.

**Authoring (one-hop arm)**: unchanged when `armPointerInstanceFieldName` is absent.
When present: `resolveMonoAnchorArmValue` resolves the static field's pointer (as
today), then performs the same two-hop dereference `MonoTarget` value cheats already do
for `instanceFieldName` — the same proven shape, applied to the arm path instead of the
write path.

### Error handling

Consistent with the codebase's existing resolve-or-null convention (no throwing on
expected "not found yet" outcomes):

- A failure at the first hop (static field) reports as it does today.
- A failure at the *second* hop reports which hop failed specifically — e.g. `"Player.
  m_localPlayer resolved, but Player has no field m_skills"` — not a generic "could not
  resolve", since the two-hop chain has two independent failure points a user needs to
  tell apart to fix their input.
- Live-value polling failures (process detached mid-poll, field temporarily unreadable)
  go quiet rather than erroring the whole Explorer screen — matching `patchSlot`
  polling's existing `catch { /* not attached */ }` pattern in `CheatList.tsx`.

### Testing

- `readInstanceField` / the new arm-resolution hop: unit tests in the existing
  `tests/native/mono_bridge.test.ts` / `tests/main/anchor.test.ts` style — mocked ops,
  no live process required.
- Search index filtering: a pure-function test against a fixture class/field list, not
  requiring a mounted `MonoExplorer` component.
- Manual verification against the running game for the concrete case this exists to
  unblock: the `Skills:OnDeath` immune cheat, arming through `Player.m_localPlayer` →
  `.m_skills`, same verification approach as prior mono-resolver work.

## Open questions

None — scope confirmed via clarifying questions in the design conversation (one-hop
arm chain, both search and live values for discovery).

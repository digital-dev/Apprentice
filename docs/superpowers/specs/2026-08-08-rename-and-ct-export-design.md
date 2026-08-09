# Rename cheats + Export to .CT

## Problem

Two gaps in cheat management:

1. There's no way to rename a saved cheat once created — the name is set
   once (typed at creation, or taken from a `.CT` import's `Description`)
   and stuck.
2. Cheats can be imported from a Cheat Engine `.CT` table (`ctImport.ts`)
   but there's no way back out — no way to hand a `.CT` file to someone
   else, or to back up locally-authored patches in that format.

## Goal

Let a saved cheat's name be edited in place. Let the current cheat list
be exported to a `.CT` file, symmetric with what import already
understands: only `force`-mode patches — the same "replace one write with
a fixed value" shape `ctImport.ts` parses — round-trip. Everything else is
skipped and reported, mirroring import's existing skipped-list UX.

## Design

### Rename

Both cheat lists in `CheatList.tsx` — value cheats (`cheats`, rendered
`<span>{cheat.name}</span>` around line 1012) and patch cheats (`patches`,
`<span>{patch.name}</span>` around line 1097) — gain a "Rename" control per
row:

- A "Rename" button toggles that row's name into edit mode: the `<span>`
  is replaced by an `<input>` pre-filled with the current name, plus
  "Save" and "Cancel" buttons.
- Edit-mode state is a single `renamingId: string | null` (one row editable
  at a time, mirroring the existing `verifyOpen: string | null` pattern
  already used for the per-row verify panel) plus a `renameValue: string`
  for the input's current text.
- "Save" calls `window.tamper.saveCheat(exeName, { ...cheat, name:
  renameValue.trim() })` — `saveCheat`'s existing `cheats:save` IPC handler
  already upserts by `id` (`store.ts`'s `saveCheat`), so no new IPC is
  needed. A blank/whitespace-only `renameValue` is rejected client-side
  (button disabled) rather than saved. After a successful save, update the
  matching entry in local `cheats`/`patches` state and clear
  `renamingId`.
- "Cancel" clears `renamingId` without saving.
- Internal patches (`patch.internal`) are already filtered out of the
  patch list's render (`patches.filter((p) => !p.internal)`) — rename
  never has to consider them.

### Export to .CT

New file `src/main/ctExport.ts`, the reverse of `ctImport.ts`:

```ts
export interface CtExportSkip {
  name: string
  reason: string
}

export interface CtExportResult {
  xml: string
  exported: string[]
  skipped: CtExportSkip[]
}

export function buildCheatTable(patches: PatchCheat[]): CtExportResult
```

For each patch in the input list:
- If `patchMode(patch) !== 'force'` (using `store.ts`'s existing
  `patchMode` helper, which defaults an absent `mode` to `'nop'`), skip
  with reason `"Only 'force'-mode patches can be exported to Cheat Engine's Auto Assembler format."`
- If `mode === 'force'` but any of `signature`, `originalBytes`, `length`,
  `baseRegister`, `fieldOffset`, `value`, `dataType` is missing, skip with
  reason `"Force-mode patch is missing data needed to reconstruct its Auto Assembler script."`
  (Not expected in practice — `patchEngine.ts`'s force-mode write path
  already requires `value`/`dataType` to exist — but exporting is a read
  path over stored JSON that could in principle be hand-edited or from an
  older save, so this is a real skip condition, not dead code.)
- Otherwise, build one `<CheatEntry>` block, the exact inverse of
  `parseForceInjection`:
  - `<Description>"{escaped name}"</Description>` — escape via the
    inverse of `ctImport.ts`'s `unescapeXml` (`&`, `<`, `>`, `"`, `'`),
    wrapped in literal escaped quotes the same way import strips them.
  - `<VariableType>Auto Assembler Script</VariableType>`
  - `<AssemblerScript>` containing:
    ```
    [ENABLE]
    aobscan(patch1, {signature with spaces re-inserted between byte pairs})
    patch1{+signatureOffset in hex, omitted if 0}:
      mov [{baseRegister}+{fieldOffset without 0x prefix, zero-padded to 8 hex digits}], {value}
    
    [DISABLE]
    patch1{+signatureOffset}:
      db {originalBytes with spaces re-inserted between byte pairs}
    
    [DISABLE]
    ```
    `{value}`: for `dataType === 'int32'`, plain hex (matching
    `parseForceInjection`'s `parseInt(rawValue, 16)` reversed — write
    `value.toString(16)`); for `dataType === 'float'`, `(float){value}` in
    decimal (matching `parseFloat` reversed). `dataType === 'byte'` is not
    a possible `force`-mode value in practice today (scanner/capture-based
    force patches only produce `int32`/`float`) but if encountered, treat
    it as a skip (same missing-data reason above) rather than guessing a
    CE syntax for it.
    The `aobscan` label (`patch1`, `patch2`, ...) is a per-export running
    counter, not derived from the patch's `id` — CE's own convention is
    short generated names, and a stable per-export counter avoids any
    character-escaping concerns an `id`-derived label would raise.
- Every successfully-built entry's raw name is pushed to `exported`, in
  the same order the input patches were given.

The whole `xml` is entries wrapped in the minimal valid CT envelope:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CheatTable>
  <CheatEntries>
    {entries}
  </CheatEntries>
</CheatTable>
```

### IPC (`src/main/ipc.ts`)

New handler, placed next to the existing `ct:import` handler:

```ts
ipcMain.handle(
  'ct:export',
  async (
    _e,
    exeName: string
  ): Promise<{ exportedNames: string[]; skipped: CtExportSkip[] } | null> => {
    const patches = loadCheats(exeName).filter(isPatchCheat)
    const { xml, exported, skipped } = buildCheatTable(patches)
    const result = await dialog.showSaveDialog(getWindow(), {
      title: 'Export Cheat Engine table',
      defaultPath: `${exeName.replace(/\.exe$/i, '')}.CT`,
      filters: [{ name: 'Cheat Table', extensions: ['CT'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, xml, 'utf8')
    return { exportedNames: exported, skipped }
  }
)
```

`isPatchCheat` and `loadCheats` are both already imported/used elsewhere
in `ipc.ts`. This mirrors `ct:import`'s existing shape exactly (dialog,
try/return-null-on-cancel, summary return value) but with save instead of
open, and no `saveCheat` loop since export doesn't mutate anything.

### Preload (`src/preload/index.ts`) and types (`src/renderer/src/tamper.d.ts`)

Add, directly beside the existing `importCheatTable` entry in both files:

```ts
exportCheatTable: (exeName: string) => ipcRenderer.invoke('ct:export', exeName)
```
```ts
exportCheatTable: (
  exeName: string
) => Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null>
```

### Renderer (`src/renderer/src/screens/CheatList.tsx`)

- New `Export to Cheat Table (.CT)` button next to the existing `Import
  Cheat Table (.CT)` button (line ~733), wired the same way: an
  `exporting` boolean state, an `exportResult` state of the same
  `{ exportedNames, skipped }` shape as `ctImportResult`, and a handler
  that calls `window.tamper.exportCheatTable(exeName)`, sets the result,
  and leaves `exporting` false in a `finally`.
- The result renders in a `.banner` block reusing the same layout as
  `ctImportResult`'s existing banner (exported count + names list, skipped
  count + reasons list, a "Dismiss" button) — new state, but no new CSS.

## Out of scope

- Exporting anything other than `force`-mode patches (value cheats, other
  patch modes, Mono-anchored cheats) — these are skipped and reported, not
  approximated.
- Editing anything about a cheat other than its name (targets, value,
  mode, etc. already have their own UI elsewhere).
- A shared/generic "editable label" component — this is two call sites in
  one file; extracting a component is not warranted by that scale.

## Testing

- `tests/main/ctExport.test.ts` (new): unit tests `buildCheatTable`
  directly (pure function, no Electron/IPC needed):
  - A `force`-mode patch round-trips: `buildCheatTable([patch]).xml` fed
    into `importCheatTable` (already tested elsewhere) reproduces the same
    `name`, `signature`, `originalBytes`, `length`, `baseRegister`,
    `fieldOffset`, `value`, `dataType`.
  - A round-trip case for `dataType: 'float'` specifically, since the
    hex-vs-decimal branching is the one place a sign or precision bug
    could silently corrupt a value across export→import.
  - A non-`force`-mode patch (e.g. `mode: 'nop'`) is skipped with a
    reason, and does not appear in `exported`.
  - A `force`-mode patch missing a required field (e.g. no `signature`) is
    skipped with a reason.
- Rename has no renderer test harness to extend (none exists for
  `CheatList.tsx` today) — verified manually per the implementation plan's
  build/run step, consistent with how the rest of that screen is already
  covered (or not) elsewhere in this codebase.

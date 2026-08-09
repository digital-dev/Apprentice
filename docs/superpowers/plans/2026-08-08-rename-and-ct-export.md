# Rename Cheats + Export to .CT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a saved cheat's name be edited in place, and let the current cheat list be exported to a Cheat Engine `.CT` file (only `force`-mode patches round-trip; everything else is skipped and reported).

**Architecture:** Rename reuses the existing `cheats:save` IPC (already an upsert-by-id) with no new plumbing — pure renderer-side UI state in `CheatList.tsx`. Export adds a new pure function (`ctExport.ts`, the inverse of the existing `ctImport.ts`), a new `ct:export` IPC handler that wraps it with a save-file dialog, and preload/type/renderer wiring mirroring the existing `ct:import` path exactly.

**Tech Stack:** React 18 (function components + hooks), TypeScript, Electron IPC (`ipcMain.handle`/`ipcRenderer.invoke`/`contextBridge`), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-rename-and-ct-export-design.md`
- Rename uses the existing `window.tamper.saveCheat(exeName, cheat)` IPC — no new IPC channel for rename.
- Export includes only patches where `patchMode(patch) === 'force'` (via `store.ts`'s existing `patchMode` helper) and every field the script reconstruction needs is present; everything else is skipped with a reason, mirroring `ctImport.ts`'s `CtImportSkip` shape.
- `src/renderer/src/screens/CheatList.tsx` must not import value bindings from `../../../main/store` (only types) — it already re-declares small guards locally (`isPatch`, `isAnchor`, `isMono`) for this reason; follow the same pattern for anything new.
- No new shared "editable label" component — this is two call sites in one file, per the spec's explicit out-of-scope note.
- Reuse existing CSS (`.banner`, default `button`/`input` styling) — no new theme.css rules needed for this feature.

---

### Task 1: Rename cheats and patches in `CheatList.tsx`

**Files:**
- Modify: `src/renderer/src/screens/CheatList.tsx:146-147` (new state, next to `verifyOpen`/`verifyValue`), `:1005-1084` (cheats `<ul>`), `:1085-1165` (patches `<ul>`)

**Interfaces:**
- Consumes: `window.tamper.saveCheat(exeName: string, cheat: StoredCheat): Promise<void>` (already exists, `tamper.d.ts:54` region — no changes needed).
- Produces: nothing consumed by later tasks — this task is independent of Task 2-4.

- [ ] **Step 1: Add rename state**

In `src/renderer/src/screens/CheatList.tsx`, directly after the existing:
```tsx
  const [verifyOpen, setVerifyOpen] = useState<string | null>(null)
  const [verifyValue, setVerifyValue] = useState('')
```
add:
```tsx
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
```

- [ ] **Step 2: Add `renameCheat` and `renamePatch` functions**

Find the existing `pruneDead` function (around line 589-603):
```tsx
  async function pruneDead(cheat: CheatDefinition) {
    const result = statuses.get(cheat.id)
    if (!result) return
    const keptTargets = cheat.targets.filter((_, i) => result[i]?.alive)
    if (keptTargets.length === 0) return // never leave a cheat with zero targets
    const updated = { ...cheat, targets: keptTargets }
    await window.tamper.saveCheat(exeName, updated)
    setCheats((prev) => prev.map((c) => (c.id === cheat.id ? updated : c)))
    setStatuses((prev) => {
      const next = new Map(prev)
      next.delete(cheat.id)
```

Directly after the full `pruneDead` function (after its closing `}`), add two new functions following the same save-then-update-local-state pattern:

```tsx
  async function renameCheat(cheat: CheatDefinition, name: string) {
    const trimmed = name.trim()
    if (trimmed === '') return
    const updated = { ...cheat, name: trimmed }
    await window.tamper.saveCheat(exeName, updated)
    setCheats((prev) => prev.map((c) => (c.id === cheat.id ? updated : c)))
    setRenamingId(null)
  }

  async function renamePatch(patch: PatchCheat, name: string) {
    const trimmed = name.trim()
    if (trimmed === '') return
    const updated = { ...patch, name: trimmed }
    await window.tamper.saveCheat(exeName, updated)
    setPatches((prev) => prev.map((p) => (p.id === patch.id ? updated : p)))
    setRenamingId(null)
  }
```

- [ ] **Step 3: Wire rename into the cheats `<ul>`**

Find (around line 1011-1012):
```tsx
            <li key={cheat.id} style={{ flexWrap: 'wrap' }}>
              <span>{cheat.name}</span>
```
Change to:
```tsx
            <li key={cheat.id} style={{ flexWrap: 'wrap' }}>
              {renamingId === cheat.id ? (
                <>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    style={{ maxWidth: 200 }}
                  />
                  <button
                    onClick={() => renameCheat(cheat, renameValue)}
                    disabled={renameValue.trim() === ''}
                  >
                    Save
                  </button>
                  <button onClick={() => setRenamingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span>{cheat.name}</span>
                  <button
                    onClick={() => {
                      setRenamingId(cheat.id)
                      setRenameValue(cheat.name)
                    }}
                  >
                    Rename
                  </button>
                </>
              )}
```

- [ ] **Step 4: Wire rename into the patches `<ul>`**

Find (around line 1096-1097):
```tsx
              <li key={patch.id} style={{ flexWrap: 'wrap' }}>
                <span>{patch.name}</span>
```
Change to:
```tsx
              <li key={patch.id} style={{ flexWrap: 'wrap' }}>
                {renamingId === patch.id ? (
                  <>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      style={{ maxWidth: 200 }}
                    />
                    <button
                      onClick={() => renamePatch(patch, renameValue)}
                      disabled={renameValue.trim() === ''}
                    >
                      Save
                    </button>
                    <button onClick={() => setRenamingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span>{patch.name}</span>
                    <button
                      onClick={() => {
                        setRenamingId(patch.id)
                        setRenameValue(patch.name)
                      }}
                    >
                      Rename
                    </button>
                  </>
                )}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `npm run build` (confirms the renderer bundle compiles cleanly — this environment cannot open a GUI headlessly; note that substitution in your report, consistent with prior sessions in this codebase's history)
Expected: build completes without error.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/screens/CheatList.tsx
git commit -m "Add inline rename for saved cheats and patches"
```

---

### Task 2: `ctExport.ts` — build a `.CT` XML string from `force`-mode patches

**Files:**
- Create: `src/main/ctExport.ts`
- Test: `tests/main/ctExport.test.ts`

**Interfaces:**
- Consumes: `PatchCheat`, `DataType` types and the `patchMode` function from `./store` (all already exist — `patchMode(patch: PatchCheat): 'nop' | 'force' | 'capture' | 'guard' | 'immune'`, defaults an absent `mode` to `'nop'`).
- Produces:
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
  Task 3's IPC handler imports `buildCheatTable` and `CtExportSkip` from this file.

- [ ] **Step 1: Write the failing tests**

Create `tests/main/ctExport.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildCheatTable } from '../../src/main/ctExport'
import { importCheatTable } from '../../src/main/ctImport'
import type { PatchCheat } from '../../src/main/store'

function forcePatch(overrides: Partial<PatchCheat> = {}): PatchCheat {
  return {
    kind: 'patch',
    mode: 'force',
    id: 'test-patch',
    name: 'Infinite Stamina',
    originalBytes: 'f30f11af18080000',
    length: 8,
    signature: 'f3 0f 11 af 18 08 00 00 48 8b 7d',
    signatureOffset: 0,
    moduleName: null,
    moduleOffset: null,
    baseRegister: 'rdi',
    fieldOffset: '0x818',
    value: 350,
    dataType: 'float',
    ...overrides
  }
}

describe('buildCheatTable', () => {
  it('round-trips a force-mode float patch through importCheatTable', () => {
    const patch = forcePatch()
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual(['Infinite Stamina'])
    expect(result.skipped).toEqual([])

    const reimported = importCheatTable(result.xml)
    expect(reimported.skipped).toEqual([])
    expect(reimported.imported).toHaveLength(1)
    const back = reimported.imported[0]
    expect(back.name).toBe(patch.name)
    expect(back.signature).toBe(patch.signature)
    expect(back.originalBytes).toBe(patch.originalBytes)
    expect(back.length).toBe(patch.length)
    expect(back.baseRegister).toBe(patch.baseRegister)
    expect(back.fieldOffset).toBe(patch.fieldOffset)
    expect(back.value).toBe(patch.value)
    expect(back.dataType).toBe(patch.dataType)
  })

  it('round-trips a force-mode int32 patch, including a nonzero signature offset', () => {
    const patch = forcePatch({
      id: 'test-patch-2',
      name: 'Infinite Health',
      originalBytes: 'c7461808000000',
      length: 7,
      signature: 'e8 ?? ?? ?? ?? c7 46 18 08 00 00 00',
      signatureOffset: 5,
      baseRegister: 'rsi',
      fieldOffset: '0x18',
      value: 999,
      dataType: 'int32'
    })
    const result = buildCheatTable([patch])
    const reimported = importCheatTable(result.xml)
    expect(reimported.skipped).toEqual([])
    const back = reimported.imported[0]
    expect(back.signature).toBe(patch.signature)
    expect(back.signatureOffset).toBe(5)
    expect(back.originalBytes).toBe(patch.originalBytes)
    expect(back.fieldOffset).toBe(patch.fieldOffset)
    expect(back.value).toBe(999)
    expect(back.dataType).toBe('int32')
  })

  it('skips a non-force-mode patch with a reason, and does not export it', () => {
    const patch = forcePatch({ mode: 'nop', name: 'A NOP patch' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'A NOP patch',
        reason: "Only 'force'-mode patches can be exported to Cheat Engine's Auto Assembler format."
      }
    ])
  })

  it('skips a force-mode patch missing required fields', () => {
    const patch = forcePatch({ signature: undefined as unknown as string })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Infinite Stamina',
        reason: 'Force-mode patch is missing data needed to reconstruct its Auto Assembler script.'
      }
    ])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main/ctExport.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/ctExport'` (the file doesn't exist yet).

- [ ] **Step 3: Write `src/main/ctExport.ts`**

```ts
import type { DataType, PatchCheat } from './store'
import { patchMode } from './store'

// Builds a Cheat Engine .CT table from this app's own PatchCheat records —
// the exact inverse of ctImport.ts's parseForceInjection. Only `force`-mode
// patches are representable in the "aobscan finds an instruction, DISABLE's
// db line records the original bytes, ENABLE's code replaces it with a
// fixed mov [reg+offset], constant" shape ctImport.ts understands; every
// other mode (nop/capture/guard/immune) and every value cheat has no
// equivalent AA-script shape here and is reported skipped rather than
// approximated. The output only needs to satisfy this codebase's own
// importCheatTable on the way back in — it is not a general Auto Assembler
// script (no alloc/label/jmp scaffolding), matching that this app's own
// patch engine does the actual writing, not a CE-style code injection.
export interface CtExportSkip {
  name: string
  reason: string
}

export interface CtExportResult {
  xml: string
  exported: string[]
  skipped: CtExportSkip[]
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// originalBytes/signature are stored compacted ("f30f11af..."); CE's own
// db/aobscan lines are space-separated byte pairs. Signature already
// carries its own spaces (see ctImport.ts's aobMatch capture) and any ??
// wildcards pass through unchanged, so only originalBytes needs
// re-spacing here.
function spacedHex(compact: string): string {
  return (compact.match(/.{1,2}/g) ?? []).join(' ')
}

function formatValue(value: number, dataType: DataType): string {
  return dataType === 'float' ? `(float)${value}` : value.toString(16)
}

const REQUIRED_FIELDS: (keyof PatchCheat)[] = [
  'signature',
  'originalBytes',
  'baseRegister',
  'fieldOffset',
  'value',
  'dataType'
]

function buildEntry(patch: PatchCheat, label: string): string {
  const offset = patch.signatureOffset ?? 0
  const offsetSuffix = offset !== 0 ? `+${offset.toString(16)}` : ''
  const fieldOffsetHex = (patch.fieldOffset as string).replace(/^0x/i, '')
  const script = `[ENABLE]
aobscan(${label},${patch.signature})
${label}${offsetSuffix}:
  mov [${patch.baseRegister}+${fieldOffsetHex}],${formatValue(patch.value as number, patch.dataType as DataType)}

[DISABLE]
${label}${offsetSuffix}:
  db ${spacedHex(patch.originalBytes)}
`
  return `    <CheatEntry>
      <Description>"${escapeXml(patch.name)}"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
${script}</AssemblerScript>
    </CheatEntry>`
}

export function buildCheatTable(patches: PatchCheat[]): CtExportResult {
  const exported: string[] = []
  const skipped: CtExportSkip[] = []
  const entries: string[] = []
  let counter = 0

  for (const patch of patches) {
    if (patchMode(patch) !== 'force') {
      skipped.push({
        name: patch.name,
        reason: "Only 'force'-mode patches can be exported to Cheat Engine's Auto Assembler format."
      })
      continue
    }
    const missing = REQUIRED_FIELDS.some((field) => patch[field] === undefined || patch[field] === null)
    if (missing || patch.dataType === 'byte') {
      skipped.push({
        name: patch.name,
        reason: 'Force-mode patch is missing data needed to reconstruct its Auto Assembler script.'
      })
      continue
    }
    counter++
    entries.push(buildEntry(patch, `patch${counter}`))
    exported.push(patch.name)
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CheatTable>
  <CheatEntries>
${entries.join('\n')}
  </CheatEntries>
</CheatTable>
`
  return { xml, exported, skipped }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/ctExport.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npx vitest run tests/main/ctImport.test.ts tests/main/ctExport.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ctExport.ts tests/main/ctExport.test.ts
git commit -m "Add ctExport: build a .CT table from force-mode patches"
```

---

### Task 3: `ct:export` IPC handler + preload + types

**Files:**
- Modify: `src/main/ipc.ts` (add handler next to the existing `ct:import` handler, end of `registerIpc`/similar setup function, before its closing and `startWatching` call)
- Modify: `src/preload/index.ts:54` (add `exportCheatTable` next to `importCheatTable`)
- Modify: `src/renderer/src/tamper.d.ts` (add `exportCheatTable` type next to `importCheatTable`)

**Interfaces:**
- Consumes: `buildCheatTable`, `CtExportSkip` from `./ctExport` (Task 2); `loadCheats`, `isPatchCheat` from `./store` (already imported in `ipc.ts`); `dialog`, `fs` (already imported in `ipc.ts`).
- Produces: `window.tamper.exportCheatTable(exeName: string): Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null>` — Task 4's renderer button calls this exact signature.

- [ ] **Step 1: Import `buildCheatTable` in `ipc.ts`**

Find:
```ts
import { importCheatTable } from './ctImport'
```
Change to:
```ts
import { importCheatTable } from './ctImport'
import { buildCheatTable } from './ctExport'
```

- [ ] **Step 2: Add the `ct:export` handler**

Find the existing `ct:import` handler (ends with its closing `}\n  )` right before `startWatching(getWindow)` at the end of the setup function):
```ts
      const { imported, skipped } = importCheatTable(xml)
      for (const patch of imported) saveCheat(exeName, patch)
      return { importedNames: imported.map((p) => p.name), skipped }
    }
  )

  startWatching(getWindow)
}
```
Change to:
```ts
      const { imported, skipped } = importCheatTable(xml)
      for (const patch of imported) saveCheat(exeName, patch)
      return { importedNames: imported.map((p) => p.name), skipped }
    }
  )

  // Opens a native save dialog and writes out every 'force'-mode patch as
  // a Cheat Engine Auto Assembler entry — the exact reverse of ct:import
  // above. Everything that mode can't represent (other patch modes, value
  // cheats) is skipped and reported, not approximated; see ctExport.ts's
  // module comment for why.
  ipcMain.handle(
    'ct:export',
    async (
      _e,
      exeName: string
    ): Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null> => {
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

  startWatching(getWindow)
}
```

- [ ] **Step 3: Add `exportCheatTable` to the preload bridge**

In `src/preload/index.ts`, find:
```ts
  importCheatTable: (exeName: string) => ipcRenderer.invoke('ct:import', exeName)
})
```
Change to:
```ts
  importCheatTable: (exeName: string) => ipcRenderer.invoke('ct:import', exeName),
  exportCheatTable: (exeName: string) => ipcRenderer.invoke('ct:export', exeName)
})
```

- [ ] **Step 4: Add the type to `tamper.d.ts`**

In `src/renderer/src/tamper.d.ts`, find:
```ts
      importCheatTable: (
        exeName: string
      ) => Promise<{ importedNames: string[]; skipped: { description: string; reason: string }[] } | null>
    }
  }
}
```
Change to:
```ts
      importCheatTable: (
        exeName: string
      ) => Promise<{ importedNames: string[]; skipped: { description: string; reason: string }[] } | null>
      // Opens a native save dialog and writes every 'force'-mode patch out
      // as a Cheat Engine .CT table. Null if the user cancelled the save
      // dialog; otherwise a summary of what was exported and what was
      // skipped (with why) — see ctExport.ts.
      exportCheatTable: (
        exeName: string
      ) => Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null>
    }
  }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: same pass/fail split as the pre-existing baseline (native-addon/Electron-install suites fail in this dev environment regardless of this change; all TypeScript-only suites, including `ctExport.test.ts`, pass).

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts
git commit -m "Wire ct:export IPC handler, preload bridge, and types"
```

---

### Task 4: Export button + result banner in `CheatList.tsx`

**Files:**
- Modify: `src/renderer/src/screens/CheatList.tsx:212-216` (new state, next to `ctImporting`/`ctImportResult`), `:733-764` (import button + result banner)

**Interfaces:**
- Consumes: `window.tamper.exportCheatTable(exeName: string): Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null>` (Task 3).

- [ ] **Step 1: Add export state and handler**

Find:
```tsx
  const [ctImporting, setCtImporting] = useState(false)
  const [ctImportResult, setCtImportResult] = useState<{
    importedNames: string[]
    skipped: { description: string; reason: string }[]
  } | null>(null)

  async function importCheatTable() {
    setCtImporting(true)
    setCtImportResult(null)
    try {
      const result = await window.tamper.importCheatTable(exeName)
      if (result === null) return // user cancelled the file picker
      setCtImportResult(result)
      // Saved directly by the main process (see ipc.ts's ct:import) —
      // reload from disk rather than reconstructing PatchCheat objects
      // here, so this stays in sync with whatever the save path actually
      // persisted.
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      setCheats(all.filter((c): c is CheatDefinition => !isPatch(c)))
      setPatches(all.filter(isPatch))
    } finally {
      setCtImporting(false)
    }
  }
```
Change to:
```tsx
  const [ctImporting, setCtImporting] = useState(false)
  const [ctImportResult, setCtImportResult] = useState<{
    importedNames: string[]
    skipped: { description: string; reason: string }[]
  } | null>(null)

  const [ctExporting, setCtExporting] = useState(false)
  const [ctExportResult, setCtExportResult] = useState<{
    exportedNames: string[]
    skipped: { name: string; reason: string }[]
  } | null>(null)

  async function importCheatTable() {
    setCtImporting(true)
    setCtImportResult(null)
    try {
      const result = await window.tamper.importCheatTable(exeName)
      if (result === null) return // user cancelled the file picker
      setCtImportResult(result)
      // Saved directly by the main process (see ipc.ts's ct:import) —
      // reload from disk rather than reconstructing PatchCheat objects
      // here, so this stays in sync with whatever the save path actually
      // persisted.
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      setCheats(all.filter((c): c is CheatDefinition => !isPatch(c)))
      setPatches(all.filter(isPatch))
    } finally {
      setCtImporting(false)
    }
  }

  async function exportCheatTable() {
    setCtExporting(true)
    setCtExportResult(null)
    try {
      const result = await window.tamper.exportCheatTable(exeName)
      if (result === null) return // user cancelled the save dialog
      setCtExportResult(result)
    } finally {
      setCtExporting(false)
    }
  }
```

- [ ] **Step 2: Add the export button and result banner**

Find:
```tsx
      <button onClick={importCheatTable} disabled={ctImporting}>
        {ctImporting ? 'Importing…' : 'Import Cheat Table (.CT)'}
      </button>

      {ctImportResult && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            Imported {ctImportResult.importedNames.length} cheat
            {ctImportResult.importedNames.length === 1 ? '' : 's'}
            {ctImportResult.skipped.length > 0
              ? `, skipped ${ctImportResult.skipped.length} (not the simple "replace one write with a fixed value" shape this importer supports).`
              : '.'}
          </p>
          {ctImportResult.importedNames.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctImportResult.importedNames.map((name) => (
                <li key={name}>✓ {name}</li>
              ))}
            </ul>
          )}
          {ctImportResult.skipped.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctImportResult.skipped.map((s, i) => (
                <li key={`${s.description}-${i}`} className="muted">
                  {s.description} — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setCtImportResult(null)}>Dismiss</button>
        </div>
      )}
```
Change to:
```tsx
      <button onClick={importCheatTable} disabled={ctImporting}>
        {ctImporting ? 'Importing…' : 'Import Cheat Table (.CT)'}
      </button>
      <button onClick={exportCheatTable} disabled={ctExporting}>
        {ctExporting ? 'Exporting…' : 'Export to Cheat Table (.CT)'}
      </button>

      {ctImportResult && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            Imported {ctImportResult.importedNames.length} cheat
            {ctImportResult.importedNames.length === 1 ? '' : 's'}
            {ctImportResult.skipped.length > 0
              ? `, skipped ${ctImportResult.skipped.length} (not the simple "replace one write with a fixed value" shape this importer supports).`
              : '.'}
          </p>
          {ctImportResult.importedNames.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctImportResult.importedNames.map((name) => (
                <li key={name}>✓ {name}</li>
              ))}
            </ul>
          )}
          {ctImportResult.skipped.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctImportResult.skipped.map((s, i) => (
                <li key={`${s.description}-${i}`} className="muted">
                  {s.description} — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setCtImportResult(null)}>Dismiss</button>
        </div>
      )}

      {ctExportResult && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            Exported {ctExportResult.exportedNames.length} cheat
            {ctExportResult.exportedNames.length === 1 ? '' : 's'}
            {ctExportResult.skipped.length > 0
              ? `, skipped ${ctExportResult.skipped.length} (only 'force'-mode patches can be exported).`
              : '.'}
          </p>
          {ctExportResult.exportedNames.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctExportResult.exportedNames.map((name) => (
                <li key={name}>✓ {name}</li>
              ))}
            </ul>
          )}
          {ctExportResult.skipped.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctExportResult.skipped.map((s, i) => (
                <li key={`${s.name}-${i}`} className="muted">
                  {s.name} — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setCtExportResult(null)}>Dismiss</button>
        </div>
      )}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build to confirm the renderer bundle compiles**

Run: `npm run build`
Expected: build completes without error. (No GUI available headlessly in this environment — this build check is the available substitute for a literal visual check, consistent with how this was handled in the prior sidebar-nav plan's Task 3.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/CheatList.tsx
git commit -m "Add Export to Cheat Table (.CT) button and result banner"
```

---

## Self-Review Notes

- Spec coverage: rename for both cheats and patches ✅ (Task 1), `buildCheatTable` with force-only export + skip reporting ✅ (Task 2), IPC/preload/types wiring ✅ (Task 3), export button + banner reusing `.banner` ✅ (Task 4). Round-trip testing (float and int32-with-offset cases) ✅ (Task 2). No renderer test harness for rename, verified manually per spec ✅ (Task 1, Step 6).
- Type consistency: `CtExportSkip`/`CtExportResult`/`buildCheatTable` signatures match between Task 2's definition, Task 3's IPC handler usage, and Task 3's `tamper.d.ts` return type; `exportCheatTable`'s signature matches between preload (Task 3), types (Task 3), and its renderer call site (Task 4).
- No placeholders: every step has literal code and an exact verification command.

# ctImport.ts extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `ctImport.ts` to convert two more shapes real CT tables use:
plain (non-scripted) value entries, and two more Auto Assembler effect
shapes (empty/nop-out, register-copy) beyond the single "replace with a
constant" shape it already recognizes.

**Architecture:** Two independent additions to the existing pure-function
parser: (1) a new branch in `importCheatTable`'s per-entry loop for
`VariableType`s that aren't `Auto Assembler Script`, producing a
`CheatDefinition` instead of a `PatchCheat`; (2) a restructure of the AA
effect classifier from a single regex attempt into an ordered dispatcher
(nop-shape → copy-shape → force-shape → unsupported), each a small, bounded
positive-match check — never a best-effort guess.

**Tech Stack:** TypeScript, Vitest. No native/Electron involvement — pure
string parsing, tested directly.

**Spec:** `docs/superpowers/specs/2026-08-18-ct-table-import-design.md`
(Component 2: `ctImport.ts` extensions)

**Depends on:** `docs/superpowers/plans/2026-08-18-ct-copy-mode.md` Task 2
(adds `PatchCheat.mode: 'copy'` and `sourceRegister` to `store.ts`) — Task 2
below produces `PatchCheat` objects with `mode: 'copy'`, which only
type-checks and installs correctly once that plan's Task 2 has landed.
Task 1 below (plain value entries) has no such dependency and can land
first regardless of ordering.

## Global Constraints

- Never guess: a shape that doesn't positively match a known pattern is
  skipped with a reason, exactly as `ctImport.ts`'s existing behavior — no
  best-effort fallback is ever introduced by this plan.
- `CtImportResult.imported` becomes `(PatchCheat | CheatDefinition)[]`; both
  are `StoredCheat`s `saveCheat` already accepts unchanged.

---

### Task 1: Plain value entries → `CheatDefinition`

**Files:**
- Modify: `src/main/ctImport.ts`
- Test: `tests/main/ctImport.test.ts`

**Interfaces:**
- Consumes: `extractTag`, `extractTagBlocks`, `unescapeXml`, `slugify`
  (existing, all in `ctImport.ts`), `ChainTarget`, `CheatDefinition`,
  `DataType` (`src/main/store.ts`, existing).
- Produces: `CtImportResult.imported: (PatchCheat | CheatDefinition)[]`
  (widened from `PatchCheat[]`); a new exported `parsePlainValueEntry`
  function other tasks/tests can call directly.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/ctImport.test.ts`, after the existing fixtures near the
top of the file:

```ts
const bareAddressEntry = `
    <CheatEntry>
      <ID>10</ID>
      <Description>"Score"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>004A2B3C</Address>
    </CheatEntry>`

const pointerChainEntry = `
    <CheatEntry>
      <ID>11</ID>
      <Description>"Health"</Description>
      <VariableType>Float</VariableType>
      <Address>"game.exe"+001A2B3C</Address>
      <Offsets>
        <Offset>18</Offset>
        <Offset>20</Offset>
      </Offsets>
    </CheatEntry>`

const plainValueWithLiteral = `
    <CheatEntry>
      <ID>12</ID>
      <Description>"Always Max Ammo"</Description>
      <VariableType>2 Bytes</VariableType>
      <Address>"game.exe"+00334455</Address>
      <Value>999</Value>
    </CheatEntry>`
```

Then, in the file's main `describe`/`it` body, add:

```ts
import { importCheatTable, parsePlainValueEntry } from '../../src/main/ctImport'
import type { CheatDefinition } from '../../src/main/store'

describe('plain value entries', () => {
  it('imports a bare-address 4-byte entry as a freeze cheat with a fixed-address target', () => {
    const { imported, skipped } = importCheatTable(wrapTable(bareAddressEntry))
    expect(skipped).toEqual([])
    expect(imported).toHaveLength(1)
    const cheat = imported[0] as CheatDefinition
    expect(cheat.mode).toBe('freeze')
    expect(cheat.dataType).toBe('int32')
    expect(cheat.name).toBe('Score')
    expect(cheat.targets).toEqual([{ moduleName: '', baseOffset: '0x4a2b3c', offsets: [] }])
    expect(cheat.value).toBe(0)
  })

  it('imports a module+offset pointer-chain entry with its offsets in document order', () => {
    const { imported, skipped } = importCheatTable(wrapTable(pointerChainEntry))
    expect(skipped).toEqual([])
    const cheat = imported[0] as CheatDefinition
    expect(cheat.dataType).toBe('float')
    expect(cheat.targets).toEqual([
      { moduleName: 'game.exe', baseOffset: '0x1a2b3c', offsets: ['0x18', '0x20'] }
    ])
  })

  it('reads a literal <Value> tag as the imported value when present', () => {
    const { imported } = importCheatTable(wrapTable(plainValueWithLiteral))
    const cheat = imported[0] as CheatDefinition
    expect(cheat.dataType).toBe('int16')
    expect(cheat.value).toBe(999)
  })

  it('skips an entry with an unparsable address instead of guessing', () => {
    const bad = bareAddressEntry.replace('004A2B3C', 'not-an-address')
    const { imported, skipped } = importCheatTable(wrapTable(bad))
    expect(imported).toHaveLength(0)
    expect(skipped).toEqual([{ description: 'Score', reason: expect.stringContaining('Could not parse address') }])
  })

  it('parsePlainValueEntry maps every recognized VariableType to the right DataType', () => {
    const cases: [string, string][] = [
      ['Byte', 'int8'],
      ['2 Bytes', 'int16'],
      ['4 Bytes', 'int32'],
      ['Float', 'float'],
      ['Double', 'double']
    ]
    for (const [variableType, dataType] of cases) {
      const entry = `<Description>"x"</Description><VariableType>${variableType}</VariableType><Address>1000</Address>`
      const result = parsePlainValueEntry(entry, variableType)
      expect('error' in result).toBe(false)
      expect((result as CheatDefinition).dataType).toBe(dataType)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/main/ctImport.test.ts -t "plain value entries"`
Expected: FAIL — `parsePlainValueEntry` is not exported / not defined, and
the existing loop `continue`s past every non-`Auto Assembler Script` entry
so `imported` stays empty.

- [ ] **Step 3: Implement `parsePlainValueEntry`**

Add to `src/main/ctImport.ts`, after the existing `parseForceInjection`
function (after line 178) and its `ParsedInjection` interface:

```ts
const PLAIN_VARIABLE_TYPES: Record<string, DataType> = {
  Byte: 'int8',
  '2 Bytes': 'int16',
  '4 Bytes': 'int32',
  Float: 'float',
  Double: 'double'
}

// Parses a plain (non-Auto-Assembler) CheatEntry — just an address, a
// width, and optionally a pointer chain and a literal value. Maps directly
// onto this codebase's ChainTarget, needing no injection at all. Returns an
// error string (not throwing), same convention as parseForceInjection —
// an entry this doesn't recognize is a normal outcome, not exceptional.
export function parsePlainValueEntry(
  entryOwnContent: string,
  variableType: string
): CheatDefinition | { error: string } {
  const dataType = PLAIN_VARIABLE_TYPES[variableType]
  if (!dataType) return { error: `Unrecognized VariableType "${variableType}".` }

  const rawAddress = extractTag(entryOwnContent, 'Address')
  if (rawAddress === null) return { error: 'No <Address> tag found.' }
  const trimmedAddress = rawAddress.trim()

  const moduleMatch = trimmedAddress.match(/^"([^"]+)"\s*\+\s*([0-9A-Fa-f]+)$/)
  let moduleName: string
  let baseOffset: string
  if (moduleMatch) {
    moduleName = moduleMatch[1]
    baseOffset = '0x' + moduleMatch[2]
  } else if (/^[0-9A-Fa-f]+$/.test(trimmedAddress)) {
    moduleName = ''
    baseOffset = '0x' + trimmedAddress
  } else {
    return { error: `Could not parse address "${rawAddress}".` }
  }

  const offsetsBlock = extractTag(entryOwnContent, 'Offsets')
  const offsets = offsetsBlock
    ? extractTagBlocks(offsetsBlock, 'Offset').map((o) => '0x' + o.trim())
    : []

  const rawValue = extractTag(entryOwnContent, 'Value')
  const parsedValue = rawValue !== null ? parseFloat(rawValue) : 0
  const value = Number.isFinite(parsedValue) ? parsedValue : 0

  return {
    id: '', // filled by the caller, which knows the entry's description
    name: '', // filled by the caller
    dataType,
    mode: 'freeze',
    targets: [{ moduleName, baseOffset, offsets }],
    value
  }
}
```

Add the needed import at the top of the file (line 1 currently reads
`import type { DataType, PatchCheat } from './store'`):

```ts
import type { ChainTarget, CheatDefinition, DataType, PatchCheat } from './store'
```

(`ChainTarget` isn't referenced by name above since the object literal is
inferred, but importing it keeps the type explicit if a future edit adds an
annotation — skip this import if `tsc --noEmit` doesn't flag it as unused;
verify in Step 6.)

- [ ] **Step 4: Wire it into `importCheatTable`'s loop**

In `src/main/ctImport.ts`, modify `importCheatTable` (starting line 189):
change the `imported` array's type and the early-`continue` for non-AA
entries:

```ts
export function importCheatTable(xml: string): CtImportResult {
  const imported: (PatchCheat | CheatDefinition)[] = []
  const skipped: CtImportSkip[] = []

  for (const rawEntry of collectAllCheatEntries(xml)) {
    const entry = ownContent(rawEntry)
    const variableType = extractTag(entry, 'VariableType')
    if (variableType === null) continue // folders, readme headers, etc.

    const rawDescription = extractTag(entry, 'Description') ?? 'Imported cheat'
    const description = unescapeXml(rawDescription).replace(/^"|"$/g, '')

    if (variableType !== 'Auto Assembler Script') {
      const parsed = parsePlainValueEntry(entry, variableType)
      if ('error' in parsed) {
        skipped.push({ description, reason: parsed.error })
        continue
      }
      imported.push({ ...parsed, id: `ct-import-${slugify(description)}`, name: description })
      continue
    }

    const script = extractTag(entry, 'AssemblerScript')
    if (script === null) {
      skipped.push({ description, reason: 'Auto Assembler entry with no script body.' })
      continue
    }

    const parsed = parseForceInjection(unescapeXml(script))
    if ('error' in parsed) {
      skipped.push({ description, reason: parsed.error })
      continue
    }

    const patch: PatchCheat = {
      kind: 'patch',
      mode: 'force',
      id: `ct-import-${slugify(description)}`,
      name: description,
      originalBytes: parsed.originalBytes,
      length: parsed.length,
      signature: parsed.signature,
      signatureOffset: parsed.signatureOffset,
      moduleName: null,
      moduleOffset: null,
      baseRegister: parsed.baseRegister,
      fieldOffset: parsed.fieldOffset,
      value: parsed.value,
      dataType: parsed.dataType
    }
    imported.push(patch)
  }

  return { imported, skipped }
}
```

The `variableType === null` check (instead of the previous "isn't AA, skip
entirely" logic) is deliberate: an entry with NO `VariableType` at all
(a folder/`GroupHeader`, a readme heading) is still silently skipped —
`continue`d, not reported — matching today's exact behavior for those. Only
entries that DO have some `VariableType` but aren't `Auto Assembler
Script` now route into `parsePlainValueEntry` instead of being silently
dropped alongside folders.

Update `CtImportResult`'s type (line 25-28):

```ts
export interface CtImportResult {
  imported: (PatchCheat | CheatDefinition)[]
  skipped: CtImportSkip[]
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/main/ctImport.test.ts`
Expected: all PASS, including every pre-existing test (force-mode/skip
cases unchanged).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If the `ChainTarget` import is flagged unused, remove
it from the import line.

- [ ] **Step 7: Verify `ipc.ts`'s `ct:import` handler still compiles against the widened return type**

`src/main/ipc.ts`'s existing `ct:import` handler (around line 1207-1209)
does `for (const patch of imported) saveCheat(exeName, patch)` and
`imported.map((p) => p.name)` — both already work against any `StoredCheat`
since `saveCheat` takes `StoredCheat` and every variant has `.name`; no
change needed there, but confirm:

Run: `npx tsc --noEmit`
Expected: no errors (already covered by Step 6, called out separately here
since it's the one other file this task's type change touches).

- [ ] **Step 8: Commit**

```bash
git add src/main/ctImport.ts tests/main/ctImport.test.ts
git commit -m "main: import plain CT value entries as freeze cheats"
```

---

### Task 2: Nop-shape and register-copy AA effect classification

**Files:**
- Modify: `src/main/ctImport.ts`
- Test: `tests/main/ctImport.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `parseInjection(script: string): ParsedInjection` (renamed/
  restructured from `parseForceInjection`) returning a new discriminated
  `ParsedInjection` union with `shape: 'nop' | 'copy' | 'force'`; callers
  (the `importCheatTable` loop) build a `PatchCheat` with the matching
  `mode`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/main/ctImport.test.ts`, alongside the existing
`staminaEntry`/`durabilityEntry` fixtures — these are the same real-file
structure with only the effect body changed, matching this file's existing
"trimmed excerpt of a real structure" convention:

```ts
const nopShapeEntry = `
    <CheatEntry>
      <ID>76</ID>
      <Description>"No Fall Damage"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(aobFallDamage,F3 0F 11 AF 18 08 00 00 48 8B 7D)
alloc(newmem,$1000,aobFallDamage)

label(code)
label(return)

newmem:

code:
  jmp return

aobFallDamage:
  jmp newmem
  nop 3
return:
registersymbol(aobFallDamage)

[DISABLE]

aobFallDamage:
  db F3 0F 11 AF 18 08 00 00

unregistersymbol(aobFallDamage)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

const copyShapeEntry = `
    <CheatEntry>
      <ID>77</ID>
      <Description>"Sync Shield to Health"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(aobShield,F3 0F 11 AF 18 08 00 00 48 8B 7D)
alloc(newmem,$1000,aobShield)

label(code)
label(return)

newmem:

code:
  mov [rdi+00000818],eax
  jmp return

aobShield:
  jmp newmem
  nop 3
return:
registersymbol(aobShield)

[DISABLE]

aobShield:
  db F3 0F 11 AF 18 08 00 00

unregistersymbol(aobShield)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`
```

Add tests:

```ts
describe('nop-shape and copy-shape Auto Assembler entries', () => {
  it('imports a provably-empty effect as a nop-mode patch', () => {
    const { imported, skipped } = importCheatTable(wrapTable(nopShapeEntry))
    expect(skipped).toEqual([])
    expect(imported).toHaveLength(1)
    const patch = imported[0] as PatchCheat
    expect(patch.mode).toBe('nop')
    expect(patch.originalBytes).toBe('f30f11af18080000')
    expect(patch.length).toBe(8)
    expect(patch.baseRegister).toBeUndefined()
    expect(patch.value).toBeUndefined()
  })

  it('imports a register-source mov as a copy-mode patch', () => {
    const { imported, skipped } = importCheatTable(wrapTable(copyShapeEntry))
    expect(skipped).toEqual([])
    expect(imported).toHaveLength(1)
    const patch = imported[0] as PatchCheat
    expect(patch.mode).toBe('copy')
    expect(patch.baseRegister).toBe('rdi')
    expect(patch.fieldOffset).toBe('0x818')
    expect(patch.sourceRegister).toBe('eax')
    expect(patch.value).toBeUndefined()
  })

  it('does not misparse a register-source mov as a truncated hex literal', () => {
    // Regression guard for the specific latent bug this task fixes: before
    // the value-group lookahead, "eax" partially matched [0-9A-Fa-f.]+ as
    // "ea", silently importing this as force-mode value 0xea.
    const { imported } = importCheatTable(wrapTable(copyShapeEntry))
    const patch = imported[0] as PatchCheat
    expect(patch.mode).not.toBe('force')
  })

  it('still imports the existing force-mode fixtures unchanged', () => {
    const { imported: staminaImported } = importCheatTable(wrapTable(staminaEntry))
    expect((staminaImported[0] as PatchCheat).mode).toBe('force')
    const { imported: durabilityImported } = importCheatTable(wrapTable(durabilityEntry))
    expect((durabilityImported[0] as PatchCheat).mode).toBe('force')
  })

  it('skips a script whose effect body has unrecognized content, not guessing at any shape', () => {
    const computed = copyShapeEntry.replace(
      'mov [rdi+00000818],eax',
      'imul eax, 2\n  mov [rdi+00000818],eax'
    )
    const { imported, skipped } = importCheatTable(wrapTable(computed))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/main/ctImport.test.ts -t "nop-shape and copy-shape"`
Expected: FAIL — the nop/copy fixtures currently produce a `force`-mode
skip error ("No recognizable 'mov [register+offset], constant' line...")
since `parseForceInjection` has no nop/copy classification yet, and the
computed-effect regression test currently passes vacuously (it's already
skipped today, for the wrong reason).

- [ ] **Step 3: Restructure the classifier**

Replace `parseForceInjection` and its `ParsedInjection` interface (lines
112-178 of `src/main/ctImport.ts`) with:

```ts
interface ParsedInjection {
  shape: 'nop' | 'copy' | 'force'
  signature: string
  signatureOffset: number
  originalBytes: string
  length: number
  baseRegister?: string // absent for nop
  fieldOffset?: string // absent for nop
  sourceRegister?: string // copy only
  value?: number // force only
  dataType?: DataType // force only
}

// Lines that are structural (aobscan/alloc/label declarations, symbol
// (un)registration, dealloc, bare labels, and a plain "jmp <label>") rather
// than an actual effect instruction. Stripping these from the enable
// section is what lets nop-shape be detected as "provably nothing left",
// rather than inferred from "no mov matched" — the latter would silently
// misclassify an unrecognized computed effect (e.g. imul) as a no-op.
function stripStructuralLines(enableSection: string): string[] {
  return enableSection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^(aobscan|alloc|label|registersymbol|unregistersymbol|dealloc)\s*\(/i.test(l))
    .filter((l) => !/^\w+(?:\+[0-9A-Fa-f]+)?:$/.test(l)) // "newmem:", "code:", "INJECT+09:"
    .filter((l) => !/^jmp\s+\w+$/i.test(l))
}

// Parses one Auto Assembler Script into one of three recognized shapes —
// see this module's header comment for why only these three, and why an
// unrecognized effect is skipped rather than guessed at.
function parseInjection(script: string): ParsedInjection | { error: string } {
  const aobMatch = script.match(/aobscan\s*\(\s*(\w+)\s*,\s*([0-9A-Fa-f?\s]+)\)/)
  if (!aobMatch) return { error: 'No aobscan(...) call found — not a byte-pattern-anchored script.' }
  const name = aobMatch[1]
  const signature = aobMatch[2].trim().replace(/\s+/g, ' ').toLowerCase()

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const disableMatch = script.match(
    new RegExp(`${escapedName}(?:\\+([0-9A-Fa-f]+))?\\s*:\\s*\\r?\\n\\s*db\\s+([0-9A-Fa-f\\s]+)`, 'i')
  )
  if (!disableMatch) {
    return {
      error: "Could not find a matching [DISABLE] 'db <bytes>' line — can't recover the original instruction bytes."
    }
  }
  const signatureOffset = disableMatch[1] ? parseInt(disableMatch[1], 16) : 0
  const originalBytes = disableMatch[2].trim().replace(/\s+/g, '').toLowerCase()
  const length = originalBytes.length / 2

  const enableSection = script.split(/\[DISABLE\]/i)[0]
  const base = { signature, signatureOffset, originalBytes, length }

  if (stripStructuralLines(enableSection).length === 0) {
    return { ...base, shape: 'nop' }
  }

  // Tried before the literal-constant form: without this ordering (and the
  // trailing (?![0-9A-Za-z]) lookahead on the literal form's value group,
  // below), "mov [rdi+818], eax" partially matches the literal form's
  // [0-9A-Fa-f.]+ as "ea", silently importing a register-copy script as a
  // bogus force-mode constant 0xea.
  const copyMatch = enableSection.match(
    /\bmov\s+(?:dword\s+ptr\s+)?\[\s*(\w+)\s*\+\s*([0-9A-Fa-f]+)\s*\]\s*,\s*([a-z][a-z0-9]*)\s*$/im
  )
  if (copyMatch) {
    return {
      ...base,
      shape: 'copy',
      baseRegister: copyMatch[1].toLowerCase(),
      fieldOffset: '0x' + parseInt(copyMatch[2], 16).toString(16),
      sourceRegister: copyMatch[3].toLowerCase()
    }
  }

  const movMatch = enableSection.match(
    /\bmov\s+(?:dword\s+ptr\s+)?\[\s*(\w+)\s*\+\s*([0-9A-Fa-f]+)\s*\]\s*,\s*(?:\((float|double)\))?\s*([0-9A-Fa-f.]+)(?![0-9A-Za-z])/i
  )
  if (!movMatch) {
    return {
      error:
        "No recognizable 'mov [register+offset], constant' line in the enable script — this is a more complex " +
        'injection than the simple "replace one write with a fixed value" shape this importer supports.'
    }
  }
  const baseRegister = movMatch[1].toLowerCase()
  const fieldOffset = '0x' + parseInt(movMatch[2], 16).toString(16)
  const isFloat = movMatch[3] !== undefined
  const rawValue = movMatch[4]
  const value = isFloat ? parseFloat(rawValue) : parseInt(rawValue, 16)
  const dataType: DataType = isFloat ? 'float' : 'int32'
  if (!Number.isFinite(value)) {
    return { error: `Could not parse the constant value "${rawValue}" in the enable script.` }
  }

  return { ...base, shape: 'force', baseRegister, fieldOffset, value, dataType }
}
```

The copy-shape regex's `(?![0-9A-Za-z])` trailing lookahead (mirrored onto
the force-shape regex above too) exists for the same reason noted in the
comment: `[a-z][a-z0-9]*`/`[0-9A-Fa-f.]+` must match a whole token, never a
truncated prefix of a longer identifier.

- [ ] **Step 4: Update `importCheatTable` to build the right `PatchCheat` per shape**

Replace the Auto-Assembler branch inside `importCheatTable`'s loop (the
block added in Task 1, Step 4, starting `const parsed =
parseForceInjection(unescapeXml(script))`) with:

```ts
    const parsed = parseInjection(unescapeXml(script))
    if ('error' in parsed) {
      skipped.push({ description, reason: parsed.error })
      continue
    }

    const patch: PatchCheat = {
      kind: 'patch',
      mode: parsed.shape,
      id: `ct-import-${slugify(description)}`,
      name: description,
      originalBytes: parsed.originalBytes,
      length: parsed.length,
      signature: parsed.signature,
      signatureOffset: parsed.signatureOffset,
      moduleName: null,
      moduleOffset: null,
      baseRegister: parsed.baseRegister,
      fieldOffset: parsed.fieldOffset,
      sourceRegister: parsed.sourceRegister,
      value: parsed.value,
      dataType: parsed.dataType
    }
    imported.push(patch)
```

`parsed.shape` is `'nop' | 'copy' | 'force'`, all valid `PatchCheat['mode']`
values (once `docs/superpowers/plans/2026-08-18-ct-copy-mode.md` Task 2 has
added `'copy'` — see this plan's header). `baseRegister`/`fieldOffset` are
`undefined` for the `nop` shape, which matches `PatchCheat`'s existing
optionality for those fields.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/main/ctImport.test.ts`
Expected: all PASS, including every pre-existing test and Task 1's plain-
value tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (requires `docs/superpowers/plans/2026-08-18-ct-copy-
mode.md` Task 2 to already be merged, per this plan's dependency note — if
run standalone first, `mode: parsed.shape` will fail to typecheck against
`PatchCheat['mode']` until `'copy'` exists there).

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/ctImport.ts tests/main/ctImport.test.ts
git commit -m "main: recognize nop-shape and register-copy Auto Assembler scripts"
```

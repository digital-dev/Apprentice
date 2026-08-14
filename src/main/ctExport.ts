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

// JS only switches Number#toString to exponential notation at >=1e21 or
// <1e-6; ctImport.ts's value-capture regex ([0-9A-Fa-f.]+) would treat the
// "e" as a hex digit and silently mis-parse a value like "1e+21" down to
// just "1" on reimport. No plausible game-cheat value is ever this
// large/small, but the guard is cheap and catches the corruption instead of
// letting it through silently.
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/

const MISSING_DATA_REASON =
  'Force-mode patch is missing data needed to reconstruct its Auto Assembler script.'
const UNREPRESENTABLE_REASON =
  "This value cannot be represented in Cheat Engine's Auto Assembler script format."

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
  // fieldOffset is a signed value, stored either as an "0x..."-prefixed hex
  // string (ctImport's own convention, which never produces a negative
  // offset) or as write_watch.cc's signed decimal (a Scanner capture can be
  // negative — see write_watch.cc's displacement fix). BigInt parses both
  // forms; plain string-stripping the "0x" prefix does NOT — a bare decimal
  // string has no prefix to strip and would be reinterpreted as literal hex
  // digits verbatim (e.g. captured offset 16 becoming CE offset 0x16 = 22),
  // and a negative decimal string has no valid hex spelling at all. Signing
  // the CE syntax explicitly (`+18` vs `-4`) rather than folding the sign
  // into the digits keeps this correct for both directions.
  const fieldOffsetVal = BigInt(patch.fieldOffset as string)
  const fieldOffsetSign = fieldOffsetVal < 0n ? '-' : '+'
  const fieldOffsetHex = (fieldOffsetVal < 0n ? -fieldOffsetVal : fieldOffsetVal).toString(16)
  const script = `[ENABLE]
aobscan(${label},${patch.signature})
${label}${offsetSuffix}:
  mov [${patch.baseRegister}${fieldOffsetSign}${fieldOffsetHex}],${formatValue(patch.value as number, patch.dataType as DataType)}

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
    if (missing) {
      skipped.push({ name: patch.name, reason: MISSING_DATA_REASON })
      continue
    }
    // Force-mode's Auto Assembler script can only encode a 32-bit
    // immediate (see ctExport.ts's own module comment and
    // patchEngine.ts's force-mode validation) — every dataType except
    // int32/float is unrepresentable here, not just the old 'byte' type.
    if (patch.dataType !== 'int32' && patch.dataType !== 'float') {
      skipped.push({ name: patch.name, reason: UNREPRESENTABLE_REASON })
      continue
    }
    if ((patch.value as number) < 0) {
      skipped.push({ name: patch.name, reason: UNREPRESENTABLE_REASON })
      continue
    }
    if (patch.dataType === 'float' && !PLAIN_DECIMAL.test(String(patch.value))) {
      skipped.push({ name: patch.name, reason: UNREPRESENTABLE_REASON })
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

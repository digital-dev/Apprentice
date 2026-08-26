import type { CheatDefinition, CheatTarget, ChainTarget, DataType, PatchCheat } from './store'
import { isAnchorTarget, isMonoTarget, patchMode } from './store'

// Builds a Cheat Engine .CT table from this app's own cheats.
//
// Patches: 'nop', 'replace', and 'force' modes all have a direct Auto
// Assembler equivalent — an aobscan finds the instruction, DISABLE's `db`
// line records the original bytes, and ENABLE either nops it out, writes a
// fixed replacement, or forces a constant. 'capture', 'guard', 'immune',
// 'scale', and 'copy' do not: those install a relocated code-cave with
// alloc/label/jmp scaffolding and, for the Mono-anchored ones among them,
// an object pointer resolved fresh every install by walking live Mono
// metadata — reproducing that generically in Auto Assembler would mean
// either baking in this session's one-time resolved address (silently
// wrong on next launch) or reimplementing Mono resolution inside the
// script itself, so these are reported skipped rather than approximated.
//
// Value cheats: a target that's a plain module+offset(+pointer chain) —
// ChainTarget — maps directly onto Cheat Engine's own plain-address
// CheatEntry shape, no Auto Assembler needed at all. A target resolved via
// Mono metadata (MonoTarget) or a capture patch's live pointer
// (AnchorTarget) has no fixed address to hand Cheat Engine and is skipped,
// same reasoning as the unsupported patch modes above. A bitIndex target
// (a single bit inside a byte that packs other, unrelated flags) is also
// skipped — freezing the whole byte in Cheat Engine would clobber bits
// this app deliberately leaves alone.
//
// The output only needs to satisfy Cheat Engine itself, not necessarily
// this codebase's own importCheatTable on the way back in — 'replace'
// mode's arbitrary replacement bytes, for instance, aren't one of
// ctImport.ts's three recognized re-import shapes (nop/copy/force), but
// they're perfectly ordinary `db <bytes>` Auto Assembler for Cheat Engine
// to run.
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

// originalBytes/replacementBytes/signature are stored compacted
// ("f30f11af..."); CE's own db/aobscan lines are space-separated byte
// pairs. Signature already carries its own spaces (see ctImport.ts's
// aobMatch capture) and any ?? wildcards pass through unchanged, so only
// originalBytes/replacementBytes need re-spacing here.
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

const NO_SIGNATURE_REASON =
  "This patch has no byte signature to scan for (Mono-anchored patches without a captured signature can't be relocated by Cheat Engine, which has no Mono resolver of its own)."
const MISSING_DATA_REASON =
  'Force-mode patch is missing data needed to reconstruct its Auto Assembler script.'
const UNREPRESENTABLE_REASON =
  "This value cannot be represented in Cheat Engine's Auto Assembler script format."
const REPLACE_MISMATCH_REASON =
  "This 'replace'-mode patch's replacementBytes is missing or the wrong length."

function unsupportedModeReason(mode: string): string {
  return (
    `'${mode}'-mode patches install a relocated code-cave injection ` +
    "(with, for Mono-anchored ones, an object pointer resolved fresh every install) — " +
    "Cheat Engine's Auto Assembler format has no equivalent this exporter can safely generate."
  )
}

const FORCE_REQUIRED_FIELDS: (keyof PatchCheat)[] = ['baseRegister', 'fieldOffset', 'value', 'dataType']

// Builds the ENABLE block's effect — everything between the label and
// [DISABLE] — for the three exportable modes. Returns an error string
// instead of throwing; the caller has already validated the fields this
// needs to exist, so a failure here means the data didn't match what was
// checked (defensive, not expected in practice).
function enableEffect(patch: PatchCheat): string | { error: string } {
  const mode = patchMode(patch)
  if (mode === 'nop') {
    // Deliberately the `nop` mnemonic, one per line, not a raw `db 90 90
    // ...` line — ctImport.ts's own nop-shape detection only recognizes an
    // ENABLE section with no surviving effect line after stripping
    // structural boilerplate, and a `db` line (unlike a bare `nop`) is
    // never stripped. This is also the form Cheat Engine's own "Auto
    // assemble this address" produces for a plain NOP-out.
    return Array.from({ length: patch.length }, () => '  nop').join('\n')
  }
  if (mode === 'replace') {
    const replacement = (patch.replacementBytes ?? '').toLowerCase()
    if (replacement.length !== patch.length * 2) return { error: REPLACE_MISMATCH_REASON }
    return `  db ${spacedHex(replacement)}`
  }
  // mode === 'force' — every other mode is filtered out by the caller
  // before this is ever reached.
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
  return `  mov [${patch.baseRegister}${fieldOffsetSign}${fieldOffsetHex}],${formatValue(patch.value as number, patch.dataType as DataType)}`
}

function buildPatchEntry(patch: PatchCheat, label: string, effect: string): string {
  const offset = patch.signatureOffset ?? 0
  const offsetSuffix = offset !== 0 ? `+${offset.toString(16)}` : ''
  const script = `[ENABLE]
aobscan(${label},${patch.signature})
${label}${offsetSuffix}:
${effect}

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

function exportPatches(patches: PatchCheat[]): { entries: string[]; exported: string[]; skipped: CtExportSkip[] } {
  const entries: string[] = []
  const exported: string[] = []
  const skipped: CtExportSkip[] = []
  let counter = 0

  for (const patch of patches) {
    const mode = patchMode(patch)
    if (mode !== 'force' && mode !== 'nop' && mode !== 'replace') {
      skipped.push({ name: patch.name, reason: unsupportedModeReason(mode) })
      continue
    }
    if (!patch.signature) {
      skipped.push({ name: patch.name, reason: NO_SIGNATURE_REASON })
      continue
    }
    if (mode === 'force') {
      const missing = FORCE_REQUIRED_FIELDS.some(
        (field) => patch[field] === undefined || patch[field] === null
      )
      if (missing) {
        skipped.push({ name: patch.name, reason: MISSING_DATA_REASON })
        continue
      }
      // Force-mode's Auto Assembler script can only encode a 32-bit
      // immediate (see patchEngine.ts's force-mode validation) — every
      // dataType except int32/float is unrepresentable here.
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
    }

    const effect = enableEffect(patch)
    if (typeof effect !== 'string') {
      skipped.push({ name: patch.name, reason: effect.error })
      continue
    }
    counter++
    entries.push(buildPatchEntry(patch, `patch${counter}`, effect))
    exported.push(patch.name)
  }

  return { entries, exported, skipped }
}

const CE_VARIABLE_TYPE: Record<DataType, string> = {
  int8: 'Byte',
  int16: '2 Bytes',
  int32: '4 Bytes',
  int64: '8 Bytes',
  float: 'Float',
  double: 'Double'
}

function isChainTarget(target: CheatTarget): target is ChainTarget {
  return !isAnchorTarget(target) && !isMonoTarget(target)
}

const NO_FIXED_ADDRESS_REASON =
  "This cheat's target is resolved live (via Mono metadata or a capture patch's tracked pointer), not a fixed address — Cheat Engine has no equivalent resolver of its own."
const BIT_TARGET_REASON =
  "This cheat writes a single bit inside a byte that packs other, unrelated flags — freezing the whole byte in Cheat Engine would clobber bits this app deliberately leaves alone."

function buildValueEntry(cheat: CheatDefinition, target: ChainTarget, label: string): string {
  const dataType = target.dataType ?? cheat.dataType
  const variableType = CE_VARIABLE_TYPE[dataType]
  const address = `"${target.moduleName}"+${BigInt(target.baseOffset).toString(16)}`
  const offsetsXml =
    target.offsets.length === 0
      ? ''
      : `\n      <Offsets>\n${target.offsets
          .map((o) => `        <Offset>${BigInt(o).toString(16)}</Offset>`)
          .join('\n')}\n      </Offsets>`
  return `    <CheatEntry>
      <Description>"${escapeXml(label)}"</Description>
      <VariableType>${variableType}</VariableType>
      <Address>${address}</Address>${offsetsXml}
    </CheatEntry>`
}

function exportValueCheats(cheats: CheatDefinition[]): {
  entries: string[]
  exported: string[]
  skipped: CtExportSkip[]
} {
  const entries: string[] = []
  const exported: string[] = []
  const skipped: CtExportSkip[] = []

  for (const cheat of cheats) {
    const usable = cheat.targets.filter(isChainTarget).filter((t) => t.bitIndex === undefined)
    if (usable.length === 0) {
      // Distinguish the two reasons a cheat ends up with nothing usable:
      // every target is Mono/anchor-resolved (no fixed address at all) vs.
      // every target exists but is a bit flag (an address exists, it's
      // just unsafe to freeze whole).
      const hasChainTarget = cheat.targets.some(isChainTarget)
      skipped.push({
        name: cheat.name,
        reason: hasChainTarget ? BIT_TARGET_REASON : NO_FIXED_ADDRESS_REASON
      })
      continue
    }
    for (const [i, target] of usable.entries()) {
      const label = usable.length > 1 ? `${cheat.name} [${i + 1}/${usable.length}]` : cheat.name
      entries.push(buildValueEntry(cheat, target, label))
    }
    exported.push(cheat.name)
  }

  return { entries, exported, skipped }
}

export function buildCheatTable(patches: PatchCheat[], valueCheats: CheatDefinition[] = []): CtExportResult {
  const patchResult = exportPatches(patches)
  const valueResult = exportValueCheats(valueCheats)

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CheatTable>
  <CheatEntries>
${[...valueResult.entries, ...patchResult.entries].join('\n')}
  </CheatEntries>
</CheatTable>
`
  return {
    xml,
    exported: [...valueResult.exported, ...patchResult.exported],
    skipped: [...valueResult.skipped, ...patchResult.skipped]
  }
}

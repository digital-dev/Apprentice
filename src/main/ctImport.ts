import type { CheatDefinition, DataType, PatchCheat } from './store'

// Imports Cheat Engine .CT tables — specifically, the shapes that cover
// most simple cheats in a real-world table (verified against an actual
// user-supplied file):
//  - plain (non-Auto-Assembler) CheatEntries: an address (optionally
//    module+offset, optionally a pointer chain) and a width, mapped
//    directly onto this codebase's ChainTarget/freeze mode;
//  - nop-shape Auto Assembler scripts, where the enable section reduces to
//    provably nothing (after stripping structural boilerplate) — a pure
//    "disable this instruction" cheat;
//  - copy-shape Auto Assembler scripts, whose sole effect is a
//    register-source mov into [register+offset], mapped onto 'copy' mode;
//  - force-shape Auto Assembler scripts, which replace ONE instruction with
//    a fixed-constant write to [register+offset], mapped onto 'force' mode.
// No general Auto Assembler interpreter is built here, and a script that
// doesn't reduce to one of these shapes (a genuinely multi-effect
// injection) is reported as unsupported rather than guessed at.
//
// A CT's real "code:" block often replays extra instructions CE's own
// injection swallowed (e.g. a trailing `test eax,eax`) before jumping
// back — those are NOT parsed or reproduced here. Tamper's own
// installInjection already replays whatever a live disassembly (decodeRun)
// finds was swallowed by the jump, which is what CE's manual replay lines
// exist to approximate by hand; duplicating that logic here would be
// redundant with, and less robust than, what the engine already does.
export interface CtImportSkip {
  description: string
  reason: string
}

export interface CtImportResult {
  imported: (PatchCheat | CheatDefinition)[]
  skipped: CtImportSkip[]
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

// Extracts every top-level <tag>...</tag> block from `xml`, correctly
// skipping over NESTED blocks of the same tag (CheatEntry nests itself for
// folders/GroupHeaders) rather than matching the first inner close tag —
// a naive non-greedy regex would truncate a folder's own boundaries at its
// first child's close tag instead of its own.
function extractTagBlocks(xml: string, tag: string): string[] {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const blocks: string[] = []
  let i = 0
  while (true) {
    const start = xml.indexOf(open, i)
    if (start === -1) break
    let depth = 1
    let j = start + open.length
    while (depth > 0) {
      const nextOpen = xml.indexOf(open, j)
      const nextClose = xml.indexOf(close, j)
      if (nextClose === -1) {
        // Unbalanced tags: stop scanning rather than loop forever or
        // throw — a malformed or truncated .CT file should report zero
        // importable entries, not crash the import.
        return blocks
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++
        j = nextOpen + open.length
      } else {
        depth--
        j = nextClose + close.length
      }
    }
    blocks.push(xml.slice(start + open.length, j - close.length))
    i = j
  }
  return blocks
}

// Every <CheatEntry> anywhere in the tree, flattened — folders (marked by
// <GroupHeader>1</GroupHeader>) nest their children the same way, and the
// only thing distinguishing a leaf worth importing is having its own
// VariableType/AssemblerScript, checked by the caller.
function collectAllCheatEntries(xml: string): string[] {
  const direct = extractTagBlocks(xml, 'CheatEntry')
  const all: string[] = []
  for (const block of direct) {
    all.push(block)
    all.push(...collectAllCheatEntries(block))
  }
  return all
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match ? match[1] : null
}

// A folder's own <Description>/<VariableType> etc. come before its nested
// <CheatEntries> block in every real CT file, but extractTag has no notion
// of XML nesting depth — applied directly to a folder's raw content, it
// would happily match a DESCENDANT's <VariableType>Auto Assembler
// Script</VariableType> instead of the folder's own (absent) one,
// misidentifying the folder itself as an importable script. Stripping any
// nested <CheatEntries> block first means extractTag only ever sees this
// entry's OWN direct tags.
function ownContent(entryBlock: string): string {
  let result = entryBlock
  for (const block of extractTagBlocks(entryBlock, 'CheatEntries')) {
    result = result.replace(`<CheatEntries>${block}</CheatEntries>`, '')
  }
  return result
}

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

// Lines that are structural (the "[ENABLE]" section header itself,
// aobscan/alloc/label declarations, symbol (un)registration, dealloc, bare
// labels, a plain "jmp <label>", and the "nop [count]" padding CE emits
// under the scanned label to fill out the bytes the 5-byte jmp-to-newmem
// didn't consume) rather than an actual effect instruction. Stripping
// these from the enable section is what lets nop-shape be detected as
// "provably nothing left", rather than inferred from "no mov matched" —
// the latter would silently misclassify an unrecognized computed effect
// (e.g. imul) as a no-op.
function stripStructuralLines(enableSection: string): string[] {
  return enableSection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^\[ENABLE\]$/i.test(l))
    .filter((l) => !/^(aobscan|alloc|label|registersymbol|unregistersymbol|dealloc)\s*\(/i.test(l))
    .filter((l) => !/^\w+(?:\+[0-9A-Fa-f]+)?:$/.test(l)) // "newmem:", "code:", "INJECT+09:"
    // A plain "jmp <label>" (no "+offset" on the label) is a cave-internal
    // return/exit jump (e.g. "jmp return", "jmp code") — filler, not an
    // effect. A "jmp <sym+hex>" targets a specific byte offset INTO the
    // original captured bytes (a jump-over-N-bytes-of-code effect, distinct
    // from nop's "disable everything" semantics) and must survive here so
    // it isn't misclassified as nop.
    .filter((l) => !/^jmp\s+\w+$/i.test(l) || /^jmp\s+\w+\+[0-9A-Fa-f]+$/i.test(l))
    .filter((l) => !/^nop(?:\s+\d+)?$/i.test(l)) // "nop" / "nop 3" byte-padding
}

// x86-64 general-purpose register names (64-bit + their 32-bit aliases,
// since Auto Assembler scripts commonly use the 32-bit form for a dword
// store, e.g. "eax" not "rax"). Used to distinguish a genuine copy-shape
// source register from a bare hex-letter constant (e.g. "deadbeef") that
// happens to match the same [a-z][a-z0-9]* token shape.
const X86_GPR_NAMES = new Set([
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
  'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp',
  'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'
])

// Parses one Auto Assembler Script into one of three recognized shapes
// (nop/copy/force) — see this module's header comment for why only these
// three, and why an unrecognized effect is skipped rather than guessed at.
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
  if (originalBytes.length % 2 !== 0) {
    return {
      error:
        "The [DISABLE] block's byte string has an odd number of hex digits — can't determine the original " +
        'instruction length.'
    }
  }
  const length = originalBytes.length / 2

  const enableSection = script.split(/\[DISABLE\]/i)[0]
  const base = { signature, signatureOffset, originalBytes, length }
  const effectLines = stripStructuralLines(enableSection)

  if (effectLines.length === 0) {
    return { ...base, shape: 'nop' }
  }

  // Copy-shape is only recognized when the register-source mov is the ONLY
  // effect line left after stripping structural boilerplate — unlike
  // force's fixed constant (order-independent: whatever else runs, the
  // literal being written doesn't change), a register copy's correctness
  // depends on nothing else in the enable section having touched that
  // register first. A real CT's replayed "swallowed" instruction (see this
  // module's header comment) is harmless in front of a constant write, but
  // an unmodeled computation (e.g. "imul eax,2") in front of a register
  // copy would silently import the WRONG live value — same category of
  // mistake as the truncation bug below, just at the instruction level
  // instead of the token level. So copy-shape requires isolation; it is
  // checked against the single surviving effect line, not searched for
  // anywhere in the raw enable section.
  //
  // Tried before the literal-constant form below (and with the trailing
  // (?![0-9A-Za-z]) lookahead mirrored onto that form's value group):
  // without both, "mov [rdi+818], eax" partially matches the literal
  // form's [0-9A-Fa-f.]+ as "ea", silently importing a register-copy
  // script as a bogus force-mode constant 0xea.
  if (effectLines.length === 1) {
    const copyMatch = effectLines[0].match(
      /^mov\s+(?:dword\s+ptr\s+)?\[\s*(\w+)\s*\+\s*([0-9A-Fa-f]+)\s*\]\s*,\s*([a-z][a-z0-9]*)$/i
    )
    // A bare hex-letter constant (e.g. "deadbeef", "cafebabe") matches this
    // same [a-z][a-z0-9]* shape as a register name, since CE's Auto
    // Assembler writes force-mode literals with no 0x prefix (see the
    // force-shape comment below). Only accept copy-shape when the captured
    // token is an actual x86 GPR name; otherwise fall through so the
    // force-shape regex gets a chance to read it as the hex literal it is.
    // The destination register (inside [...]) is captured with a bare \w+
    // too — without validating it against the same GPR allowlist, a bogus
    // destination like "xmm0" would import as a copy-mode patch whose
    // baseRegister the native encoder can't handle, throwing AFTER
    // allocateCave and leaking a cave. Gate both registers on the same
    // X86_GPR_NAMES set, with the same fall-through discipline as the
    // source-register check above.
    if (
      copyMatch &&
      X86_GPR_NAMES.has(copyMatch[1].toLowerCase()) &&
      X86_GPR_NAMES.has(copyMatch[3].toLowerCase())
    ) {
      return {
        ...base,
        shape: 'copy',
        baseRegister: copyMatch[1].toLowerCase(),
        fieldOffset: '0x' + parseInt(copyMatch[2], 16).toString(16),
        sourceRegister: copyMatch[3].toLowerCase()
      }
    }
  }

  // Force-shape, unlike copy above, is deliberately searched for anywhere
  // in the raw enable section (not gated on effectLines.length) — this is
  // unchanged from before this task, and real CT files rely on that
  // tolerance: a "code:" block often replays extra instructions CE's own
  // injection swallowed (e.g. a trailing "test eax,eax", or a "movss"
  // preceding the actual "mov"), which don't affect a literal constant
  // write and are already accepted here (see this module's header
  // comment). Requiring isolation here as well would regress those
  // existing, already-supported fixtures.
  //
  // CE writes offsets zero-padded (e.g. [rdi+00000818]) — normalize away
  // the padding so fieldOffset matches this codebase's own convention for
  // hex strings elsewhere (e.g. Scanner-captured patches).
  const movMatch = enableSection.match(
    /\bmov\s+(?:dword\s+ptr\s+)?\[\s*(\w+)\s*\+\s*([0-9A-Fa-f]+)\s*\]\s*,\s*(?:\((float|double)\))?\s*([0-9A-Fa-f.]+)(?![0-9A-Za-z])/i
  )
  // Same destination-register validation as copy-shape above, and for the
  // same reason: an unvalidated destination reaches installInjection's
  // native encoder call and leaks a cave instead of being refused here.
  if (!movMatch || !X86_GPR_NAMES.has(movMatch[1].toLowerCase())) {
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
  // Cheat Engine's Auto Assembler convention: a bare numeric literal is
  // hex (no 0x prefix needed there); a (float)/(double)-cast value is
  // written in ordinary decimal. Different bases for a reason, not a
  // typo — matching CE's own parser here, not guessing one convention for
  // both.
  const value = isFloat ? parseFloat(rawValue) : parseInt(rawValue, 16)
  const dataType: DataType = isFloat ? 'float' : 'int32'
  if (!Number.isFinite(value)) {
    return { error: `Could not parse the constant value "${rawValue}" in the enable script.` }
  }

  return { ...base, shape: 'force', baseRegister, fieldOffset, value, dataType }
}

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
// error string (not throwing), same convention as parseInjection — an
// entry this doesn't recognize is a normal outcome, not exceptional.
//
// Returns Omit<CheatDefinition, 'id' | 'name'> rather than CheatDefinition:
// this function has no idea what id/name to use (the caller derives those
// from the entry's <Description>, deduplicating across the whole table), so
// the type is honest about what it actually produces instead of carrying
// '' placeholders a caller must always overwrite.
export function parsePlainValueEntry(
  entryOwnContent: string,
  variableType: string
): Omit<CheatDefinition, 'id' | 'name'> | { error: string } {
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
    baseOffset = '0x' + BigInt('0x' + moduleMatch[2]).toString(16)
  } else if (/^[0-9A-Fa-f]+$/.test(trimmedAddress)) {
    // A bare hex address with no "module"+offset form can't be relocated
    // across game runs (no module base to re-resolve it against next
    // launch) — none of this codebase's resolvers (ipc.ts, chain_walk.h)
    // treat an empty moduleName as "absolute address, no module", so
    // importing this would silently produce a dead cheat that saves
    // cleanly but never reads or writes anything. Skip it instead of
    // guessing a target that can't actually be resolved.
    return {
      error:
        "Absolute address with no module — can't be relocated across game runs, so this can't be imported as a " +
        'working cheat.'
    }
  } else {
    return { error: `Could not parse address "${rawAddress}".` }
  }

  const offsetsBlock = extractTag(entryOwnContent, 'Offsets')
  const offsets: string[] = []
  if (offsetsBlock) {
    const offsetBlocks = extractTagBlocks(offsetsBlock, 'Offset')
    for (const o of offsetBlocks) {
      const trimmed = o.trim()
      if (!/^[0-9A-Fa-f]+$/.test(trimmed)) {
        return { error: `Malformed offset "${trimmed}" cannot be parsed as hexadecimal.` }
      }
      offsets.push('0x' + BigInt('0x' + trimmed).toString(16))
    }
  }

  // Real CT files don't serialize the current/frozen value as a <Value>
  // element — that tag doesn't exist in Cheat Engine's own format. CE
  // stores it as a Value="..." ATTRIBUTE on <LastState>, alongside other
  // attributes (Activated, RealAddress, ...) whose presence/order isn't
  // fixed, so this matches the attribute specifically rather than assuming
  // any fixed set of siblings.
  const lastStateMatch = entryOwnContent.match(/<LastState\b[^>]*\bValue="([^"]*)"[^>]*>/)
  const parsedValue = lastStateMatch ? parseFloat(lastStateMatch[1]) : 0
  const value = Number.isFinite(parsedValue) ? parsedValue : 0

  return {
    dataType,
    mode: 'freeze',
    targets: [{ moduleName, baseOffset, offsets }],
    value
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'imported-cheat'
  )
}

export function importCheatTable(xml: string): CtImportResult {
  const imported: (PatchCheat | CheatDefinition)[] = []
  const skipped: CtImportSkip[] = []
  // Real CT tables commonly repeat a description across folders (e.g.
  // "Health" in two different folders) — since saveCheat upserts by id,
  // two entries slugifying to the same id would silently collide and the
  // second import would overwrite the first, even though importedNames
  // still lists both. Track slugs already used within this one call and
  // suffix a repeat with -2, -3, etc. so every imported entry keeps its
  // own id.
  const slugCounts = new Map<string, number>()
  const uniqueId = (description: string): string => {
    const slug = slugify(description)
    const count = (slugCounts.get(slug) ?? 0) + 1
    slugCounts.set(slug, count)
    return count === 1 ? `ct-import-${slug}` : `ct-import-${slug}-${count}`
  }

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
      imported.push({ ...parsed, id: uniqueId(description), name: description })
      continue
    }

    const script = extractTag(entry, 'AssemblerScript')
    if (script === null) {
      skipped.push({ description, reason: 'Auto Assembler entry with no script body.' })
      continue
    }

    const parsed = parseInjection(unescapeXml(script))
    if ('error' in parsed) {
      skipped.push({ description, reason: parsed.error })
      continue
    }

    const patch: PatchCheat = {
      kind: 'patch',
      mode: parsed.shape,
      id: uniqueId(description),
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
  }

  return { imported, skipped }
}

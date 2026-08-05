import type { DataType, PatchCheat } from './store'

// Imports Cheat Engine .CT tables — specifically, the one shape that
// covers most simple "infinite X" cheats in a real-world table (verified
// against an actual user-supplied file): an Auto Assembler Script that
// scans for a byte pattern, then replaces ONE instruction with a fixed
// write to [register+offset]. That maps directly onto this codebase's
// existing 'force' mode patch — no general Auto Assembler interpreter is
// built here, and a script that doesn't reduce to this shape (a genuinely
// multi-effect injection) is reported as unsupported rather than guessed
// at.
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
  imported: PatchCheat[]
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
  signature: string
  signatureOffset: number
  originalBytes: string
  length: number
  baseRegister: string
  fieldOffset: string
  value: number
  dataType: DataType
}

// Parses one Auto Assembler Script, expecting exactly the "aobscan finds
// an instruction, [DISABLE]'s db line records its original bytes, the
// [ENABLE] code: block replaces it with mov [reg+offset], constant" shape.
// Returns an error string (not throwing) for anything that doesn't match —
// a script this doesn't recognize is a normal, expected outcome for a
// pattern-matching importer, not an exceptional one.
function parseForceInjection(script: string): ParsedInjection | { error: string } {
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
  const movMatch = enableSection.match(
    /\bmov\s+(?:dword\s+ptr\s+)?\[\s*(\w+)\s*\+\s*([0-9A-Fa-f]+)\s*\]\s*,\s*(?:\((float|double)\))?\s*([0-9A-Fa-f.]+)/i
  )
  if (!movMatch) {
    return {
      error:
        "No recognizable 'mov [register+offset], constant' line in the enable script — this is a more complex " +
        'injection than the simple "replace one write with a fixed value" shape this importer supports.'
    }
  }
  const baseRegister = movMatch[1].toLowerCase()
  // CE writes offsets zero-padded (e.g. [rdi+00000818]) — normalize away
  // the padding so fieldOffset matches this codebase's own convention for
  // hex strings elsewhere (e.g. Scanner-captured patches).
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

  return { signature, signatureOffset, originalBytes, length, baseRegister, fieldOffset, value, dataType }
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
  const imported: PatchCheat[] = []
  const skipped: CtImportSkip[] = []

  for (const rawEntry of collectAllCheatEntries(xml)) {
    const entry = ownContent(rawEntry)
    const variableType = extractTag(entry, 'VariableType')
    if (variableType !== 'Auto Assembler Script') continue // folders, plain values, readme headers, etc.

    const rawDescription = extractTag(entry, 'Description') ?? 'Imported cheat'
    // CT wraps descriptions in escaped literal quotes: "&lt;= Infinite Stamina v2"
    const description = unescapeXml(rawDescription).replace(/^"|"$/g, '')

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

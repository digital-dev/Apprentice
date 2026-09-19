import type { Il2cppMethod } from './il2cppEnumerator'
import { toHex } from './il2cppLayout'

// Picks a method on a field's class where a `capture` patch can record
// `this` (rcx), and builds the persistent signature Tamper re-finds it by.
// A bad hook crashes the game, so every rule here refuses rather than guesses.

export interface HookOps {
  readBytes(address: string, length: number): string | null
  // Instruction rows for a byte run; only `bytes` and `length` are used.
  disasm(hex: string, address: string): { bytes: string; length: number }[]
  // Executable-memory AOB scan; the caller bounds it to the module.
  scanAob(signature: string): Promise<string[]>
}

export interface HookSite {
  method: Il2cppMethod
  // Method start relative to the module base, e.g. "0x5ca073".
  rva: string
  originalBytes: string
  length: number
  signature: string
}

const UPDATE_NAMES = ['Update', 'FixedUpdate', 'LateUpdate']
const SIGNATURE_TARGETS = [16, 24, 32, 48, 64]
const PROLOGUE_BYTES = 64
const MIN_PATCH_BYTES = 5
const MAX_CANDIDATES = 12
// Prologues that are already detours: jmp rel32, jmp rel8, jmp [rip+x],
// mov rax,imm64 (the start of a `mov rax,imm; jmp rax` trampoline). This
// game family runs MelonLoader/Harmony, which rewrite method starts.
const DETOUR_PREFIXES = ['e9', 'eb', 'ff25', '48b8']

const LEGACY_PREFIXES = new Set([0x66, 0x67, 0xf2, 0xf3, 0x2e, 0x3e, 0x26, 0x36, 0x64, 0x65, 0xf0])

export interface InstructionAnalysis {
  // Bytes as hex tokens, with position-dependent displacements as '??'.
  tokens: string[]
  // True when the instruction cannot be replayed verbatim from a code cave
  // (relative branch/call, rip-relative operand, or unparsed VEX/EVEX).
  hazard: boolean
}

// Over-wildcarding is harmless (a wildcard still matches the real byte);
// missing a displacement would break the signature across builds. Opcodes
// without a ModRM byte are simply treated as if the next byte were one.
export function analyzeInstruction(hex: string): InstructionAnalysis {
  const b = Buffer.from(hex, 'hex')
  const tokens = [...b].map((x) => x.toString(16).padStart(2, '0'))
  const wild = (from: number, count: number): void => {
    for (let k = from; k < from + count && k < tokens.length; k++) tokens[k] = '??'
  }

  let i = 0
  while (i < b.length && LEGACY_PREFIXES.has(b[i])) i++
  if (i < b.length && b[i] >= 0x40 && b[i] <= 0x4f) i++
  if (i >= b.length) return { tokens, hazard: false }

  const op = b[i]
  if (op === 0xc4 || op === 0xc5 || op === 0x62) return { tokens: tokens.map(() => '??'), hazard: true }
  if (op === 0xe8 || op === 0xe9) {
    wild(i + 1, 4)
    return { tokens, hazard: true }
  }
  if (op === 0xeb || (op >= 0x70 && op <= 0x7f)) {
    wild(i + 1, 1)
    return { tokens, hazard: true }
  }

  let opLen = 1
  if (op === 0x0f) {
    const op2 = b[i + 1]
    if (op2 !== undefined && op2 >= 0x80 && op2 <= 0x8f) {
      wild(i + 2, 4)
      return { tokens, hazard: true }
    }
    opLen = op2 === 0x38 || op2 === 0x3a ? 3 : 2
  }
  const modrmIndex = i + opLen
  if (modrmIndex < b.length) {
    const modrm = b[modrmIndex]
    if (modrm >> 6 === 0 && (modrm & 7) === 5) {
      wild(modrmIndex + 1, 4)
      return { tokens, hazard: true }
    }
  }
  return { tokens, hazard: false }
}

// Update-style first (fires every frame), then methods that touch the target
// property (accessors, Change*/Set*), then the rest in declaration order.
function preference(m: Il2cppMethod, hint: string | undefined): number {
  if (UPDATE_NAMES.includes(m.name)) return 0
  if (hint !== undefined && hint.length > 0) {
    const lower = m.name.toLowerCase()
    if (lower === `get_${hint}`.toLowerCase() || lower === `set_${hint}`.toLowerCase()) return 1
    if (lower.includes(hint.toLowerCase())) return 2
  }
  return /^(change|set|add|remove|get)/i.test(m.name) ? 3 : 4
}

function orderCandidates(methods: Il2cppMethod[], base: bigint, size: bigint, hint?: string): Il2cppMethod[] {
  const usable = methods.filter((m) => {
    if (m.isStatic || m.name === '.ctor' || m.name === '.cctor') return false
    const p = BigInt(m.pointer)
    return p >= base && p < base + size
  })
  return [...usable].sort((a, b) => preference(a, hint) - preference(b, hint)).slice(0, MAX_CANDIDATES)
}

async function tryMethod(method: Il2cppMethod, ops: HookOps, base: bigint): Promise<HookSite | null> {
  const prologue = ops.readBytes(method.pointer, PROLOGUE_BYTES)
  if (prologue === null) return null
  if (DETOUR_PREFIXES.some((p) => prologue.startsWith(p))) return null

  const rows = ops
    .disasm(prologue, method.pointer)
    .map((r) => ({ bytes: r.bytes.replace(/\s+/g, ''), length: r.length }))
  const analyses = rows.map((r) => analyzeInstruction(r.bytes))

  // Whole instructions covering at least 5 bytes, all replayable from a cave.
  let length = 0
  let covered = 0
  while (covered < rows.length && length < MIN_PATCH_BYTES) {
    if (analyses[covered].hazard) return null
    length += rows[covered].length
    covered++
  }
  if (length < MIN_PATCH_BYTES) return null
  const originalBytes = rows
    .slice(0, covered)
    .map((r) => r.bytes)
    .join('')

  for (const target of SIGNATURE_TARGETS) {
    const tokens: string[] = []
    for (let i = 0; i < rows.length && tokens.length < target; i++) tokens.push(...analyses[i].tokens)
    if (tokens.length < target) break // ran out of decoded bytes; longer tiers cannot help
    const signature = tokens.join(' ')
    const matches = await ops.scanAob(signature)
    if (matches.length === 0) return null
    if (matches.length === 1) {
      if (BigInt(matches[0]) !== BigInt(method.pointer)) return null
      return {
        method,
        rva: toHex(BigInt(method.pointer) - base),
        originalBytes,
        length,
        signature
      }
    }
  }
  return null
}

export async function chooseHookSite(
  methods: Il2cppMethod[],
  ops: HookOps,
  module: { base: string; size: number },
  hint?: string
): Promise<HookSite | null> {
  const base = BigInt(module.base)
  for (const method of orderCandidates(methods, base, BigInt(module.size), hint)) {
    const site = await tryMethod(method, ops, base)
    if (site !== null) return site
  }
  return null
}

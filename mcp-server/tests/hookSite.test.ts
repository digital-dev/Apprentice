import { describe, it, expect } from 'vitest'
import { analyzeInstruction, chooseHookSite, type HookOps } from '../src/factory/hookSite'
import type { Il2cppMethod } from '../src/factory/il2cppEnumerator'

const BASE = 0x7ff600000000n
const MODULE = { base: '0x7ff600000000', size: 0x1000000 }

describe('analyzeInstruction', () => {
  it('wildcards a rel32 call', () => {
    expect(analyzeInstruction('e812345678')).toEqual({ tokens: ['e8', '??', '??', '??', '??'], hazard: true })
  })
  it('wildcards a rip-relative cmp and keeps the trailing immediate', () => {
    expect(analyzeInstruction('803d1234567800')).toEqual({
      tokens: ['80', '3d', '??', '??', '??', '??', '00'],
      hazard: true
    })
  })
  it('wildcards a rip-relative indirect call and a REX-prefixed rip load', () => {
    expect(analyzeInstruction('ff1512345678').tokens).toEqual(['ff', '15', '??', '??', '??', '??'])
    expect(analyzeInstruction('488b0d78563412').tokens).toEqual(['48', '8b', '0d', '??', '??', '??', '??'])
  })
  it('wildcards conditional branches (short and near)', () => {
    expect(analyzeInstruction('7412')).toEqual({ tokens: ['74', '??'], hazard: true })
    expect(analyzeInstruction('0f8412345678').tokens).toEqual(['0f', '84', '??', '??', '??', '??'])
  })
  it('leaves ordinary prologue instructions alone', () => {
    for (const hex of ['48895c2408', '57', '4883ec30', '4889742410']) {
      const r = analyzeInstruction(hex)
      expect(r.hazard).toBe(false)
      expect(r.tokens.join('')).toBe(hex)
    }
  })
  it('treats VEX/EVEX as an unknown hazard and wildcards it entirely', () => {
    expect(analyzeInstruction('c5f877')).toEqual({ tokens: ['??', '??', '??'], hazard: true })
  })
})

function method(name: string, offset: number, isStatic = false): Il2cppMethod {
  return {
    className: 'Cls',
    classPtr: '0x1000',
    name,
    pointer: '0x' + (BASE + BigInt(offset)).toString(16),
    isStatic,
    paramCount: 0
  }
}

// Instruction lists per method start address (relative offset), plus the
// scan results, drive a fake disassembler/AOB scanner.
function opsFor(
  prologues: Record<string, string[]>,
  scans: (sig: string) => string[]
): { ops: HookOps; sigs: string[]; reads: string[] } {
  const sigs: string[] = []
  const reads: string[] = []
  const ops: HookOps = {
    readBytes: (address) => {
      const key = '0x' + BigInt(address).toString(16)
      reads.push(key)
      const instrs = prologues[key]
      if (instrs === undefined) return null
      return (instrs.join('') + '90'.repeat(64)).slice(0, 128)
    },
    disasm: (hex) => {
      const key = Object.keys(prologues).find((k) => hex.startsWith(prologues[k].join('').slice(0, 8)))
      const instrs = key === undefined ? [] : prologues[key]
      return instrs.map((bytes) => ({ bytes, length: bytes.length / 2 }))
    },
    scanAob: async (sig) => {
      sigs.push(sig)
      return scans(sig)
    }
  }
  return { ops, sigs, reads }
}

const GOOD = ['48895c2408', '4889742410', '57', '4883ec30', 'e812345678', '33c0', '4c8d05aabbccdd', '4889442420']
const addr = (offset: number) => '0x' + (BASE + BigInt(offset)).toString(16)

describe('chooseHookSite', () => {
  it('accepts a clean prologue and builds a wildcarded unique signature', async () => {
    const m = method('Update', 0x1000)
    const { ops } = opsFor({ [m.pointer]: GOOD }, () => [m.pointer])
    const site = await chooseHookSite([m], ops, MODULE)
    expect(site).not.toBeNull()
    expect(site!.rva).toBe('0x1000')
    expect(site!.originalBytes).toBe('48895c2408')
    expect(site!.length).toBe(5)
    expect(site!.signature).toBe('48 89 5c 24 08 48 89 74 24 10 57 48 83 ec 30 e8 ?? ?? ?? ??')
  })

  it('grows the signature until it is unique', async () => {
    const m = method('Update', 0x1000)
    const lengths: number[] = []
    const { ops } = opsFor({ [m.pointer]: GOOD }, (sig) => {
      lengths.push(sig.split(' ').length)
      return lengths.length === 1 ? [m.pointer, addr(0x9000)] : [m.pointer]
    })
    const site = await chooseHookSite([m], ops, MODULE)
    expect(site).not.toBeNull()
    expect(lengths[1]).toBeGreaterThan(lengths[0])
  })

  it('skips a candidate whose unique match is not the method start', async () => {
    const m = method('Update', 0x1000)
    const { ops } = opsFor({ [m.pointer]: GOOD }, () => [addr(0x2000)])
    expect(await chooseHookSite([m], ops, MODULE)).toBeNull()
  })

  it('rejects already-detoured prologues (Harmony/MelonLoader)', async () => {
    for (const first of ['e900000000', 'ff2500000000', '48b8aabbccddeeff0011']) {
      const m = method('Update', 0x1000)
      const { ops } = opsFor({ [m.pointer]: [first, ...GOOD] }, () => [m.pointer])
      expect(await chooseHookSite([m], ops, MODULE)).toBeNull()
    }
  })

  it('rejects statics, constructors and out-of-module pointers', async () => {
    const ms = [
      method('Update', 0x1000, true),
      method('.ctor', 0x2000),
      { ...method('Tick', 0x3000), pointer: '0x1234' }
    ]
    const { ops } = opsFor(
      { [ms[0].pointer]: GOOD, [ms[1].pointer]: GOOD, [ms[2].pointer]: GOOD },
      () => []
    )
    expect(await chooseHookSite(ms, ops, MODULE)).toBeNull()
  })

  it('skips a prologue whose first 5 bytes are rip-relative or a branch', async () => {
    const bad = method('Update', 0x1000)
    const good = method('Tick', 0x2000)
    const { ops } = opsFor(
      { [bad.pointer]: ['803d1234567800', ...GOOD.slice(1)], [good.pointer]: GOOD },
      () => [good.pointer]
    )
    const site = await chooseHookSite([bad, good], ops, MODULE)
    expect(site!.method.name).toBe('Tick')
  })

  it('prefers Update-style names', async () => {
    const other = method('DoStuff', 0x1000)
    const update = method('FixedUpdate', 0x2000)
    const { ops, reads } = opsFor({ [other.pointer]: GOOD, [update.pointer]: GOOD }, () => [
      other.pointer,
      update.pointer
    ])
    await chooseHookSite([other, update], ops, MODULE)
    // The Update-style method is examined first even though it is listed last.
    expect(reads[0]).toBe(update.pointer)
  })

  it('returns null when nothing qualifies', async () => {
    const { ops } = opsFor({}, () => [])
    expect(await chooseHookSite([method('Update', 0x1000)], ops, MODULE)).toBeNull()
  })
})

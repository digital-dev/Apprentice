import { describe, it, expect } from 'vitest'
import { buildNativeFactory, resolveRoot, type NativeOps } from '../src/factory/nativeBuild'
import { NATIVE_GAMES } from '../src/factory/nativeGames'

const game = NATIVE_GAMES[0]
const module = { name: 'game.exe', base: '0x140000000', size: 0x5000000 }

// Signature hits at RVA 0x1000 / 0x2000; rel32 sends each to a static slot.
const HITS: Record<string, string> = {
  [game.roots[0].signature]: '0x140001000',
  [game.roots[1].signature]: '0x140002000'
}
const rel32 = (from: number, to: number): string => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(to - (from + 7))
  return b.toString('hex')
}
const OPERANDS: Record<string, string> = {
  '0x140001003': rel32(0x1000, 0x3000),
  '0x140002003': rel32(0x2000, 0x3100)
}

function ops(values: Record<string, number | null>, hits = HITS): NativeOps {
  return {
    scanAob: async (sig) => (sig in hits ? [hits[sig]] : []),
    readBytes: (address) => OPERANDS[address] ?? null,
    readValue: (_base, offsets) => values[offsets.join(',')] ?? null
  }
}

const key = (rva: string, offsets: string[]) => [rva, ...offsets].join(',')
const HP = game.cheats.find((c) => c.category === 'health')!.chains
const RUNES = game.cheats.find((c) => c.category === 'money')!.chains

describe('resolveRoot', () => {
  it('follows the rip-relative operand to the static slot', async () => {
    const r = await resolveRoot(game.roots[0], ops({}), module)
    expect(r).toEqual({ ok: true, address: 0x140003000n })
  })
  it('refuses a signature that matches more than once', async () => {
    const twice: NativeOps = { ...ops({}), scanAob: async () => ['0x140001000', '0x140009000'] }
    const r = await resolveRoot(game.roots[0], twice, module)
    expect(r.ok).toBe(false)
  })
  it('refuses a target outside the module', async () => {
    const far: NativeOps = { ...ops({}), readBytes: () => rel32(0x1000, 0x9000000) }
    expect((await resolveRoot(game.roots[0], far, module)).ok).toBe(false)
  })
})

describe('buildNativeFactory', () => {
  it('drafts chain targets by RVA when the live reads are plausible', async () => {
    const values = {
      [key('0x3000', HP[0])]: 2114,
      [key('0x3000', HP[1])]: 2114,
      [key('0x3100', RUNES[0])]: 99166
    }
    const r = await buildNativeFactory(['health', 'money'], game, ops(values), module)
    expect(r.drafts.map((d) => d.id)).toEqual(['factory-health', 'factory-money'])
    expect(r.drafts[0].targets).toEqual([
      { moduleName: 'game.exe', baseOffset: '0x3000', offsets: HP[0] },
      { moduleName: 'game.exe', baseOffset: '0x3000', offsets: HP[1] }
    ])
    expect(r.drafts[1].targets[0].baseOffset).toBe('0x3100')
    expect(r.checklist[0].liveValues).toEqual([2114, 2114])
  })
  it('reports unresolved when a chain reads null (not in a save)', async () => {
    const r = await buildNativeFactory(['health'], game, ops({}), module)
    expect(r.drafts).toEqual([])
    expect(r.unresolved).toContain('health')
  })
  it('reports unresolved when a value is implausible', async () => {
    const values = { [key('0x3000', HP[0])]: 0, [key('0x3000', HP[1])]: 0 }
    const r = await buildNativeFactory(['health'], game, ops(values), module)
    expect(r.unresolved).toContain('health')
  })
  it('reports categories the game has no chain for, and landmines as manual', async () => {
    const r = await buildNativeFactory(['curfew', 'hunger'], game, ops({}), module)
    expect(r.notFound).toEqual(['curfew'])
    expect(r.manual.map((m) => m.category)).toEqual(['hunger'])
  })
  it('reports a failed root instead of drafting off it', async () => {
    const r = await buildNativeFactory(['health'], game, ops({}, {}), module)
    expect(r.unresolved.some((u) => u.startsWith('root:'))).toBe(true)
  })
})

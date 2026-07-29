import { describe, it, expect } from 'vitest'
import { resolvePatchAddress, AnchorOps, LoadedModule } from '../../src/main/anchor'
import type { PatchCheat } from '../../src/main/store'

const ORIGINAL = 'f30f114110' // 5 bytes

const modulePatch: PatchCheat = {
  kind: 'patch',
  id: 'p1',
  name: 'P1',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.dll',
  moduleOffset: '0x100'
}

const jitPatch: PatchCheat = { ...modulePatch, id: 'p2', moduleName: null, moduleOffset: null }

class FakeOps implements AnchorOps {
  memory = new Map<string, string>()
  matches: string[] = []
  scanCalls: { signature: string; rangeStart?: string; rangeEnd?: string }[] = []

  readBytes(address: string, length: number): string | null {
    const bytes = this.memory.get(address)
    return bytes === undefined ? null : bytes.slice(0, length * 2)
  }
  async scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]> {
    this.scanCalls.push({ signature, rangeStart, rangeEnd })
    return this.matches
  }
}

const modules = new Map<string, LoadedModule>([
  ['game.dll', { name: 'game.dll', base: '0x10000000', size: 0x8000 }]
])
const verified = new Set(['game.dll'])

describe('resolvePatchAddress — arithmetic path', () => {
  it('resolves by module base + RVA without scanning when the bytes match', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', ORIGINAL)
    const result = await resolvePatchAddress(modulePatch, modules, verified, ops)
    expect(result.address).toBe('0x10000100')
    expect(result.scanned).toBe(false)
    expect(ops.scanCalls).toHaveLength(0)
    expect(result.reason).toBeNull()
  })

  it('falls through to a scan when the bytes at the RVA are wrong', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', 'ccccccccccc')
    ops.matches = ['0x10000200']
    ops.memory.set('0x10000200', ORIGINAL)
    const result = await resolvePatchAddress(modulePatch, modules, verified, ops)
    expect(result.address).toBe('0x10000200')
    expect(result.scanned).toBe(true)
    expect(result.relearnedOffset).toBe('0x200')
  })

  it('falls through to a scan when the module is loaded but unverified', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', ORIGINAL)
    ops.matches = ['0x10000100']
    const result = await resolvePatchAddress(modulePatch, modules, new Set(), ops)
    expect(result.address).toBe('0x10000100')
    expect(result.scanned).toBe(true)
  })

  it('bounds the scan to the module range when there is one', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x10000100']
    ops.memory.set('0x10000100', ORIGINAL)
    await resolvePatchAddress(modulePatch, modules, new Set(), ops)
    expect(ops.scanCalls[0].rangeStart).toBe('0x10000000')
    expect(ops.scanCalls[0].rangeEnd).toBe('0x10008000')
  })

  it('reports module-missing when the module is not loaded and nothing matches', async () => {
    const ops = new FakeOps()
    ops.matches = []
    const result = await resolvePatchAddress(modulePatch, new Map(), new Set(), ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('module-missing')
  })

  it('tolerates a malformed moduleOffset instead of throwing', async () => {
    const ops = new FakeOps()
    ops.matches = []
    const bad = { ...modulePatch, moduleOffset: 'not-hex' }
    const result = await resolvePatchAddress(bad, modules, verified, ops)
    expect(result.address).toBeNull()
  })
})

describe('resolvePatchAddress — scan path', () => {
  it('resolves a JIT patch by unbounded scan', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', ORIGINAL)
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBe('0x777000')
    expect(ops.scanCalls[0].rangeStart).toBeUndefined()
  })

  it('applies signatureOffset to the match', async () => {
    const ops = new FakeOps()
    const withLead = { ...jitPatch, signatureOffset: 4 }
    ops.matches = ['0x777000']
    ops.memory.set('0x777004', ORIGINAL)
    const result = await resolvePatchAddress(withLead, modules, verified, ops)
    expect(result.address).toBe('0x777004')
  })

  it('refuses zero matches with not-yet-compiled for a JIT patch', async () => {
    const ops = new FakeOps()
    ops.matches = []
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('not-yet-compiled')
    expect(result.matchCount).toBe(0)
  })

  it('refuses zero matches with no-match for a module patch', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', 'cc'.repeat(5))
    ops.matches = []
    const result = await resolvePatchAddress(modulePatch, modules, verified, ops)
    expect(result.reason).toBe('no-match')
  })

  it('refuses more than one match', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x1', '0x2', '0x3']
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('ambiguous')
    expect(result.matchCount).toBe(3)
  })

  it('refuses a single match whose bytes are not what we captured', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', 'cccccccccc')
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('bytes-differ')
  })

  it('refuses a single match at unreadable memory', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('bytes-differ')
  })

  it('compares bytes case-insensitively', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', ORIGINAL.toUpperCase())
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.address).toBe('0x777000')
  })

  it('does not relearn an offset for a JIT patch', async () => {
    const ops = new FakeOps()
    ops.matches = ['0x777000']
    ops.memory.set('0x777000', ORIGINAL)
    const result = await resolvePatchAddress(jitPatch, modules, verified, ops)
    expect(result.relearnedOffset).toBeNull()
  })
})

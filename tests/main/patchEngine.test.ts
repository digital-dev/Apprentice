import { describe, it, expect, beforeEach } from 'vitest'
import { PatchEngine, PatchOps, nopHex } from '../../src/main/patchEngine'
import type { PatchCheat } from '../../src/main/store'

const ORIGINAL = 'f30f114110' // 5 bytes
const NOPS = '9090909090'

const modulePatch: PatchCheat = {
  kind: 'patch',
  id: 'no-drain',
  name: 'No Drain',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.exe',
  moduleOffset: '0x100'
}

const jitPatch: PatchCheat = { ...modulePatch, id: 'jit-drain', moduleName: null, moduleOffset: null }

// A fake target process: a map of address -> current bytes, plus a module
// table. Lets every locate/apply/restore path be driven deterministically
// without a real process or the native addon.
class FakeOps implements PatchOps {
  memory = new Map<string, string>()
  modules = new Map<string, string>()
  aobMatches: string[] = []
  writeShouldFail = false
  writes: { address: string; bytes: string }[] = []

  getModuleBase(moduleName: string): string | null {
    return this.modules.get(moduleName) ?? null
  }
  readBytes(address: string, length: number): string | null {
    const bytes = this.memory.get(address)
    if (bytes === undefined) return null
    return bytes.slice(0, length * 2)
  }
  writeBytes(address: string, hexBytes: string): boolean {
    if (this.writeShouldFail) return false
    this.memory.set(address, hexBytes)
    this.writes.push({ address, bytes: hexBytes })
    return true
  }
  async scanAob(): Promise<string[]> {
    return this.aobMatches
  }
}

let ops: FakeOps
let engine: PatchEngine

beforeEach(() => {
  ops = new FakeOps()
  ops.modules.set('game.exe', '0x400000')
  ops.memory.set('0x400100', ORIGINAL) // module base + 0x100
  engine = new PatchEngine(ops)
})

describe('nopHex', () => {
  it('produces two hex chars of 0x90 per byte', () => {
    expect(nopHex(5)).toBe(NOPS)
  })
})

describe('PatchEngine.locate', () => {
  it('resolves a module-anchored patch to base + offset with original bytes', async () => {
    const status = await engine.locate(modulePatch)
    expect(status).toEqual({ address: '0x400100', state: 'original', applicable: true })
  })

  it('reports not-found when the module is not loaded', async () => {
    ops.modules.clear()
    const status = await engine.locate(modulePatch)
    expect(status).toEqual({ address: null, state: 'not-found', applicable: false })
  })

  it('reports applied when the bytes there are already NOPs', async () => {
    ops.memory.set('0x400100', NOPS)
    const status = await engine.locate(modulePatch)
    expect(status.state).toBe('applied')
    expect(status.applicable).toBe(true)
  })

  it('reports mismatch when the bytes are neither the original nor NOPs', async () => {
    ops.memory.set('0x400100', 'cccccccccc'.slice(0, 10))
    const status = await engine.locate(modulePatch)
    expect(status.state).toBe('mismatch')
    expect(status.applicable).toBe(false)
  })

  it('relocates a JIT patch by signature when the scan finds exactly one match', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    const status = await engine.locate(jitPatch)
    expect(status).toEqual({ address: '0x7ff000001000', state: 'original', applicable: true })
  })

  it('refuses to guess when the signature scan finds several matches', async () => {
    ops.aobMatches = ['0x7ff000001000', '0x7ff000002000']
    const status = await engine.locate(jitPatch)
    expect(status).toEqual({ address: null, state: 'not-found', applicable: false })
  })

  it('refuses when the signature scan finds nothing', async () => {
    ops.aobMatches = []
    const status = await engine.locate(jitPatch)
    expect(status.applicable).toBe(false)
  })
})

describe('PatchEngine.apply / restore', () => {
  it('writes NOPs at the located address and reports it applied', async () => {
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(NOPS)
    expect(engine.isApplied('no-drain')).toBe(true)
  })

  it('restores the original bytes and forgets the patch', async () => {
    await engine.apply(modulePatch)
    expect(engine.restore(modulePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
    expect(engine.isApplied('no-drain')).toBe(false)
  })

  it('refuses to patch when the bytes do not match the original', async () => {
    ops.memory.set('0x400100', 'cccccccccc')
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("don't match")
    expect(ops.writes).toHaveLength(0)
    expect(engine.isApplied('no-drain')).toBe(false)
  })

  it('refuses to patch when it cannot be located', async () => {
    ops.modules.clear()
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('relocate')
    expect(ops.writes).toHaveLength(0)
  })

  it('does not mark a patch applied when the write fails', async () => {
    ops.writeShouldFail = true
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(engine.isApplied('no-drain')).toBe(false)
  })

  it('applying an already-NOPped patch is a no-op success and becomes restorable', async () => {
    ops.memory.set('0x400100', NOPS)
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(true)
    expect(ops.writes).toHaveLength(0) // nothing needed writing
    expect(engine.isApplied('no-drain')).toBe(true)
    // Still restorable, because apply recorded the address and originals.
    expect(engine.restore(modulePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
  })

  it('restoring a patch that was never applied is a harmless no-op', () => {
    expect(engine.restore(modulePatch)).toBe(true)
    expect(ops.writes).toHaveLength(0)
  })

  it('restores at the address it actually patched, not a re-derived one', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    await engine.apply(jitPatch)
    ops.aobMatches = [] // signature would no longer relocate — must not matter
    expect(engine.restore(jitPatch)).toBe(true)
    expect(ops.memory.get('0x7ff000001000')).toBe(ORIGINAL)
  })

  it('restoreAll restores every applied patch and clears the set', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    await engine.apply(modulePatch)
    await engine.apply(jitPatch)

    engine.restoreAll()

    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
    expect(ops.memory.get('0x7ff000001000')).toBe(ORIGINAL)
    expect(engine.isApplied('no-drain')).toBe(false)
    expect(engine.isApplied('jit-drain')).toBe(false)
  })

  it('restoreAll clears the set even when the writes fail (process already gone)', async () => {
    await engine.apply(modulePatch)
    ops.writeShouldFail = true
    engine.restoreAll()
    expect(engine.isApplied('no-drain')).toBe(false)
  })
})

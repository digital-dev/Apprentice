import { describe, it, expect, beforeEach } from 'vitest'
import { PatchEngine, PatchOps, nopHex, relocationError } from '../../src/main/patchEngine'
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
    expect(status).toEqual({
      address: '0x400100',
      state: 'original',
      applicable: true,
      matchCount: null
    })
  })

  it('reports not-found with no match count when the module is not loaded', async () => {
    ops.modules.clear()
    const status = await engine.locate(modulePatch)
    // matchCount stays null: the module path never scans, so "0 matches"
    // would be a lie that reads as "the code is gone".
    expect(status).toEqual({
      address: null,
      state: 'not-found',
      applicable: false,
      matchCount: null
    })
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
    expect(status).toEqual({
      address: '0x7ff000001000',
      state: 'original',
      applicable: true,
      matchCount: 1
    })
  })

  it('refuses to guess when the signature scan finds several matches, and says how many', async () => {
    ops.aobMatches = ['0x7ff000001000', '0x7ff000002000', '0x7ff000003000']
    const status = await engine.locate(jitPatch)
    expect(status).toEqual({
      address: null,
      state: 'not-found',
      applicable: false,
      matchCount: 3
    })
  })

  it('reports zero matches distinctly from an ambiguous scan', async () => {
    ops.aobMatches = []
    const status = await engine.locate(jitPatch)
    expect(status.applicable).toBe(false)
    // 0 and >1 are opposite problems — the count is what tells them apart.
    expect(status.matchCount).toBe(0)
  })

  it('reports unreadable, keeping the address, when it resolves but memory cannot be read', async () => {
    ops.memory.delete('0x400100')
    const status = await engine.locate(modulePatch)
    expect(status).toEqual({
      address: '0x400100',
      state: 'unreadable',
      applicable: false,
      matchCount: null
    })
  })

  it('reports not-found rather than throwing on a malformed moduleOffset', async () => {
    const junkPatch: PatchCheat = { ...modulePatch, moduleOffset: 'not-hex' }
    const status = await engine.locate(junkPatch)
    expect(status).toEqual({
      address: null,
      state: 'not-found',
      applicable: false,
      matchCount: null
    })
  })
})

describe('relocationError', () => {
  it('names the module when the module-anchored path failed', () => {
    expect(relocationError({ address: null, state: 'not-found', applicable: false, matchCount: null }))
      .toContain('module')
  })

  it('tells the user to re-capture when nothing matched', () => {
    const message = relocationError({
      address: null,
      state: 'not-found',
      applicable: false,
      matchCount: 0
    })
    expect(message).toContain('no longer appears')
    expect(message).toContain('Re-capture')
  })

  it('reports the ambiguous match count so the user knows why it refused', () => {
    const message = relocationError({
      address: null,
      state: 'not-found',
      applicable: false,
      matchCount: 4
    })
    expect(message).toContain('4 places')
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

  it('refuses to patch when it cannot be located, and says why', async () => {
    ops.modules.clear()
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    // The message has to name the actual cause — a bare "can't relocate"
    // is what sent a real debugging session chasing the wrong theory.
    expect(result.error).toContain('module')
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses an ambiguous JIT patch with the match count in the message', async () => {
    ops.aobMatches = ['0x7ff000001000', '0x7ff000002000']
    const result = await engine.apply(jitPatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('2 places')
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses, without writing, when the resolved address is unreadable', async () => {
    ops.memory.delete('0x400100')
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer readable')
    expect(ops.writes).toHaveLength(0)
    expect(engine.isApplied('no-drain')).toBe(false)
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

  it('refuses to write when the address resolves but memory cannot be read', async () => {
    ops.memory.delete('0x400100')
    const result = await engine.apply(modulePatch)
    expect(result.ok).toBe(false)
    expect(ops.writes).toHaveLength(0)
  })

  it('reports not-found rather than throwing when apply hits a malformed moduleOffset', async () => {
    const junkPatch: PatchCheat = { ...modulePatch, moduleOffset: 'not-hex' }
    const result = await engine.apply(junkPatch)
    expect(result.ok).toBe(false)
    expect(ops.writes).toHaveLength(0)
  })

  it('re-applying an already-applied patch is a no-op and does not re-derive the address', async () => {
    ops.aobMatches = ['0x7ff000001000']
    ops.memory.set('0x7ff000001000', ORIGINAL)
    await engine.apply(jitPatch)

    // The JIT code "moved": the scan now resolves a different address B,
    // with original bytes there too. A naive re-locate-and-record would
    // patch B and forget A, orphaning the NOPs already written at A.
    ops.aobMatches = ['0x7ff000002000']
    ops.memory.set('0x7ff000002000', ORIGINAL)
    const result = await engine.apply(jitPatch)

    expect(result.ok).toBe(true)
    expect(ops.memory.get('0x7ff000002000')).toBe(ORIGINAL) // untouched
    expect(ops.writes.filter((w) => w.address === '0x7ff000002000')).toHaveLength(0)

    // restore must still hit the original address A, not the re-derived one.
    expect(engine.restore(jitPatch)).toBe(true)
    expect(ops.memory.get('0x7ff000001000')).toBe(ORIGINAL)
  })
})

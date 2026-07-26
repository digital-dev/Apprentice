import { describe, it, expect, beforeEach } from 'vitest'
import { PatchEngine, PatchOps, nopHex, relocationError, valueBits } from '../../src/main/patchEngine'
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

  caves: string[] = []
  nextCave = 0x50000000
  suspended = 0
  resumed = 0
  suspendShouldFail = false
  runLength = 5
  runDecodable = true
  runRelocatable = true
  encodeJumpCalls: { from: string; to: string }[] = []

  allocateCave(): string | null {
    const address = '0x' + (this.nextCave += 0x1000).toString(16)
    this.caves.push(address)
    return address
  }
  decodeRun(): { length: number; decodable: boolean; relocatable: boolean } {
    return {
      length: this.runLength,
      decodable: this.runDecodable,
      relocatable: this.runRelocatable
    }
  }
  encodeStore(): string {
    return 'c78718080000' + '0000af43' // mov [rdi+0x818], 350.0f
  }
  encodeJump(from: string, to: string): string {
    this.encodeJumpCalls.push({ from, to })
    return 'e900000000'
  }
  suspendThreads(): boolean {
    this.suspended++
    return !this.suspendShouldFail
  }
  resumeThreads(): void {
    this.resumed++
  }
}

const forcePatch: PatchCheat = {
  kind: 'patch',
  mode: 'force',
  id: 'patch-stamina',
  name: 'Stamina',
  originalBytes: ORIGINAL,
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: 'game.exe',
  moduleOffset: '0x100',
  baseRegister: 'rdi',
  fieldOffset: '0x818',
  value: 350,
  dataType: 'float'
}

describe('PatchEngine — force injection', () => {
  it('writes a jump at the site and leaves the cave holding the original bytes in the right order', async () => {
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(true)

    // The site now begins with a jump, padded to the displaced run length.
    const site = ops.memory.get('0x400100') as string
    expect(site.startsWith('e9')).toBe(true)
    expect(site.length / 2).toBe(5)

    // The cave carries the displaced original, then the effect, then the
    // jump back — in that order, not merely containing the original
    // somewhere. The first 8 bytes of the cave are reserved as the
    // capture-mode slot, so the body starts after that offset.
    const codeAddress = '0x' + (BigInt(ops.caves[0]) + 8n).toString(16)
    const effect = 'c787180800000000af43' // FakeOps.encodeStore's fixed output
    const backJump = 'e900000000' // FakeOps.encodeJump's fixed output
    const cave = ops.memory.get(codeAddress) as string
    expect(cave).toBe(ORIGINAL + effect + backJump)

    // The byte arithmetic the brief calls out as the hazard: the back-jump
    // must start exactly after the displaced bytes and the effect, and must
    // return to exactly the end of the displaced run at the site — not to
    // the site's start, and not short by the effect's length.
    const jumpBackFrom =
      '0x' + (BigInt(codeAddress) + BigInt(ORIGINAL.length / 2 + effect.length / 2)).toString(16)
    const returnTo = '0x' + (BigInt('0x400100') + 5n).toString(16)
    expect(ops.encodeJumpCalls).toEqual([
      { from: jumpBackFrom, to: returnTo }, // the back-jump written into the cave
      { from: '0x400100', to: codeAddress } // the site's redirect into the cave
    ])
  })

  it('pads the site with NOPs when the displaced run is longer than the jump', async () => {
    ops.runLength = 8
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(true)
    const site = ops.memory.get('0x400100') as string
    expect(site).toBe('e900000000' + '909090')
  })

  it('refuses, before allocating a cave, when the patch is missing a required force-mode field', async () => {
    const incomplete = { ...forcePatch, id: 'patch-incomplete', fieldOffset: undefined } as PatchCheat
    const result = await engine.apply(incomplete)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it("refuses, before allocating a cave, when the patch's fieldOffset isn't valid hex", async () => {
    const junk = { ...forcePatch, id: 'patch-junk', fieldOffset: 'not-hex' }
    const result = await engine.apply(junk)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses the site write, without leaving threads suspended, when suspension fails', async () => {
    ops.suspendShouldFail = true
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    // The cave write still went through (it needs no suspension); only the
    // site redirect is refused.
    expect(ops.writes).toHaveLength(1)
    expect(ops.resumed).toBe(1)
    expect(engine.isApplied('patch-stamina')).toBe(false)
  })

  it('suspends threads around the site write and resumes them', async () => {
    await engine.apply(forcePatch)
    expect(ops.suspended).toBe(1)
    expect(ops.resumed).toBe(1)
  })

  it('refuses when the displaced run cannot be relocated', async () => {
    ops.runRelocatable = false
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('own address')
    expect(ops.writes).toHaveLength(0)
    expect(engine.isApplied('patch-stamina')).toBe(false)
  })

  it('refuses when the run cannot be decoded', async () => {
    ops.runDecodable = false
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(ops.writes).toHaveLength(0)
  })

  it('refuses when no cave can be allocated', async () => {
    ops.allocateCave = () => null
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('memory')
    expect(ops.writes).toHaveLength(0)
  })

  it('resumes threads even when the site write fails', async () => {
    // The cave write succeeds, the site write does not: threads must not be
    // left suspended, or the game is frozen forever.
    let writes = 0
    const realWrite = ops.writeBytes.bind(ops)
    ops.writeBytes = (address: string, hex: string) => {
      writes++
      return writes === 1 ? realWrite(address, hex) : false
    }
    const result = await engine.apply(forcePatch)
    expect(result.ok).toBe(false)
    expect(ops.resumed).toBe(1)
    expect(engine.isApplied('patch-stamina')).toBe(false)
  })

  it('restores the original bytes and keeps the cave allocated', async () => {
    await engine.apply(forcePatch)
    expect(engine.restore(forcePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
    // Caves are never freed: a thread suspended inside one must still have
    // valid code to return through.
    expect(ops.caves).toHaveLength(1)
  })

  it('restore still writes the original bytes back even when suspension fails', async () => {
    // Unlike install, restore does not refuse on a failed suspend: writing
    // the original bytes back live is the lesser evil next to leaving the
    // game permanently patched.
    await engine.apply(forcePatch)
    ops.suspendShouldFail = true
    expect(engine.restore(forcePatch)).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(ORIGINAL)
  })

  it('still NOPs when the patch has no mode', async () => {
    const legacy = { ...forcePatch, id: 'patch-legacy' } as PatchCheat
    delete (legacy as Partial<PatchCheat>).mode
    const result = await engine.apply(legacy)
    expect(result.ok).toBe(true)
    expect(ops.memory.get('0x400100')).toBe(NOPS)
  })
})

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

describe('valueBits', () => {
  it('converts a float through its IEEE-754 bit pattern', () => {
    // 350.0 as a little-endian IEEE-754 single is 0x43af0000 — writing the
    // integer 350 instead would land as a denormal fraction in the game.
    expect(valueBits(350, 'float')).toBe(0x43af0000)
  })

  it('passes an int32 value through unchanged rather than reinterpreting it', () => {
    expect(valueBits(42, 'int32')).toBe(42)
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

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

const monoPatch: PatchCheat = {
  kind: 'patch',
  id: 'p3',
  name: 'P3',
  originalBytes: 'f30f114110',
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: null,
  moduleOffset: null,
  monoClass: 'Character',
  monoMethod: 'ApplyDamage'
}

class FakeMonoOps {
  monoDllBaseValue: string | null = '0x500000'
  classHandle: string | null = '0xc9'
  methodAddress: string | null = null
  resolveClassCalls = 0
  compileMethodCalls = 0

  monoDllBase(): string | null {
    return this.monoDllBaseValue
  }
  async resolveClass(): Promise<string | null> {
    this.resolveClassCalls++
    return this.classHandle
  }
  async compileMethod(): Promise<string | null> {
    this.compileMethodCalls++
    return this.methodAddress
  }
}

describe('resolvePatchAddress — mono path', () => {
  it('resolves via class+method when the patch names no module', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x700000', ORIGINAL)
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = '0x700000'

    const result = await resolvePatchAddress(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBe('0x700000')
    expect(monoOps.resolveClassCalls).toBe(1)
    expect(monoOps.compileMethodCalls).toBe(1)
  })

  it('reports mono-not-loaded when mono.dll is not in the module list', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.monoDllBaseValue = null

    const result = await resolvePatchAddress(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('mono-not-loaded')
  })

  it('reports mono-assembly-not-loaded when the class does not resolve yet', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.classHandle = null

    const result = await resolvePatchAddress(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('mono-assembly-not-loaded')
  })

  // Mono JIT output is not a stable cross-session signature (a fresh game
  // launch reliably recompiles to different bytes — embedded addresses,
  // register allocation, code layout can all vary), so unlike every other
  // path, the mono path trusts the resolved address on its own rather than
  // gating success on a byte-snapshot comparison. Comparing against
  // patch.originalBytes here made every Mono-anchored patch fail to
  // relocate after every single game restart in practice — the exact
  // "capture once, use once" bug this whole sub-project exists to avoid.
  it('trusts the resolved address even when its bytes differ from the captured snapshot', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x700000', 'cccccccccc')
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = '0x700000'

    const result = await resolvePatchAddress(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBe('0x700000')
    expect(result.reason).toBeNull()
  })

  it('reports not-yet-compiled when the class resolves but the method has no compiled address', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = null

    const result = await resolvePatchAddress(monoPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('not-yet-compiled')
  })

  it('adds monoMethodOffset to the resolved method start', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = '0x700000'
    const offsetPatch = { ...monoPatch, monoMethodOffset: '0xeb' }

    const result = await resolvePatchAddress(offsetPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBe('0x7000eb')
    expect(result.reason).toBeNull()
  })

  it('reports not-yet-compiled rather than throwing when monoMethodOffset is not valid hex', async () => {
    const ops = new FakeOps()
    const monoOps = new FakeMonoOps()
    monoOps.methodAddress = '0x700000'
    const badPatch = { ...monoPatch, monoMethodOffset: 'not-hex' }

    const result = await resolvePatchAddress(badPatch, modules, verified, ops, monoOps as any)
    expect(result.address).toBeNull()
    expect(result.reason).toBe('not-yet-compiled')
  })

  it('does not attempt the mono path for a patch that names a module', async () => {
    const ops = new FakeOps()
    ops.memory.set('0x10000100', ORIGINAL)
    const monoOps = new FakeMonoOps()

    await resolvePatchAddress(modulePatch, modules, verified, ops, monoOps as any)
    expect(monoOps.resolveClassCalls).toBe(0)
  })
})

describe('resolvePatchAddress — module-missing short-circuit', () => {
  it('does not scan when the anchored module is not loaded', async () => {
    const ops = new FakeOps()
    const emptyModules = new Map<string, LoadedModule>() // modules map deliberately does NOT include the patch's moduleName
    const result = await resolvePatchAddress(modulePatch, emptyModules, new Set(), ops)
    expect(result.reason).toBe('module-missing')
    expect(ops.scanCalls).toHaveLength(0)
  })
})

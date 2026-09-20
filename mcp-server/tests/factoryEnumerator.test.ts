import { describe, it, expect } from 'vitest'
import { enumerateMono, type MonoEnumOps } from '../src/factory/monoEnumerator'

const LIVE = '00f0ad0b00000000'
const NULL_PTR = '0000000000000000'

function fakeOps(overrides: Partial<MonoEnumOps> = {}): MonoEnumOps & { staticCalls: string[] } {
  const staticCalls: string[] = []
  const ops: MonoEnumOps = {
    listAssemblyNames: async () => [
      { image: '0x1', name: 'Assembly-CSharp' },
      { image: '0x2', name: 'mscorlib' }
    ],
    listClassesInImage: async (image) =>
      image === '0x1'
        ? [
            { namespaceName: '', className: 'Player', classHandle: '0xa' },
            { namespaceName: '', className: 'Character', classHandle: '0xb' },
            { namespaceName: '', className: 'Boring', classHandle: '0xc' },
            { namespaceName: 'Foo', className: 'PlayerHelper', classHandle: '0xd' }
          ]
        : [{ namespaceName: '', className: 'PlayerFromCorlib', classHandle: '0xe' }],
    listFieldNames: async (h) =>
      h === '0xa' ? ['m_localPlayer', 'm_stamina', 'm_godMode'] : h === '0xb' ? ['m_health'] : [],
    staticFieldAddress: async (h, f) => (h === '0xa' && f === 'm_localPlayer' ? '0x1000' : null),
    readBytes: () => LIVE
  }
  const merged = { ...ops, ...overrides }
  const original = merged.staticFieldAddress
  merged.staticFieldAddress = async (h, f) => {
    staticCalls.push(`${h}.${f}`)
    return original(h, f)
  }
  return Object.assign(merged, { staticCalls })
}

const HINTS = [/player/i, /character/i]

describe('enumerateMono', () => {
  it('lists fields only for hinted, namespace-less classes in the game assembly', async () => {
    const result = await enumerateMono(fakeOps(), HINTS)
    expect(result.classesScanned).toBe(2)
    expect(result.fields).toEqual([
      { className: 'Player', fieldName: 'm_localPlayer' },
      { className: 'Player', fieldName: 'm_stamina' },
      { className: 'Player', fieldName: 'm_godMode' },
      { className: 'Character', fieldName: 'm_health' }
    ])
  })

  it('finds a live static singleton root', async () => {
    const result = await enumerateMono(fakeOps(), HINTS)
    expect(result.roots).toEqual([{ className: 'Player', staticFieldName: 'm_localPlayer' }])
    expect(result.deadRoots).toEqual([])
  })

  it('only probes static storage for singleton-looking names', async () => {
    const ops = fakeOps()
    await enumerateMono(ops, HINTS)
    // Player has a declared root, so it is probed once. Character has none, so only the
    // conventional inherited singleton names are tried on it; no ordinary field is.
    expect(ops.staticCalls).toContain('0xa.m_localPlayer')
    expect(ops.staticCalls.filter((c) => c.startsWith('0xa.'))).toEqual(['0xa.m_localPlayer'])
    for (const call of ops.staticCalls) expect(call).toMatch(/\.(m_localPlayer|m_Instance|_instance|instance|s_Instance|Instance|_Instance)$/)
  })

  it('reports a null-pointer root as dead, not live', async () => {
    const result = await enumerateMono(fakeOps({ readBytes: () => NULL_PTR }), HINTS)
    expect(result.roots).toEqual([])
    expect(result.deadRoots).toEqual([{ className: 'Player', staticFieldName: 'm_localPlayer' }])
  })

  it('falls back to non-system assemblies when there is no Assembly-CSharp', async () => {
    const ops = fakeOps({
      listAssemblyNames: async () => [
        { image: '0x2', name: 'mscorlib' },
        { image: '0x1', name: 'GameCode' }
      ]
    })
    const result = await enumerateMono(ops, HINTS)
    expect(result.classesScanned).toBe(2)
  })
})

describe('enumerateMono inherited singletons', () => {
  it('finds a Singleton<T> root that the class does not declare itself', async () => {
    const ops = fakeOps({
      listFieldNames: async (h) => (h === '0xa' ? ['m_stamina'] : []),
      staticFieldAddress: async (h, f) => (h === '0xa' && f === 'm_Instance' ? '0x2000' : null)
    })
    const result = await enumerateMono(ops, HINTS)
    expect(result.roots).toEqual([{ className: 'Player', staticFieldName: 'm_Instance' }])
  })
  it('reports an inherited root that is still null as dead', async () => {
    const ops = fakeOps({
      listFieldNames: async () => [],
      staticFieldAddress: async (h, f) => (h === '0xa' && f === 'm_Instance' ? '0x2000' : null),
      readBytes: () => NULL_PTR
    })
    const result = await enumerateMono(ops, HINTS)
    expect(result.roots).toEqual([])
    expect(result.deadRoots).toEqual([{ className: 'Player', staticFieldName: 'm_Instance' }])
  })
})

describe('enumerateMono game assemblies', () => {
  it('scans assembly_* alongside a small Assembly-CSharp stub', async () => {
    const ops = fakeOps({
      listAssemblyNames: async () => [
        { image: '0x1', name: 'Assembly-CSharp' },
        { image: '0x3', name: 'assembly_valheim' },
        { image: '0x2', name: 'mscorlib' }
      ],
      listClassesInImage: async (image) =>
        image === '0x3' ? [{ namespaceName: '', className: 'Player', classHandle: '0xa' }] : []
    })
    const result = await enumerateMono(ops, HINTS)
    expect(result.classesScanned).toBe(1)
    expect(result.roots).toEqual([{ className: 'Player', staticFieldName: 'm_localPlayer' }])
  })
  it('lists a root once when two classes share a name', async () => {
    const ops = fakeOps({
      listClassesInImage: async () => [
        { namespaceName: '', className: 'Player', classHandle: '0xa' },
        { namespaceName: '', className: 'Player', classHandle: '0xa' }
      ]
    })
    const result = await enumerateMono(ops, HINTS)
    expect(result.roots).toEqual([{ className: 'Player', staticFieldName: 'm_localPlayer' }])
  })
})

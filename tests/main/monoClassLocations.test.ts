import { describe, it, expect } from 'vitest'
import { findClassLocations, ClassLocationOps } from '../../src/main/monoClassLocations'

class FakeOps implements ClassLocationOps {
  assemblies: { image: string; name: string }[] = []
  classesByImage = new Map<string, { namespaceName: string; className: string }[]>()

  async listAssemblyNames() {
    return this.assemblies
  }
  async listClassesInImage(imageHandle: string) {
    return this.classesByImage.get(imageHandle) ?? []
  }
}

describe('findClassLocations', () => {
  it('returns every assembly that defines a class with this exact name', async () => {
    const ops = new FakeOps()
    ops.assemblies = [
      { image: '0x1', name: 'assembly_valheim' },
      { image: '0x2', name: 'UnityEngine.CoreModule' }
    ]
    ops.classesByImage.set('0x1', [{ namespaceName: '', className: 'Player' }])
    ops.classesByImage.set('0x2', [{ namespaceName: 'UnityEngine', className: 'Player' }])

    const locations = await findClassLocations('Player', ops)
    expect(locations).toEqual(['assembly_valheim', 'UnityEngine.CoreModule'])
  })

  it('returns exactly one assembly for a name that is not ambiguous', async () => {
    const ops = new FakeOps()
    ops.assemblies = [
      { image: '0x1', name: 'assembly_valheim' },
      { image: '0x2', name: 'UnityEngine.CoreModule' }
    ]
    ops.classesByImage.set('0x1', [{ namespaceName: '', className: 'Character' }])
    ops.classesByImage.set('0x2', [{ namespaceName: 'UnityEngine', className: 'GameObject' }])

    const locations = await findClassLocations('Character', ops)
    expect(locations).toEqual(['assembly_valheim'])
  })

  it('returns an empty array when nothing matches', async () => {
    const ops = new FakeOps()
    ops.assemblies = [{ image: '0x1', name: 'assembly_valheim' }]
    ops.classesByImage.set('0x1', [{ namespaceName: '', className: 'Character' }])

    const locations = await findClassLocations('NoSuchClass', ops)
    expect(locations).toEqual([])
  })

  it('returns an empty array when there are no loaded assemblies', async () => {
    const ops = new FakeOps()
    const locations = await findClassLocations('Player', ops)
    expect(locations).toEqual([])
  })
})

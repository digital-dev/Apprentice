import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number
let monoBase: string

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
  const reply = await send('loadmono')
  monoBase = reply.split(' ')[1]
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('monoResolveClass', () => {
  it('resolves a real class by namespace and name', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    expect(klass).toMatch(/^0x[0-9a-f]+$/)
  })

  it('resolves a different class to a different handle', async () => {
    const player = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const character = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    expect(character).not.toBe(player)
  })

  it('returns null for a class that does not exist', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'NoSuchClass')
    expect(klass).toBeNull()
  })
})

describe('monoResolveField', () => {
  it('finds a known field and its offset', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const field = await (addon as any).monoResolveField(handle, monoBase, klass, 'm_godMode')
    expect(field.offset).toBe(0x691)
  })

  it('returns null for a field that does not exist on that class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const field = await (addon as any).monoResolveField(handle, monoBase, klass, 'not_a_field')
    expect(field).toBeNull()
  })
})

describe('monoStaticFieldAddress', () => {
  it('finds the storage address of a field, distinct from its offset', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const addr = await (addon as any).monoStaticFieldAddress(handle, monoBase, klass, 'm_localPlayer')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)
  })

  // The actual bug this whole path exists to not have again: an earlier
  // version returned the field's own MonoClassField* (Mono's internal
  // metadata describing the field) instead of mono_class_vtable's
  // static-data blob base + the field's offset — a real, stable, plausible
  // -looking pointer that has nothing to do with where the field's value
  // actually lives. Two fields on the SAME class, at known, DIFFERENT
  // fixture offsets (probe_mono.c: m_localPlayer=0x10, m_godMode=0x691),
  // must resolve to addresses that differ by EXACTLY that same delta —
  // proving this is genuinely `staticDataBase + offset` arithmetic against
  // one shared blob, not two independent, unrelated-by-construction
  // pointers that merely both happen to look like valid addresses.
  it('resolves two static fields on the same class exactly offset.delta apart', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const localPlayerAddr = await (addon as any).monoStaticFieldAddress(handle, monoBase, klass, 'm_localPlayer')
    const godModeAddr = await (addon as any).monoStaticFieldAddress(handle, monoBase, klass, 'm_godMode')
    const delta = BigInt(godModeAddr) - BigInt(localPlayerAddr)
    expect(delta).toBe(BigInt(0x691 - 0x10))
  })
})

describe('monoCompileMethod', () => {
  it('finds a known method and compiles it to a stable address', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    const addr1 = await (addon as any).monoCompileMethod(handle, monoBase, klass, 'ApplyDamage')
    expect(addr1).toMatch(/^0x[0-9a-f]+$/)
    const addr2 = await (addon as any).monoCompileMethod(handle, monoBase, klass, 'ApplyDamage')
    expect(addr2).toBe(addr1)
  })

  it('returns null for a method that does not exist on that class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const addr = await (addon as any).monoCompileMethod(handle, monoBase, klass, 'NoSuchMethod')
    expect(addr).toBeNull()
  })

  it('distinguishes methods on different classes with the same iteration shape', async () => {
    const player = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const stamina = await (addon as any).monoCompileMethod(handle, monoBase, player, 'UseStamina')
    const character = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    const damage = await (addon as any).monoCompileMethod(handle, monoBase, character, 'ApplyDamage')
    expect(stamina).not.toBeNull()
    expect(damage).not.toBeNull()
    expect(stamina).not.toBe(damage)
  })
})

describe('monoListAssemblies', () => {
  it('finds both fake assemblies', async () => {
    const assemblies = await (addon as any).monoListAssemblies(handle, monoBase)
    expect(assemblies.length).toBe(2)
    expect(assemblies[0]).toMatch(/^0x[0-9a-f]+$/)
    expect(assemblies[1]).toMatch(/^0x[0-9a-f]+$/)
  })
})

describe('monoResolveClass cross-assembly scoping', () => {
  it('skips a non-matching assembly and finds the class in the next one', async () => {
    // Player lives only in the first fake assembly's image, Character only
    // in the second's — mono_class_from_name is scoped per-image in the
    // fixture, so finding both proves the search walks past a miss instead
    // of getting stuck on (or wrongly matching against) the wrong image.
    const player = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const character = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    expect(player).toMatch(/^0x[0-9a-f]+$/)
    expect(character).toMatch(/^0x[0-9a-f]+$/)
    expect(character).not.toBe(player)
  })
})

describe('monoListFieldNames / monoListMethodNames', () => {
  it('lists every field name on a class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const names = await (addon as any).monoListFieldNames(handle, monoBase, klass)
    expect(names.sort()).toEqual(['m_godMode', 'm_localPlayer'])
  })

  it('lists every method name on a class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    const names = await (addon as any).monoListMethodNames(handle, monoBase, klass)
    expect(names).toEqual(['ApplyDamage'])
  })
})

describe('monoCallAttached', () => {
  it('calls an arbitrary function on an attached thread and captures its float return (XMM0)', async () => {
    const fn = await (addon as any).resolveExport(handle, monoBase, 'probe_get_float')
    const result = await (addon as any).monoCallAttached(handle, monoBase, fn, ['0x1234'])
    expect(result.float).toBeCloseTo(42.5, 5)
  })

  it('calls an arbitrary function on an attached thread and captures its integer return (RAX)', async () => {
    const fn = await (addon as any).resolveExport(handle, monoBase, 'probe_get_int')
    const result = await (addon as any).monoCallAttached(handle, monoBase, fn, ['0x1234'])
    expect(result.int).toBe('0x1235') // probe_get_int returns obj + 1
  })

  it('resolves null when the target function address does not exist', async () => {
    const result = await (addon as any).monoCallAttached(handle, monoBase, '0x1', [])
    expect(result).toBeNull()
  })

  it('passes a float argument in the correct positional XMM register (position 2 -> XMM1)', async () => {
    // probe_set_float(void* obj, float value) doubles and returns value —
    // proves the float genuinely arrived via XMM1, not garbage from
    // whatever the args[] placeholder or a stale register held.
    const fn = await (addon as any).resolveExport(handle, monoBase, 'probe_set_float')
    const result = await (addon as any).monoCallAttached(handle, monoBase, fn, ['0x1234', '0x0'], 1, 21.5)
    expect(result.float).toBeCloseTo(43.0, 4)
  })
})

describe('monoListAssemblyNames', () => {
  it('pairs every assembly image handle with a human-readable name', async () => {
    const results = await (addon as any).monoListAssemblyNames(handle, monoBase)
    expect(results).toHaveLength(2)
    const names = results.map((r: any) => r.name).sort()
    expect(names).toEqual(['FakeAssemblyA', 'FakeAssemblyB'])
    for (const r of results) {
      expect(r.image).toMatch(/^0x[0-9a-f]+$/)
    }
  })
})

describe('monoListClassesInImage', () => {
  it('lists every class in the given image, scoped to that image only', async () => {
    const assemblies = await (addon as any).monoListAssemblyNames(handle, monoBase)
    const a = assemblies.find((r: any) => r.name === 'FakeAssemblyA')
    const classesA = await (addon as any).monoListClassesInImage(handle, monoBase, a.image)
    expect(classesA).toHaveLength(1)
    expect(classesA[0].namespaceName).toBe('')
    expect(classesA[0].className).toBe('Player')
    expect(classesA[0].classHandle).toMatch(/^0x[0-9a-f]+$/)

    const b = assemblies.find((r: any) => r.name === 'FakeAssemblyB')
    const classesB = await (addon as any).monoListClassesInImage(handle, monoBase, b.image)
    expect(classesB).toHaveLength(1)
    expect(classesB[0].namespaceName).toBe('')
    expect(classesB[0].className).toBe('Character')
    expect(classesB[0].classHandle).toMatch(/^0x[0-9a-f]+$/)
  })

  it('resolves the same class token->address arithmetic real Mono callers rely on', async () => {
    // Exercises the row+1 / MONO_TOKEN_TYPE_DEF token math against the
    // fixture's own decoding of it (see probe_mono.c's mono_class_get) —
    // a genuinely independent check of the arithmetic, not just "some
    // class came back".
    const assemblies = await (addon as any).monoListAssemblyNames(handle, monoBase)
    const a = assemblies.find((r: any) => r.name === 'FakeAssemblyA')
    const classes = await (addon as any).monoListClassesInImage(handle, monoBase, a.image)
    expect(classes.map((c: any) => c.className)).toContain('Player')
  })

  // The whole point of returning classHandle at all: it must be the SAME
  // handle a name-only monoResolveClass would produce for that class, so a
  // caller can use it directly (Explorer's "Use as value target"/"Use as
  // patch anchor", or search-index building) instead of a second, separate
  // resolve — the ambiguous-by-name resolve that silently picked the wrong
  // same-named class over and over while indexing.
  it('classHandle matches what monoResolveClass produces for the same class', async () => {
    const assemblies = await (addon as any).monoListAssemblyNames(handle, monoBase)
    const a = assemblies.find((r: any) => r.name === 'FakeAssemblyA')
    const classes = await (addon as any).monoListClassesInImage(handle, monoBase, a.image)
    const player = classes.find((c: any) => c.className === 'Player')

    const resolved = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    expect(player.classHandle).toBe(resolved)
  })
})

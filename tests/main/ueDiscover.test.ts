import { describe, it, expect } from 'vitest'
import { discoverUeConfig, probeNamePool } from '../../src/main/ueDiscover'
import { resolveUeRootTargetAddress, resolveUeMultiTargetAddresses, resolveInheritedFieldOffset, createUeInstanceCache, type ReadBytes } from '../../src/main/ueTargetResolve'
import type { UeConfig } from '../../src/main/profile'
import type { UeTarget } from '../../src/main/store'

class FakeMemory {
  private regions: { start: bigint; data: Buffer }[] = []
  write(address: string | bigint, data: Buffer): void {
    this.regions.push({ start: BigInt(address), data })
  }
  read: ReadBytes = (address, length) => {
    const start = BigInt(address)
    for (const r of this.regions) {
      const off = start - r.start
      if (off >= 0n && off + BigInt(length) <= BigInt(r.data.length)) return r.data.subarray(Number(off), Number(off) + length).toString('hex')
    }
    return null
  }
  ptr(address: string | bigint, target: string | bigint): void {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(target))
    this.write(address, b)
  }
  fname(address: string | bigint, index: number): void {
    const b = Buffer.alloc(8)
    b.writeInt32LE(index, 0)
    this.write(address, b)
  }
}

// UE4-style header (length << 1), stride 2, 16 block bits: the first layouts probed do not decode it.
const SHIFT = 1
const POOL_BASE = 0x2000n
const BLOCK = 0x7000n

// Lays names out back to back the way the engine does; returns each name's comparison index.
function buildPool(mem: FakeMemory, names: string[]): Record<string, number> {
  mem.ptr(POOL_BASE + 0x10n, BLOCK)
  const indexes: Record<string, number> = {}
  let offset = 0
  for (const name of names) {
    const size = 2 + Buffer.byteLength(name)
    const buf = Buffer.alloc(size)
    buf.writeUInt16LE(Buffer.byteLength(name) << SHIFT, 0)
    buf.write(name, 2, 'utf8')
    mem.write(BLOCK + BigInt(offset), buf)
    indexes[name] = offset / 2
    offset += size + (size % 2)
  }
  return indexes
}

const NAMES = ['None', 'ByteProperty', 'Object', 'Class', 'Player', 'Base', 'MoveComp', 'Move', 'Speed', 'Default__Player', 'Player_0', 'PlayerBP']

describe('probeNamePool', () => {
  it('finds a layout the first candidates would not decode', () => {
    const mem = new FakeMemory()
    buildPool(mem, NAMES)
    const cfg = probeNamePool(mem.read, '0x' + POOL_BASE.toString(16))
    expect(cfg).toMatchObject({ blockOffsetBits: 16, nameEntryStride: 2, stringOffset: 2, lengthShiftCount: 1 })
  })

  it('rejects memory that is not a name pool', () => {
    const mem = new FakeMemory()
    mem.write(POOL_BASE, Buffer.alloc(64))
    expect(probeNamePool(mem.read, '0x' + POOL_BASE.toString(16))).toBeNull()
  })
})

const ARRAY = 0x3000n
const CHUNK = 0x4000n
const A = {
  classClass: 0x9100n,
  objectClass: 0x9200n,
  playerClass: 0x9000n,
  baseClass: 0x9300n,
  moveClass: 0x9400n,
  cdo: 0xa000n,
  player: 0xa100n,
  move: 0xa200n,
  bpClass: 0x9500n
}
const hex = (v: bigint): string => '0x' + v.toString(16)

// Object array: Object class, Player class, CDO, instance. Player -> Base (Move field); MoveComp has Speed.
function buildWorld(mem: FakeMemory, idx: Record<string, number>, opts: { blueprintInstance?: boolean } = {}): void {
  mem.ptr(ARRAY, CHUNK)
  const chunk = Buffer.alloc(16 * 24)
  ;[A.objectClass, A.playerClass, A.cdo, A.player].forEach((o, i) => chunk.writeBigUInt64LE(o, i * 24))
  mem.write(CHUNK, chunk)
  const obj = (o: bigint, cls: bigint, name: string): void => {
    mem.ptr(o + 0x10n, cls)
    mem.fname(o + 0x18n, idx[name])
  }
  obj(A.objectClass, A.classClass, 'Object')
  obj(A.playerClass, A.classClass, 'Player')
  obj(A.baseClass, A.classClass, 'Base')
  obj(A.moveClass, A.classClass, 'MoveComp')
  obj(A.cdo, A.playerClass, 'Default__Player')
  // A running game's instance is usually of a Blueprint subclass of the C++ class.
  obj(A.player, opts.blueprintInstance ? A.bpClass : A.playerClass, 'Player_0')
  obj(A.bpClass, A.classClass, 'PlayerBP')
  mem.ptr(A.bpClass + 0x40n, A.playerClass)
  obj(A.move, A.moveClass, 'MoveComp')
  obj(A.classClass, A.classClass, 'Class')
  mem.ptr(A.playerClass + 0x40n, A.baseClass)
  const field = (owner: bigint, f: bigint, name: string, offset: number): void => {
    mem.ptr(owner + 0x50n, f)
    mem.fname(f + 0x28n, idx[name])
    mem.write(f + 0x4cn, Buffer.from([offset, 0, 0, 0]))
    mem.ptr(f + 0x20n, 0n)
  }
  field(A.baseClass, 0xb000n, 'Move', 0x20)
  field(A.moveClass, 0xb100n, 'Speed', 0x30)
  mem.ptr(A.player + 0x20n, A.move)
}

const CONFIG: UeConfig = {
  gNames: { gNamesBase: hex(POOL_BASE), blockOffsetBits: 16, nameEntryStride: 2, stringOffset: 2, headerOffset: 0, lengthShiftCount: SHIFT },
  gObjectArray: { chunksArrayBase: hex(ARRAY), numElementsPerChunk: 16, itemStride: 24, itemInitialOffset: 0 }
}

const target = (over: Partial<UeTarget>): UeTarget => ({
  kind: 'ue',
  className: 'Player',
  rootClass: 'Player',
  fieldName: 'Speed',
  maxObjectsToScan: 16,
  ...over
})

describe('root-path targets', () => {
  it('follows an inherited pointer field to the component and adds the field offset', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    const cache = createUeInstanceCache()
    expect(resolveUeRootTargetAddress(target({ path: ['Move'] }), CONFIG, mem.read, cache)).toBe(hex(A.move + 0x30n))
    expect(cache.roots.get('Player')).toBe(hex(A.player))
  })

  it('finds an inherited field by walking SuperStruct', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    expect(resolveInheritedFieldOffset(mem.read, CONFIG.gNames, hex(A.playerClass), 'Move')).toEqual({ offset: 0x20 })
  })

  it('finds an instance of a Blueprint subclass of the root class', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES), { blueprintInstance: true })
    expect(resolveUeRootTargetAddress(target({ path: ['Move'] }), CONFIG, mem.read, createUeInstanceCache())).toBe(hex(A.move + 0x30n))
  })

  it("follows '^Outer' through OuterPrivate instead of a reflected field", () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    // In this fixture the player's +0x20 slot points at the move component, so its Outer is that object.
    expect(resolveUeRootTargetAddress(target({ path: ['^Outer'] }), CONFIG, mem.read, createUeInstanceCache())).toBe(hex(A.move + 0x30n))
  })

  it('skips an instance whose Outer is a class default object (a default subobject, not a live one)', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    mem.ptr(A.player + 0x20n, A.cdo)
    expect(resolveUeRootTargetAddress(target({}), CONFIG, mem.read, createUeInstanceCache())).toBeNull()
  })

  it('resolves every live instance of an all-instances target and caches the instance list', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    const cache = createUeInstanceCache()
    const t = target({ path: ['Move'], allInstances: true })
    expect(resolveUeMultiTargetAddresses(t, CONFIG, mem.read, cache, 1000)).toEqual([hex(A.move + 0x30n)])
    expect(cache.instances.get('Player')?.objects).toEqual([hex(A.player)])
    // a repeat inside the TTL does not walk the object array again
    mem.ptr(ARRAY, 0n)
    expect(resolveUeMultiTargetAddresses(t, CONFIG, mem.read, cache, 2000)).toEqual([hex(A.move + 0x30n)])
  })

  it('returns no addresses for an all-instances target whose class is missing', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    const t = target({ rootClass: 'Nope', allInstances: true })
    expect(resolveUeMultiTargetAddresses(t, CONFIG, mem.read, createUeInstanceCache())).toEqual([])
  })

  it('returns null for an unknown path step', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    expect(resolveUeRootTargetAddress(target({ path: ['Nope'] }), CONFIG, mem.read, createUeInstanceCache())).toBeNull()
  })

  it('does not trust a stale cached instance and re-scans, skipping the class default object', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    const cache = createUeInstanceCache()
    cache.roots.set('Player', '0xdead0000')
    expect(resolveUeRootTargetAddress(target({ path: ['Move'] }), CONFIG, mem.read, cache)).toBe(hex(A.move + 0x30n))
    expect(cache.roots.get('Player')).toBe(hex(A.player))
  })

  it('serves a repeat resolve from the target cache with a handful of reads, and re-resolves when a link changes', () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    const cache = createUeInstanceCache()
    const t = target({ path: ['Move'] })
    resolveUeRootTargetAddress(t, CONFIG, mem.read, cache)
    let reads = 0
    const counting: ReadBytes = (a, n) => (reads++, mem.read(a, n))
    expect(resolveUeRootTargetAddress(t, CONFIG, counting, cache)).toBe(hex(A.move + 0x30n))
    expect(reads).toBeLessThanOrEqual(4)
    // the component pointer now reads differently: the cached address must not be reused
    cache.targets.get('Player/Move/Speed')!.links[1].value = '0x1'
    expect(resolveUeRootTargetAddress(t, CONFIG, mem.read, cache)).toBe(hex(A.move + 0x30n))
    expect(cache.targets.get('Player/Move/Speed')!.links[1].value).toBe(hex(A.move))
  })
})

describe('discoverUeConfig', () => {
  function code(mem: FakeMemory, at: bigint, opcode: number[], global: bigint): void {
    const rel = Buffer.alloc(4)
    rel.writeInt32LE(Number(global - (at + 7n)))
    mem.write(at, Buffer.from([...opcode, ...rel]))
  }

  it('finds both roots from code and validates them', async () => {
    const mem = new FakeMemory()
    buildWorld(mem, buildPool(mem, NAMES))
    mem.ptr(0x2100n, ARRAY) // the global the object-array code loads holds the chunk array pointer
    code(mem, 0x1000n, [0x48, 0x8d, 0x05], POOL_BASE)
    code(mem, 0x1100n, [0x48, 0x8b, 0x05], 0x2100n)
    const found = await discoverUeConfig({
      readBytes: mem.read,
      scanAob: async (sig) => (sig.startsWith('48 8D 05') ? ['0x1000'] : ['0x1100'])
    })
    expect(found?.gNames).toMatchObject({ gNamesBase: '0x2000', lengthShiftCount: 1 })
    expect(found?.gObjectArray).toMatchObject({ chunksArrayBase: '0x3000', itemStride: 24 })
  })

  it('returns null when no signature hits', async () => {
    expect(await discoverUeConfig({ readBytes: () => null, scanAob: async () => [] })).toBeNull()
  })
})

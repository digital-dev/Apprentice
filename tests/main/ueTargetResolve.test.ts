import { describe, it, expect } from 'vitest'
import {
  decodeFName,
  walkProperties,
  resolveFieldOffset,
  resolveClassAddress,
  resolveUeTargetAddress,
  fieldLayoutFor,
  FIELD_LAYOUTS,
  ueRootKey,
  type ReadBytes
} from '../../src/main/ueTargetResolve'
import type { UeTarget } from '../../src/main/store'
import type { UeConfig } from '../../src/main/profile'

// A tiny in-memory "process" model: addresses are hex strings, content is
// Buffers. readBytes slices from whichever buffer's address range contains
// the request -- close enough to real ReadProcessMemory semantics for
// these pure, formula-level tests (no live process needed at all).
class FakeMemory {
  private regions: { start: bigint; data: Buffer }[] = []

  write(address: string, data: Buffer): void {
    this.regions.push({ start: BigInt(address), data })
  }

  read: ReadBytes = (address, length) => {
    const start = BigInt(address)
    for (const region of this.regions) {
      const offset = start - region.start
      if (offset >= 0n && offset + BigInt(length) <= BigInt(region.data.length)) {
        return region.data.subarray(Number(offset), Number(offset) + length).toString('hex')
      }
    }
    return null
  }
}

function addr(base: string, delta: number): string {
  return '0x' + (BigInt(base) + BigInt(delta)).toString(16)
}

function pointerBuf(target: string): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(target), 0)
  return buf
}

function fnameBuf(comparisonIndex: number, number = 0): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeInt32LE(comparisonIndex, 0)
  buf.writeInt32LE(number, 4)
  return buf
}

function nameEntryBuf(name: string, wide: boolean, lengthShiftCount: number, stringOffset: number): Buffer {
  const stringBytes = wide ? Buffer.from(name, 'utf16le') : Buffer.from(name, 'utf8')
  const len = wide ? stringBytes.length / 2 : stringBytes.length
  const header = (len << lengthShiftCount) | (wide ? 1 : 0)
  const buf = Buffer.alloc(stringOffset + stringBytes.length)
  buf.writeUInt16LE(header, 0)
  stringBytes.copy(buf, stringOffset)
  return buf
}

const POOL: UeConfig['gNames'] = {
  gNamesBase: '0x2000',
  blockOffsetBits: 8,
  nameEntryStride: 2,
  stringOffset: 2,
  headerOffset: 0,
  lengthShiftCount: 1
}

function registerName(
  mem: FakeMemory,
  comparisonIndex: number,
  name: string,
  opts: { wide?: boolean; blockBase?: string } = {}
): void {
  const wide = opts.wide ?? false
  const blockBase = opts.blockBase ?? '0x7000'
  const chunkIdx = comparisonIndex >> POOL.blockOffsetBits
  const inChunkOffset = (comparisonIndex & ((1 << POOL.blockOffsetBits) - 1)) * POOL.nameEntryStride
  const blockPtrAddress = addr(POOL.gNamesBase, 0x10 + chunkIdx * 8)
  mem.write(blockPtrAddress, pointerBuf(blockBase))
  const entryAddress = addr(blockBase, inChunkOffset)
  mem.write(entryAddress, nameEntryBuf(name, wide, POOL.lengthShiftCount, POOL.stringOffset))
}

describe('decodeFName', () => {
  it('decodes a plain ASCII name', () => {
    const mem = new FakeMemory()
    registerName(mem, 1, 'None')
    expect(decodeFName(mem.read, POOL, 1)).toBe('None')
  })

  it('returns null when the block pointer is unset', () => {
    const mem = new FakeMemory()
    expect(decodeFName(mem.read, POOL, 999)).toBeNull()
  })
})

describe('walkProperties / resolveFieldOffset', () => {
  it('walks a two-node FField chain and resolves by decoded name', () => {
    const mem = new FakeMemory()
    const classAddress = '0x9000'
    const field1 = '0xa000'
    const field2 = '0xb000'

    mem.write(addr(classAddress, 0x50), pointerBuf(field1))
    mem.write(addr(field1, 0x28), fnameBuf(10))
    mem.write(addr(field1, 0x4c), Buffer.from([0x08, 0x00, 0x00, 0x00]))
    mem.write(addr(field1, 0x20), pointerBuf(field2))
    mem.write(addr(field2, 0x28), fnameBuf(30))
    mem.write(addr(field2, 0x4c), Buffer.from([0x10, 0x00, 0x00, 0x00]))

    registerName(mem, 10, 'Health')
    registerName(mem, 30, 'Ammo')

    expect(walkProperties(mem.read, classAddress)).toHaveLength(2)
    expect(resolveFieldOffset(mem.read, POOL, classAddress, 'Ammo')).toEqual({ offset: 16 })
    expect(resolveFieldOffset(mem.read, POOL, classAddress, 'Nope')).toBeNull()
  })
})

describe('resolveClassAddress', () => {
  it('finds an object whose name matches and whose class decodes to "Class"', () => {
    const mem = new FakeMemory()
    const arrayConfig: UeConfig['gObjectArray'] = {
      chunksArrayBase: '0x3000',
      numElementsPerChunk: 16,
      itemStride: 0x10,
      itemInitialOffset: 0x0
    }

    const block0 = '0x4000'
    mem.write(arrayConfig.chunksArrayBase, pointerBuf(block0))

    const playerClassObj = '0x9000'
    mem.write(addr(block0, 0), pointerBuf(playerClassObj))
    registerName(mem, 10, 'Player')
    mem.write(addr(playerClassObj, 0x18), fnameBuf(10))

    const metaClassObj = '0x9500'
    mem.write(addr(playerClassObj, 0x10), pointerBuf(metaClassObj))
    registerName(mem, 30, 'Class')
    mem.write(addr(metaClassObj, 0x18), fnameBuf(30))

    const found = resolveClassAddress(mem.read, arrayConfig, POOL, 'Player', 16)
    expect(found).toBe(playerClassObj)
  })

  it('returns null when maxObjectsToScan is exhausted without a match', () => {
    const mem = new FakeMemory()
    const arrayConfig: UeConfig['gObjectArray'] = {
      chunksArrayBase: '0x3000',
      numElementsPerChunk: 16,
      itemStride: 0x10,
      itemInitialOffset: 0x0
    }
    expect(resolveClassAddress(mem.read, arrayConfig, POOL, 'Anything', 4)).toBeNull()
  })
})

describe('resolveUeTargetAddress', () => {
  const target: UeTarget = {
    kind: 'ue',
    className: 'Player',
    fieldName: 'Health',
    maxObjectsToScan: 16,
    instanceAnchorPatchId: 'capture-player'
  }

  const config: UeConfig = {
    gNames: POOL,
    gObjectArray: { chunksArrayBase: '0x3000', numElementsPerChunk: 16, itemStride: 0x10, itemInitialOffset: 0x0 }
  }

  it('adds the resolved field offset to the given instance pointer', () => {
    const mem = new FakeMemory()
    const block0 = '0x4000'
    mem.write(config.gObjectArray.chunksArrayBase, pointerBuf(block0))

    const playerClassObj = '0x9000'
    mem.write(addr(block0, 0), pointerBuf(playerClassObj))
    registerName(mem, 10, 'Player')
    mem.write(addr(playerClassObj, 0x18), fnameBuf(10))
    const metaClassObj = '0x9500'
    mem.write(addr(playerClassObj, 0x10), pointerBuf(metaClassObj))
    registerName(mem, 20, 'Class')
    mem.write(addr(metaClassObj, 0x18), fnameBuf(20))

    const field1 = '0xa000'
    mem.write(addr(playerClassObj, 0x50), pointerBuf(field1))
    mem.write(addr(field1, 0x28), fnameBuf(30))
    mem.write(addr(field1, 0x4c), Buffer.from([0x48, 0x00, 0x00, 0x00])) // offset 0x48
    registerName(mem, 30, 'Health')

    const instancePointer = '0x5000'
    const resolved = resolveUeTargetAddress(target, config, instancePointer, mem.read)
    expect(resolved).toBe(addr(instancePointer, 0x48))
  })

  it('returns null when the class does not resolve', () => {
    const mem = new FakeMemory()
    const resolved = resolveUeTargetAddress(target, config, '0x5000', mem.read)
    expect(resolved).toBeNull()
  })
})

describe('field layouts (UE 5.6 compact FField)', () => {
  it('walks a compact-layout chain (Next 0x18, Name 0x20, Offset 0x44) and adds valueOffset', () => {
    const mem = new FakeMemory()
    const classAddress = '0x9000'
    const field1 = '0xa000'
    const field2 = '0xb000'
    mem.write(addr(classAddress, 0x50), pointerBuf(field1))
    mem.write(addr(field1, 0x20), fnameBuf(10))
    mem.write(addr(field1, 0x44), Buffer.from([0x48, 0x00, 0x00, 0x00]))
    mem.write(addr(field1, 0x18), pointerBuf(field2))
    mem.write(addr(field2, 0x20), fnameBuf(30))
    mem.write(addr(field2, 0x44), Buffer.from([0x58, 0x00, 0x00, 0x00]))
    registerName(mem, 10, 'Oxygen')
    registerName(mem, 30, 'MaxOxygen')

    const compact = FIELD_LAYOUTS.compact
    expect(walkProperties(mem.read, classAddress, compact)).toHaveLength(2)
    expect(resolveFieldOffset(mem.read, POOL, classAddress, 'MaxOxygen', compact)).toEqual({ offset: 0x58 })
    expect(fieldLayoutFor({ fieldLayout: 'compact' } as UeConfig)).toBe(compact)
    expect(fieldLayoutFor({} as UeConfig)).toBe(FIELD_LAYOUTS.legacy)
  })

  it('root key separates the same class under different owner classes', () => {
    const base: UeTarget = { kind: 'ue', className: 'A', rootClass: 'A', fieldName: 'F', maxObjectsToScan: 1 }
    expect(ueRootKey(base)).toBe('A')
    expect(ueRootKey({ ...base, rootOuterClass: 'Player' })).toBe('A@Player')
  })
})

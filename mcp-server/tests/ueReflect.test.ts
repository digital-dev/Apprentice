import { describe, it, expect } from 'vitest'
import {
  decodeFName,
  walkProperties,
  resolveField,
  resolveClass,
  type ReadBytes,
  type FNamePoolConfig,
  type UObjectArrayConfig
} from '../src/ueReflect'

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

// Builds one FNameEntry's bytes (header + string payload) per the decode
// formula in ueReflect.ts: header = (len << lengthShiftCount) | (wide ? 1 : 0).
function nameEntryBuf(name: string, wide: boolean, lengthShiftCount: number, stringOffset: number): Buffer {
  const stringBytes = wide ? Buffer.from(name, 'utf16le') : Buffer.from(name, 'utf8')
  const len = wide ? stringBytes.length / 2 : stringBytes.length
  const header = (len << lengthShiftCount) | (wide ? 1 : 0)
  const buf = Buffer.alloc(stringOffset + stringBytes.length)
  buf.writeUInt16LE(header, 0)
  stringBytes.copy(buf, stringOffset)
  return buf
}

const POOL: FNamePoolConfig = {
  gNamesBase: '0x2000',
  blockOffsetBits: 8,
  nameEntryStride: 2,
  stringOffset: 2,
  headerOffset: 0,
  lengthShiftCount: 1
}

// Registers one name at `comparisonIndex` in `mem`, under POOL's config,
// in chunk 0 (block base 0x7000) unless a different chunk is requested.
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

  it('decodes a wide (UTF-16) name', () => {
    const mem = new FakeMemory()
    registerName(mem, 2, 'Hi', { wide: true })
    expect(decodeFName(mem.read, POOL, 2)).toBe('Hi')
  })

  it('returns null when the block pointer is unset', () => {
    const mem = new FakeMemory()
    expect(decodeFName(mem.read, POOL, 999)).toBeNull()
  })

  it('returns null when the decoded length is zero (numbered-name fallback, unhandled)', () => {
    const mem = new FakeMemory()
    const blockPtrAddress = addr(POOL.gNamesBase, 0x10)
    mem.write(blockPtrAddress, pointerBuf('0x7000'))
    mem.write('0x7000', Buffer.from([0x00, 0x00])) // header = 0 -> len 0
    expect(decodeFName(mem.read, POOL, 0)).toBeNull()
  })
})

describe('walkProperties', () => {
  it('walks a two-node FField chain and stops at null Next', () => {
    const mem = new FakeMemory()
    const classAddress = '0x9000'
    const field1 = '0xa000'
    const field2 = '0xb000'

    mem.write(addr(classAddress, 0x50), pointerBuf(field1))
    mem.write(addr(field1, 0x28), fnameBuf(10))
    mem.write(addr(field1, 0x4c), Buffer.from([0x08, 0x00, 0x00, 0x00])) // offset 8
    mem.write(addr(field1, 0x20), pointerBuf(field2))

    mem.write(addr(field2, 0x28), fnameBuf(20))
    mem.write(addr(field2, 0x4c), Buffer.from([0x10, 0x00, 0x00, 0x00])) // offset 16
    // field2's Next (+0x20) is left unwritten -> reads null -> chain stops

    const entries = walkProperties(mem.read, classAddress)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ fieldAddress: field1, name: { comparisonIndex: 10, number: 0 }, offsetInternal: 8 })
    expect(entries[1]).toEqual({ fieldAddress: field2, name: { comparisonIndex: 20, number: 0 }, offsetInternal: 16 })
  })

  it('returns an empty array when ChildProperties is unset', () => {
    const mem = new FakeMemory()
    expect(walkProperties(mem.read, '0x9000')).toEqual([])
  })
})

describe('resolveField', () => {
  it('finds a field by its decoded name', () => {
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

    // Indices spaced well apart (each entry is only ~8-10 bytes) so their
    // byte ranges in the shared fake block don't overlap each other.
    registerName(mem, 10, 'Health')
    registerName(mem, 30, 'Ammo')

    expect(resolveField(mem.read, POOL, classAddress, 'Ammo')).toEqual({ offset: 16 })
    expect(resolveField(mem.read, POOL, classAddress, 'Nope')).toBeNull()
  })
})

describe('resolveClass', () => {
  it('finds an object whose name matches and whose class decodes to "Class"', () => {
    const mem = new FakeMemory()
    const arrayConfig: UObjectArrayConfig = {
      chunksArrayBase: '0x3000',
      numElementsPerChunk: 16,
      itemStride: 0x10,
      itemInitialOffset: 0x0
    }

    const block0 = '0x4000'
    mem.write(arrayConfig.chunksArrayBase, pointerBuf(block0))

    // Object at index 0: the Player class object itself.
    // Indices spaced well apart (each entry is only ~8-10 bytes) so their
    // byte ranges in the shared fake block don't overlap each other.
    const playerClassObj = '0x9000'
    mem.write(addr(block0, 0 * arrayConfig.itemStride), pointerBuf(playerClassObj))
    registerName(mem, 10, 'Player')
    mem.write(addr(playerClassObj, 0x18), fnameBuf(10)) // NamePrivate -> "Player"

    // Its own class (the metaclass) decodes to "Class".
    const metaClassObj = '0x9500'
    mem.write(addr(playerClassObj, 0x10), pointerBuf(metaClassObj)) // ClassPrivate
    registerName(mem, 30, 'Class')
    mem.write(addr(metaClassObj, 0x18), fnameBuf(30))

    // Object at index 1: an unrelated instance also named "Player" (an
    // actor instance, say) whose class is NOT "Class" -- must be skipped.
    const playerInstance = '0xa000'
    mem.write(addr(block0, 1 * arrayConfig.itemStride), pointerBuf(playerInstance))
    mem.write(addr(playerInstance, 0x18), fnameBuf(10)) // same name "Player"
    const instanceClassObj = '0xa500'
    mem.write(addr(playerInstance, 0x10), pointerBuf(instanceClassObj))
    registerName(mem, 50, 'PlayerClass')
    mem.write(addr(instanceClassObj, 0x18), fnameBuf(50))

    const found = resolveClass(mem.read, arrayConfig, POOL, 'Player', 16)
    expect(found).toBe(playerClassObj)
  })

  it('returns null when maxObjectsToScan is exhausted without a match', () => {
    const mem = new FakeMemory()
    const arrayConfig: UObjectArrayConfig = {
      chunksArrayBase: '0x3000',
      numElementsPerChunk: 16,
      itemStride: 0x10,
      itemInitialOffset: 0x0
    }
    expect(resolveClass(mem.read, arrayConfig, POOL, 'Anything', 4)).toBeNull()
  })
})

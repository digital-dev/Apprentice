import { describe, it, expect } from 'vitest'
import { chunkedRead, MAX_READ_BYTES } from '../src/factory/chunkedRead'

// A reader with the real addon's constraint: it refuses anything over 4096.
function cappedReader(memory: Buffer, base = 0x1000) {
  const calls: [string, number][] = []
  const read = (address: string, length: number): string | null => {
    calls.push([address, length])
    if (length > MAX_READ_BYTES) return null
    const start = Number(BigInt(address)) - base
    if (start < 0 || start + length > memory.length) return null
    return memory.subarray(start, start + length).toString('hex')
  }
  return { read, calls }
}

describe('chunkedRead', () => {
  it('passes small reads straight through', () => {
    const mem = Buffer.from('0102030405060708', 'hex')
    const { read, calls } = cappedReader(mem)
    expect(chunkedRead(read, '0x1000', 4)).toBe('01020304')
    expect(calls).toHaveLength(1)
  })

  it('splits reads over the cap and reassembles them in order', () => {
    const mem = Buffer.alloc(10000)
    for (let i = 0; i < mem.length; i++) mem[i] = i % 251
    const { read, calls } = cappedReader(mem)
    expect(chunkedRead(read, '0x1000', 10000)).toBe(mem.toString('hex'))
    expect(calls.map((c) => c[1])).toEqual([4096, 4096, 1808])
    expect(calls[1][0]).toBe('0x2000')
  })

  it('returns null when any chunk is unreadable', () => {
    const mem = Buffer.alloc(5000) // second chunk would run past the end
    const { read } = cappedReader(mem)
    expect(chunkedRead(read, '0x1000', 6000)).toBeNull()
  })

  it('returns an empty string for a zero-length read', () => {
    expect(chunkedRead(() => null, '0x1000', 0)).toBe('')
  })
})

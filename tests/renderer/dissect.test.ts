import { describe, it, expect } from 'vitest'
import { decodeAt } from '../../src/renderer/src/dissect'

// Byte layout, little-endian throughout:
// offset 0: int8 200 (0xC8)
// offset 1: int16 -1000 (0xFC18)
// offset 4: int32 -70000 (0xFFFEEE90)
// offset 8: int64 -1n (0xFFFFFFFFFFFFFFFF)
// offset 16: float 1.5 (0x3FC00000)
// offset 20: double 2.5 (0x4004000000000000)
function testBlock(): ArrayBuffer {
  const buf = new ArrayBuffer(28)
  const view = new DataView(buf)
  view.setUint8(0, 200)
  view.setInt16(1, -1000, true)
  view.setInt32(4, -70000, true)
  view.setBigInt64(8, -1n, true)
  view.setFloat32(16, 1.5, true)
  view.setFloat64(20, 2.5, true)
  return buf
}

describe('decodeAt', () => {
  it('decodes int8 as unsigned, matching value_type.h\'s UInt8 convention', () => {
    expect(decodeAt(testBlock(), 0, 'int8')).toBe(200)
  })

  it('decodes int16 as signed', () => {
    expect(decodeAt(testBlock(), 1, 'int16')).toBe(-1000)
  })

  it('decodes int32 as signed', () => {
    expect(decodeAt(testBlock(), 4, 'int32')).toBe(-70000)
  })

  it('decodes int64 as a BigInt, not a lossily-widened number', () => {
    expect(decodeAt(testBlock(), 8, 'int64')).toBe(-1n)
  })

  it('decodes float little-endian', () => {
    expect(decodeAt(testBlock(), 16, 'float')).toBeCloseTo(1.5)
  })

  it('decodes double little-endian', () => {
    expect(decodeAt(testBlock(), 20, 'double')).toBeCloseTo(2.5)
  })

  it('returns null when the type would read past the end of the block', () => {
    expect(decodeAt(testBlock(), 26, 'double')).toBeNull()
  })

  it('returns null for a negative offset', () => {
    expect(decodeAt(testBlock(), -1, 'int8')).toBeNull()
  })
})

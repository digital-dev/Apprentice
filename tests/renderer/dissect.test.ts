import { describe, it, expect } from 'vitest'
import { decodeAt, toArrayBuffer } from '../../src/renderer/src/dissect'

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

describe('toArrayBuffer', () => {
  // Mimics exactly what structured-clone actually delivers over Electron
  // IPC for memory:readBlock's Node Buffer: a Uint8Array view whose
  // byteOffset is nonzero and whose backing ArrayBuffer is larger than the
  // view itself (see tamper.d.ts's readMemoryBlock comment). Handing
  // `.buffer` straight to `new DataView` — what decodeAt used to be fed
  // before this normalization existed — would read from the wrong bytes
  // here, since the underlying buffer's byte 0 is not the view's byte 0.
  it('normalizes a Uint8Array at a nonzero byteOffset into an independent, correctly-aligned ArrayBuffer', () => {
    const padding = 10
    const big = new ArrayBuffer(padding + 28)
    const bigView = new DataView(big)
    // Junk in the padding region, to prove decodeAt below reads relative
    // to the VIEW's start, not the underlying buffer's.
    for (let i = 0; i < padding; i++) bigView.setUint8(i, 0xee)

    // Same layout as testBlock() above, written starting at `padding`.
    bigView.setUint8(padding + 0, 200)
    bigView.setInt16(padding + 1, -1000, true)
    bigView.setInt32(padding + 4, -70000, true)
    bigView.setBigInt64(padding + 8, -1n, true)
    bigView.setFloat32(padding + 16, 1.5, true)
    bigView.setFloat64(padding + 20, 2.5, true)

    const view = new Uint8Array(big, padding, 28)
    const normalized = toArrayBuffer(view)

    expect(normalized).not.toBe(big) // independent buffer, not an alias
    expect(normalized.byteLength).toBe(28)
    expect(decodeAt(normalized, 0, 'int8')).toBe(200)
    expect(decodeAt(normalized, 1, 'int16')).toBe(-1000)
    expect(decodeAt(normalized, 4, 'int32')).toBe(-70000)
    expect(decodeAt(normalized, 8, 'int64')).toBe(-1n)
    expect(decodeAt(normalized, 16, 'float')).toBeCloseTo(1.5)
    expect(decodeAt(normalized, 20, 'double')).toBeCloseTo(2.5)
  })
})

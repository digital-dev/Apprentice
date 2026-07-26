import { describe, it, expect } from 'vitest'
import { littleEndianToBigInt } from '../../src/main/ipc'

// The captured pointer slot holds a raw little-endian 8-byte blob. This is
// the one place a silent, plausible-looking error can hide: parsing the hex
// string directly (big-endian) yields a different, still-valid-looking
// address instead of a visible failure, so the byte-reversal is worth
// pinning down with a worked example independent of any live process.
describe('littleEndianToBigInt', () => {
  it('reverses byte pairs before parsing, not the raw string', () => {
    // Bytes on the wire: 08 07 06 05 04 03 02 01 (little-endian) represent
    // the address 0x0102030405060708.
    expect(littleEndianToBigInt('0807060504030201')).toBe(0x0102030405060708n)
  })

  it('treats an all-zero slot as the numeric value zero', () => {
    expect(littleEndianToBigInt('0000000000000000')).toBe(0n)
  })

  it('round-trips a single non-zero low byte', () => {
    // Little-endian bytes 01 00 00 00 00 00 00 00 -> value 0x01.
    expect(littleEndianToBigInt('0100000000000000')).toBe(0x01n)
  })
})

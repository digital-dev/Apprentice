import { describe, it, expect } from 'vitest'
import { resolveAnchorAddress } from '../../src/main/anchorResolve'

// A tiny fake of process memory: address (hex string) -> 8-byte little-endian pointer.
function memory(pointers: Record<string, bigint>): (address: string, length: number) => string | null {
  return (address) => {
    const value = pointers[BigInt(address).toString(16)]
    if (value === undefined) return null
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(value)
    return buf.toString('hex')
  }
}

const SLOT = '0x1000'

describe('resolveAnchorAddress', () => {
  it('adds the offset to the captured pointer', () => {
    const read = memory({ '1000': 0x5000n })
    expect(resolveAnchorAddress({ offset: '0x30' }, SLOT, read)).toEqual({ ok: true, address: '0x5030' })
  })

  it('reports no slot when the capture patch is not installed', () => {
    expect(resolveAnchorAddress({ offset: '0x30' }, null, memory({}))).toEqual({ ok: false, reason: 'no-slot' })
  })

  it('reports an unreadable slot distinctly from an empty one', () => {
    expect(resolveAnchorAddress({ offset: '0x30' }, SLOT, memory({}))).toEqual({ ok: false, reason: 'slot-unreadable' })
  })

  it('reports not-captured while the game has not run the hook yet (slot still zero)', () => {
    expect(resolveAnchorAddress({ offset: '0x30' }, SLOT, memory({ '1000': 0n }))).toEqual({
      ok: false,
      reason: 'not-captured'
    })
  })

  describe('derefOffset (follow a pointer field of the captured object first)', () => {
    it('reads the pointer stored at captured+derefOffset and adds offset to THAT', () => {
      // captured object at 0x5000; its field at +0x48 holds a pointer to the real object at 0x9000.
      const read = memory({ '1000': 0x5000n, '5048': 0x9000n })
      expect(resolveAnchorAddress({ offset: '0x30', derefOffset: '0x48' }, SLOT, read)).toEqual({
        ok: true,
        address: '0x9030'
      })
    })

    it('reports a null reference (e.g. no wallet yet) rather than writing near address zero', () => {
      const read = memory({ '1000': 0x5000n, '5048': 0n })
      expect(resolveAnchorAddress({ offset: '0x30', derefOffset: '0x48' }, SLOT, read)).toEqual({
        ok: false,
        reason: 'deref-null'
      })
    })

    it('reports an unreadable reference field', () => {
      const read = memory({ '1000': 0x5000n })
      expect(resolveAnchorAddress({ offset: '0x30', derefOffset: '0x48' }, SLOT, read)).toEqual({
        ok: false,
        reason: 'deref-unreadable'
      })
    })

    it('behaves exactly as before when derefOffset is absent', () => {
      const read = memory({ '1000': 0x5000n, '5048': 0x9000n })
      expect(resolveAnchorAddress({ offset: '0x48' }, SLOT, read)).toEqual({ ok: true, address: '0x5048' })
    })
  })
})

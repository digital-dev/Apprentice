// Resolving an anchored target's address, kept free of Electron and the native
// addon so it can be unit-tested. An anchor is reached in two reads: the
// pointer a capture patch stored in its slot, then (optionally) a pointer
// FIELD of that captured object, then the target field's offset.

export interface AnchorShape {
  offset: string
  // When set, the captured object is only a HOLDER: read the 8-byte pointer
  // stored at (captured + derefOffset) and use THAT object as the base for
  // `offset`. Lets a capture on a method that runs every frame (e.g. an
  // inventory's Update) reach a value on a different object it references
  // (the wallet), instead of needing a hook on that object's own rare methods.
  derefOffset?: string
}

export type AnchorResolution =
  | { ok: true; address: string }
  | { ok: false; reason: 'no-slot' | 'slot-unreadable' | 'not-captured' | 'deref-unreadable' | 'deref-null' }

export type ReadFn = (address: string, length: number) => string | null

function littleEndianPointer(hex: string): bigint {
  return Buffer.from(hex, 'hex').readBigUInt64LE(0)
}

export function resolveAnchorAddress(target: AnchorShape, slot: string | null, read: ReadFn): AnchorResolution {
  // No breadcrumb for this one: it is the routine state of any anchor whose
  // capture patch is not currently installed.
  if (slot === null) return { ok: false, reason: 'no-slot' }

  const slotHex = read(slot, 8)
  if (slotHex === null) return { ok: false, reason: 'slot-unreadable' }

  let base = littleEndianPointer(slotHex)
  // Zero means the game has not run the hooked instruction yet this session.
  if (base === 0n) return { ok: false, reason: 'not-captured' }

  if (target.derefOffset !== undefined) {
    const fieldHex = read('0x' + (base + BigInt(target.derefOffset)).toString(16), 8)
    if (fieldHex === null) return { ok: false, reason: 'deref-unreadable' }
    base = littleEndianPointer(fieldHex)
    // A null reference (the holder exists but not what it points at yet) must
    // not turn into a write near address zero.
    if (base === 0n) return { ok: false, reason: 'deref-null' }
  }

  return { ok: true, address: '0x' + (base + BigInt(target.offset)).toString(16) }
}

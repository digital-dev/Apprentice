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
  // The general form of derefOffset, for a value reached through more than
  // one intermediate reference — e.g. Phasmophobia's ghost's favorite room
  // name: the captured GhostAI only holds a GhostInfo pointer (+0x38), whose
  // OWN +0x70 holds the LevelRoom pointer `offset` actually targets. Each
  // entry is read the same way derefOffset's single hop is: pointer at
  // (current base + entry), used as the next base. Takes priority over
  // derefOffset when both are present (there is no reason to set both);
  // absent or empty means "no extra hops", exactly as before this field
  // existed.
  derefOffsets?: string[]
  // The captured object is a UnityEngine.Object (MonoBehaviour etc.): its
  // native backing pointer at +0x10 reads zero once the engine has destroyed
  // it. A capture pins the first object seen for the session, so after a
  // save reload or scene change the slot can point at freed memory the game
  // has since reused. When set, resolution refuses a destroyed object so the
  // freeze loop never writes through a dangling pointer. Only valid for
  // classes that derive from UnityEngine.Object -- on a plain C# class +0x10
  // is an ordinary field and may legitimately read zero.
  requireLiveUnityObject?: boolean
}

export type AnchorResolution =
  | { ok: true; address: string }
  | { ok: false; reason: 'no-slot' | 'slot-unreadable' | 'not-captured' | 'deref-unreadable' | 'deref-null' | 'object-destroyed' }

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

  if (target.requireLiveUnityObject) {
    const nativeHex = read('0x' + (base + 0x10n).toString(16), 8)
    // Unreadable means the managed object's page is gone entirely; zero means
    // the engine destroyed it. Either way the pointer is dangling.
    if (nativeHex === null || littleEndianPointer(nativeHex) === 0n) return { ok: false, reason: 'object-destroyed' }
  }

  const hops = target.derefOffsets !== undefined && target.derefOffsets.length > 0
    ? target.derefOffsets
    : target.derefOffset !== undefined
      ? [target.derefOffset]
      : []
  for (const hop of hops) {
    const fieldHex = read('0x' + (base + BigInt(hop)).toString(16), 8)
    if (fieldHex === null) return { ok: false, reason: 'deref-unreadable' }
    base = littleEndianPointer(fieldHex)
    // A null reference (the holder exists but not what it points at yet) must
    // not turn into a write near address zero.
    if (base === 0n) return { ok: false, reason: 'deref-null' }
  }

  return { ok: true, address: '0x' + (base + BigInt(target.offset)).toString(16) }
}

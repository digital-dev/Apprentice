import { describe, it, expect } from 'vitest'
import { resolveMonoTargetAddress, resolveMonoPointerChain, resolveMonoLiveValue, MonoResolverOps } from '../../src/main/monoTargetResolve'
import type { MonoTarget } from '../../src/main/store'

class FakeResolver implements MonoResolverOps {
  classes = new Map<string, string>() // className -> handle
  staticAddresses = new Map<string, string>() // `${classHandle}.${fieldName}` -> address
  memory = new Map<string, string>() // address -> hex value (for the dereference hop)

  async resolveClass(_handle: number, _base: string, _ns: string, className: string) {
    return this.classes.get(className) ?? null
  }
  async staticFieldAddress(_handle: number, _base: string, classHandle: string, fieldName: string) {
    return this.staticAddresses.get(`${classHandle}.${fieldName}`) ?? null
  }
  async resolveField(_handle: number, _base: string, classHandle: string, fieldName: string) {
    const key = `${classHandle}.${fieldName}`
    return this.staticAddresses.has(key) ? { offset: Number(this.staticAddresses.get(key)) } : null
  }
  readBytes(address: string, _length: number) {
    return this.memory.get(address) ?? null
  }
}

const godModeTarget: MonoTarget = {
  kind: 'mono',
  className: 'Player',
  staticFieldName: 'm_localPlayer',
  instanceFieldName: 'm_godMode'
}

const staticOnlyTarget: MonoTarget = {
  kind: 'mono',
  className: 'GameSettings',
  staticFieldName: 'm_difficulty'
}

describe('resolveMonoTargetAddress', () => {
  it('resolves a static-only field to its own storage address', async () => {
    const ops = new FakeResolver()
    ops.classes.set('GameSettings', '0xc1')
    ops.staticAddresses.set('0xc1.m_difficulty', '0x9000')

    const addr = await resolveMonoTargetAddress(staticOnlyTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x9000')
  })

  it('dereferences a static field to an object, then adds the instance offset', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_godMode', '1681') // offset, per store.ts's field-offset shape
    ops.memory.set('0x9100', '5030000000000000') // little-endian pointer 0x3050

    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x' + (0x3050 + 1681).toString(16))
  })

  it('returns null when the class does not resolve', async () => {
    const ops = new FakeResolver()
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('returns null when the static field is not found', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('returns null when the object pointer reads as zero (not yet touched by the game)', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0000000000000000')
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })
})

// m_runSpeed lives on Character, not Player — Player.m_localPlayer's
// declared type is Player, but the live object is a Player instance, which
// inherits Character's fields at fixed offsets without redeclaring them.
// The native field lookup doesn't walk the inheritance chain (confirmed
// live against Valheim: resolving "m_runSpeed" against Player's own class
// handle returns null; against Character's, it resolves) — instanceClassName
// exists so a target can name the field's actual declaring class separately
// from the class the static field itself lives on.
const runSpeedTarget: MonoTarget = {
  kind: 'mono',
  className: 'Player',
  staticFieldName: 'm_localPlayer',
  instanceFieldName: 'm_runSpeed',
  instanceClassName: 'Character'
}

describe('resolveMonoTargetAddress — instanceClassName (inherited field)', () => {
  it('resolves the instance field against instanceClassName, not className', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.classes.set('Character', '0xc3')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc3.m_runSpeed', '496') // declared on Character's own class handle
    ops.memory.set('0x9100', '0030000000000000') // little-endian pointer 0x3000

    const addr = await resolveMonoTargetAddress(runSpeedTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x' + (0x3000 + 496).toString(16))
  })

  it('returns null when instanceClassName itself does not resolve', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    // 'Character' deliberately never added to ops.classes.
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0030000000000000')

    const addr = await resolveMonoTargetAddress(runSpeedTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('returns null when the field is not found on instanceClassName either', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.classes.set('Character', '0xc3')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    // 'm_runSpeed' deliberately never registered under '0xc3.*'.
    ops.memory.set('0x9100', '0030000000000000')

    const addr = await resolveMonoTargetAddress(runSpeedTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('leaves targets with no instanceClassName resolving against className, exactly as before', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_godMode', '1681')
    ops.memory.set('0x9100', '5030000000000000')

    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x' + (0x3050 + 1681).toString(16))
  })
})

// The InventoryGui.m_instance -> .m_dragItem -> ItemData.m_stack shape:
// pointerFieldOffset dereferences ONE MORE TIME past the normal single-hop
// address (which, for a two-hop target, is the address of a pointer FIELD,
// not a final scalar) and adds a raw offset with no class name involved.
const dragItemStackTarget: MonoTarget = {
  kind: 'mono',
  className: 'InventoryGui',
  staticFieldName: 'm_instance',
  instanceFieldName: 'm_dragItem',
  pointerFieldOffset: '0x38'
}

describe('resolveMonoTargetAddress — two-hop (pointerFieldOffset)', () => {
  it('dereferences past the first-hop field address and adds the raw offset', async () => {
    const ops = new FakeResolver()
    ops.classes.set('InventoryGui', '0xc9')
    ops.staticAddresses.set('0xc9.m_instance', '0x9200') // InventoryGui singleton's own storage
    ops.staticAddresses.set('0xc9.m_dragItem', '48') // offset of the drag-item pointer FIELD
    ops.memory.set('0x9200', '0060000000000000') // InventoryGui instance pointer 0x6000
    // first hop address = 0x6000 + 48 = 0x6030 — holds the ItemData pointer
    ops.memory.set('0x6030', '0070000000000000') // ItemData instance pointer 0x7000
    const addr = await resolveMonoTargetAddress(dragItemStackTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x' + (0x7000 + 0x38).toString(16))
  })

  it('returns null when nothing is currently being dragged (second pointer reads zero)', async () => {
    const ops = new FakeResolver()
    ops.classes.set('InventoryGui', '0xc9')
    ops.staticAddresses.set('0xc9.m_instance', '0x9200')
    ops.staticAddresses.set('0xc9.m_dragItem', '48')
    ops.memory.set('0x9200', '0060000000000000')
    ops.memory.set('0x6030', '0000000000000000')
    const addr = await resolveMonoTargetAddress(dragItemStackTarget, 1, '0x400000', ops)
    expect(addr).toBeNull()
  })

  it('leaves single-hop targets (no pointerFieldOffset) resolving exactly as before', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_godMode', '1681')
    ops.memory.set('0x9100', '5030000000000000')
    const addr = await resolveMonoTargetAddress(godModeTarget, 1, '0x400000', ops)
    expect(addr).toBe('0x' + (0x3050 + 1681).toString(16))
  })
})

describe('resolveMonoPointerChain', () => {
  it('resolves a plain static pointer with no instance hop', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0030000000000000') // little-endian pointer 0x3000

    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops)
    expect(pointer).toBe('0x3000')
  })

  it('follows one more instance field to a second object (the Skills:OnDeath shape)', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_skills', '2000') // field OFFSET, per store.ts's field-offset shape
    ops.memory.set('0x9100', '0030000000000000') // Player instance pointer 0x3000
    ops.memory.set('0x' + (0x3000 + 2000).toString(16), '0040000000000000') // Skills instance pointer 0x4000

    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBe('0x4000')
  })

  it('returns null when the class does not resolve', async () => {
    const ops = new FakeResolver()
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })

  it('returns null when the first hop pointer reads as zero', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0000000000000000')
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })

  it('returns null when the second hop field is not found', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.memory.set('0x9100', '0030000000000000')
    // no ops.staticAddresses entry for 0xc2.m_skills -> resolveField returns null
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })

  it('returns null when the second hop pointer reads as zero', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_skills', '2000')
    ops.memory.set('0x9100', '0030000000000000')
    ops.memory.set('0x' + (0x3000 + 2000).toString(16), '0000000000000000')
    const pointer = await resolveMonoPointerChain(1, '0x400000', 'Player', 'm_localPlayer', ops, 'm_skills')
    expect(pointer).toBeNull()
  })
})

describe('resolveMonoLiveValue', () => {
  it('reads and decodes the 4 bytes at a static field as both int32 and float', async () => {
    const ops = new FakeResolver()
    ops.classes.set('GameSettings', '0xc1')
    ops.staticAddresses.set('0xc1.m_difficulty', '0x9000')
    ops.memory.set('0x9000', '05000000') // int32 5, little-endian

    const value = await resolveMonoLiveValue(staticOnlyTarget, 1, '0x400000', ops)
    expect(value?.raw).toBe('05000000')
    expect(value?.int32).toBe(5)
  })

  it('reads through an instance field the same way resolveMonoTargetAddress does', async () => {
    const ops = new FakeResolver()
    ops.classes.set('Player', '0xc2')
    ops.staticAddresses.set('0xc2.m_localPlayer', '0x9100')
    ops.staticAddresses.set('0xc2.m_godMode', '1681')
    ops.memory.set('0x9100', '5030000000000000')
    ops.memory.set('0x' + (0x3050 + 1681).toString(16), '01000000')

    const value = await resolveMonoLiveValue(godModeTarget, 1, '0x400000', ops)
    expect(value?.int32).toBe(1)
  })

  it('returns null when the address does not resolve', async () => {
    const ops = new FakeResolver()
    const value = await resolveMonoLiveValue(staticOnlyTarget, 1, '0x400000', ops)
    expect(value).toBeNull()
  })

  it('returns null instead of throwing when fewer than 4 bytes are read', async () => {
    const ops = new FakeResolver()
    ops.classes.set('GameSettings', '0xc1')
    ops.staticAddresses.set('0xc1.m_difficulty', '0x9000')
    ops.memory.set('0x9000', '0500') // only 2 bytes

    const value = await resolveMonoLiveValue(staticOnlyTarget, 1, '0x400000', ops)
    expect(value).toBeNull()
  })
})

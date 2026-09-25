import { describe, it, expect } from 'vitest'
import { chasePointerFields } from '../src/factory/pointerChase'
import { FakeMemory, classHex } from './helpers/fakeIl2cpp'

const OBJ = 0x10000n
const PTR_FIELD_OFFSET = '0x38'
const TARGET = 0x20000n
const TARGET_CLASS = 0x21000n
const TARGET_NAME = 0x22000n
const TARGET_NS = 0x23000n
const NULL_FIELD_OFFSET = '0x40'
const UNREADABLE_FIELD_OFFSET = '0x48'

function buildMemory(): FakeMemory {
  const mem = new FakeMemory()
  // OBJ+0x38 holds a pointer to TARGET; OBJ+0x40 holds a null (0) pointer;
  // OBJ+0x48 is left entirely unmapped (simulates an unreadable field).
  mem.qword(OBJ + 0x38n, TARGET)
  mem.qword(OBJ + 0x40n, 0)

  mem.cstr(TARGET_NAME, 'Widget')
  mem.cstr(TARGET_NS, 'MyGame')
  mem.set(TARGET_CLASS, classHex({ name: TARGET_NAME, namespace: TARGET_NS, methodCount: 0, fieldCount: 0 }))
  mem.qword(TARGET, TARGET_CLASS) // object header: klass ptr at +0x0
  // A couple of small-int-looking values inside TARGET's own body, plus one
  // clearly out of the requested [0,29] range that must NOT show up.
  mem.set(TARGET + 0x10n, Buffer.from([21, 0, 0, 0]).toString('hex'))
  mem.set(TARGET + 0x14n, Buffer.from([200, 0, 0, 0]).toString('hex'))
  mem.set(TARGET + 0x18n, Buffer.from([3, 0, 0, 0]).toString('hex'))

  return mem
}

describe('chasePointerFields', () => {
  it('resolves a real pointer field to its target class name and in-range small ints', () => {
    // Every unwritten 4-byte slot in the scanned region reads as 0, which is
    // itself a legitimate value in the default [0,29] range (0 is a real
    // enum/flag value, not noise to hide) — so plenty of zero entries are
    // expected here too; only the specific non-zero values are asserted.
    const mem = buildMemory()
    const result = chasePointerFields(mem, '0x' + OBJ.toString(16), [PTR_FIELD_OFFSET])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      offset: PTR_FIELD_OFFSET,
      targetAddress: '0x' + TARGET.toString(16),
      namespaceName: 'MyGame',
      className: 'Widget'
    })
    expect(result[0].smallInts).toContainEqual({ offset: '0x10', value: 21 })
    expect(result[0].smallInts).toContainEqual({ offset: '0x18', value: 3 })
    expect(result[0].smallInts).not.toContainEqual({ offset: '0x14', value: 200 })
  })

  it('reports a null pointer field distinctly from an unreadable one, without throwing', () => {
    const mem = buildMemory()
    const result = chasePointerFields(mem, '0x' + OBJ.toString(16), [NULL_FIELD_OFFSET, UNREADABLE_FIELD_OFFSET])
    expect(result).toEqual([
      { offset: NULL_FIELD_OFFSET, targetAddress: null, namespaceName: null, className: null, smallInts: [] },
      { offset: UNREADABLE_FIELD_OFFSET, targetAddress: null, namespaceName: null, className: null, smallInts: [] }
    ])
  })

  it('honors a custom intMin/intMax range', () => {
    const mem = buildMemory()
    const result = chasePointerFields(mem, '0x' + OBJ.toString(16), [PTR_FIELD_OFFSET], { intMin: 100, intMax: 255 })
    expect(result[0].smallInts).toEqual([{ offset: '0x14', value: 200 }])
  })

  it('accepts an offset with or without a 0x prefix identically', () => {
    const mem = buildMemory()
    const withPrefix = chasePointerFields(mem, '0x' + OBJ.toString(16), ['0x38'])
    const withoutPrefix = chasePointerFields(mem, '0x' + OBJ.toString(16), ['38'])
    expect(withoutPrefix[0].targetAddress).toEqual(withPrefix[0].targetAddress)
  })
})

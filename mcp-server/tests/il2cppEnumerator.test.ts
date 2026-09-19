import { describe, it, expect } from 'vitest'
import { enumerateIl2cpp } from '../src/factory/il2cppEnumerator'
import {
  FakeMemory,
  classHex,
  fieldHex,
  typeHex,
  methodHex,
  T_FLOAT,
  T_INT32,
  T_CLASS,
  ATTR_PUBLIC,
  ATTR_STATIC
} from './helpers/fakeIl2cpp'

const A = 0x1000n // MoneyManager (hinted, healthy)
const B = 0x1400n // Boring (not hinted)
const C = 0x1800n // PlayerStuff (hinted, corrupt field parent)

// Builds a three-class world. `nullRoot` leaves the singleton static null.
function world(opts: { nullRoot?: boolean } = {}): FakeMemory {
  const m = new FakeMemory()
  // Strings
  m.cstr(0x8000, 'MoneyManager')
  m.cstr(0x8020, 'Boring')
  m.cstr(0x8040, 'PlayerStuff')
  m.cstr(0x8060, '')
  m.cstr(0x8100, 'onlineBalance')
  m.cstr(0x8120, '<Instance>k__BackingField')
  m.cstr(0x8160, 'count')
  m.cstr(0x8180, 'Update')
  m.cstr(0x81a0, 'health')
  // Types
  m.set(0x7000, typeHex(ATTR_PUBLIC, T_FLOAT))
  m.set(0x7010, typeHex(ATTR_STATIC, T_CLASS))
  m.set(0x7020, typeHex(ATTR_PUBLIC, T_INT32))

  // Class A: 3 fields, 1 method, statics block at 0x5000
  m.set(A, classHex({ name: 0x8000, namespace: 0x8060, fields: 0x2000, methods: 0x3000, statics: 0x5000, fieldCount: 3, methodCount: 1 }))
  m.set(0x2000, fieldHex(0x8100, 0x7000, A, 0x128) + fieldHex(0x8120, 0x7010, A, 0) + fieldHex(0x8160, 0x7020, A, 0x130))
  m.qword(0x3000, 0x4000) // MethodInfo* array
  m.set(0x4000, methodHex(0x7ff600001000n, 0x8180, A, 0x06, 0))
  m.qword(0x5000, opts.nullRoot ? 0 : 0x6000) // static Instance -> instance
  m.qword(0x6000, A) // instance's Il2CppObject.klass

  // Class B: only the header + name are needed
  m.set(B, classHex({ name: 0x8020 }))

  // Class C: field whose parent points elsewhere (layout cross-check fails)
  m.set(C, classHex({ name: 0x8040, fields: 0x2800, fieldCount: 1 }))
  m.set(0x2800, fieldHex(0x81a0, 0x7000, 0xdead, 0x10))
  return m
}

const hints = [/money/i, /player/i]
const ptrs = ['0x1000', '0x1400', '0x1800']

describe('enumerateIl2cpp', () => {
  it('scans only hinted classes and reports totals', () => {
    const r = enumerateIl2cpp({ readBytes: world().readBytes }, ptrs, hints)
    expect(r.classesTotal).toBe(3)
    expect(r.classesScanned).toBe(2)
    expect(r.classes.map((c) => c.className)).toEqual(['MoneyManager', 'PlayerStuff'])
  })

  it('decodes fields with data type and static flag', () => {
    const r = enumerateIl2cpp({ readBytes: world().readBytes }, ptrs, hints)
    const money = r.classes[0]
    expect(money.fields.map((f) => [f.fieldName, f.offset, f.dataType, f.isStatic])).toEqual([
      ['onlineBalance', 0x128, 'float', false],
      ['<Instance>k__BackingField', 0, null, true],
      ['count', 0x130, 'int32', false]
    ])
  })

  it('decodes methods', () => {
    const r = enumerateIl2cpp({ readBytes: world().readBytes }, ptrs, hints)
    expect(r.classes[0].methods).toEqual([
      { className: 'MoneyManager', name: 'Update', pointer: '0x7ff600001000', isStatic: false, paramCount: 0, classPtr: '0x1000' }
    ])
  })

  it('finds a live singleton root and the instance class from its header', () => {
    const r = enumerateIl2cpp({ readBytes: world().readBytes }, ptrs, hints)
    expect(r.roots).toEqual([
      { className: 'MoneyManager', fieldName: '<Instance>k__BackingField', instancePtr: '0x6000', instanceClassPtr: '0x1000' }
    ])
  })

  it('ignores a null singleton', () => {
    const r = enumerateIl2cpp({ readBytes: world({ nullRoot: true }).readBytes }, ptrs, hints)
    expect(r.roots).toEqual([])
  })

  it('drops a class whose field parent cross-check fails and reports it', () => {
    const r = enumerateIl2cpp({ readBytes: world().readBytes }, ptrs, hints)
    const bad = r.classes.find((c) => c.className === 'PlayerStuff')!
    expect(bad.fields).toEqual([])
    expect(r.skipped).toEqual([expect.stringContaining('PlayerStuff')])
  })
})

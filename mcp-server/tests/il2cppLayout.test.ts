import { describe, it, expect } from 'vitest'
import {
  leU64,
  toHex,
  cString,
  decodeClass,
  decodeField,
  decodeType,
  decodeMethod,
  typeEnumToDataType,
  FIELD_STRIDE,
  METHOD_STRIDE
} from '../src/factory/il2cppLayout'
import {
  MONEY_CLASS_HEX,
  MONEY_CLASS_PTR,
  MONEY_FIELDS_HEX,
  FLOAT_TYPE_HEX,
  MONEY_METHODS_HEX
} from './fixtures/il2cppProbe'

describe('leU64 / toHex', () => {
  it('reads a little-endian qword at a byte offset', () => {
    expect(toHex(leU64('00000000' + '30f7beb2d4010000', 4))).toBe('0x1d4b2bef730')
  })
  it('formats zero', () => {
    expect(toHex(0n)).toBe('0x0')
  })
})

describe('cString', () => {
  it('stops at the first NUL', () => {
    expect(cString('6f6e6c696e6542616c616e6365006e6574576f727468')).toBe('onlineBalance')
  })
})

describe('decodeClass (real MoneyManager header)', () => {
  const cls = decodeClass(MONEY_CLASS_HEX)
  it('decodes the pointers', () => {
    expect(cls.imagePtr).toBe('0x1d4b0256000')
    expect(cls.namePtr).toBe('0x1d4c2a52329')
    expect(cls.namespacePtr).toBe('0x1d4c2a51dcd')
    expect(cls.parentPtr).toBe('0x1d4b26b1218')
    expect(cls.fieldsPtr).toBe('0x1d4b305d7e0')
    expect(cls.methodsPtr).toBe('0x1d4b26b1568')
    expect(cls.staticFieldsPtr).toBe('0x1d4d1b94c70')
  })
  it('decodes the counts', () => {
    expect(cls.methodCount).toBe(61)
    expect(cls.fieldCount).toBe(22)
    expect(cls.instanceSize).toBe(0x198)
  })
})

describe('decodeField (real MoneyManager fields)', () => {
  const record = (i: number) => MONEY_FIELDS_HEX.slice(i * FIELD_STRIDE * 2, (i + 1) * FIELD_STRIDE * 2)
  it('decodes onlineBalance at 0x128 with the right parent', () => {
    const f = decodeField(record(5))
    expect(f.offset).toBe(0x128)
    expect(f.parentPtr).toBe(MONEY_CLASS_PTR)
    expect(f.typePtr).toBe('0x7fffe86c0768')
    expect(f.namePtr).toBe('0x1d4c2a4e594')
  })
  it('every record parents to the class', () => {
    for (let i = 0; i < 12; i++) expect(decodeField(record(i)).parentPtr).toBe(MONEY_CLASS_PTR)
  })
})

describe('decodeType', () => {
  it('reads a public non-static float', () => {
    const t = decodeType(FLOAT_TYPE_HEX)
    expect(t.attrs).toBe(0x0006)
    expect(t.typeEnum).toBe(0x0c)
    expect(t.isStatic).toBe(false)
    expect(typeEnumToDataType(t.typeEnum)).toBe('float')
  })
  it('flags the static attribute', () => {
    expect(decodeType('00000000000000001600080000000000').isStatic).toBe(true)
  })
})

describe('decodeMethod (real MoneyManager methods)', () => {
  const record = (i: number) => MONEY_METHODS_HEX.slice(i * METHOD_STRIDE * 2, (i + 1) * METHOD_STRIDE * 2)
  it('decodes pointer, name pointer, class and static flag', () => {
    const m = decodeMethod(record(0))
    expect(m.pointer).toBe('0x7fffe52c7d60')
    expect(m.namePtr).toBe('0x1d4c2a52336')
    expect(m.klassPtr).toBe(MONEY_CLASS_PTR)
    expect(m.flags).toBe(0x96)
    expect(m.isStatic).toBe(true)
    expect(m.paramCount).toBe(1)
  })
  it('steps by the 0x58 stride', () => {
    expect(decodeMethod(record(1)).pointer).toBe('0x7fffe52c7d10')
  })
})

describe('typeEnumToDataType', () => {
  it('maps the numeric primitives and rejects the rest', () => {
    expect(typeEnumToDataType(0x02)).toBe('int8')
    expect(typeEnumToDataType(0x08)).toBe('int32')
    expect(typeEnumToDataType(0x0a)).toBe('int64')
    expect(typeEnumToDataType(0x0d)).toBe('double')
    expect(typeEnumToDataType(0x12)).toBeNull()
  })
})

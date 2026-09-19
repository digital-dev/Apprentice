import type { DataType } from '../cheatVerify'

// Byte decoders for the IL2CPP runtime structs the factory reads directly
// from the target's memory. Offsets are for Unity 2022.3 (verified live on
// Schedule I, see docs/superpowers/specs/2026-09-19-il2cpp-cheat-factory-
// design.md); they are per Unity version, so callers cross-check what they
// decode (a field's parent must equal its class) instead of trusting them.

export const FIELD_STRIDE = 0x20
export const METHOD_STRIDE = 0x58
// Enough of an Il2CppClass to reach field_count at +0x124.
export const CLASS_HEADER_BYTES = 0x130
export const TYPE_BYTES = 0x10

export function leU64(hex: string, byteOffset: number): bigint {
  return Buffer.from(hex, 'hex').readBigUInt64LE(byteOffset)
}

export function toHex(n: bigint): string {
  return '0x' + n.toString(16)
}

function ptrAt(buf: Buffer, offset: number): string {
  return toHex(buf.readBigUInt64LE(offset))
}

// Reads a NUL-terminated UTF-8 string out of a hex dump.
export function cString(hex: string): string {
  const buf = Buffer.from(hex, 'hex')
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8')
}

export interface ClassHeader {
  imagePtr: string
  namePtr: string
  namespacePtr: string
  parentPtr: string
  fieldsPtr: string
  methodsPtr: string
  staticFieldsPtr: string
  methodCount: number
  fieldCount: number
}

export function decodeClass(hex: string): ClassHeader {
  const buf = Buffer.from(hex, 'hex')
  return {
    imagePtr: ptrAt(buf, 0x00),
    namePtr: ptrAt(buf, 0x10),
    namespacePtr: ptrAt(buf, 0x18),
    parentPtr: ptrAt(buf, 0x58),
    fieldsPtr: ptrAt(buf, 0x80),
    methodsPtr: ptrAt(buf, 0x98),
    staticFieldsPtr: ptrAt(buf, 0xb8),
    methodCount: buf.readUInt16LE(0x120),
    fieldCount: buf.readUInt16LE(0x124)
  }
}

export interface FieldRecord {
  namePtr: string
  typePtr: string
  parentPtr: string
  offset: number
}

export function decodeField(hex: string): FieldRecord {
  const buf = Buffer.from(hex, 'hex')
  return {
    namePtr: ptrAt(buf, 0x00),
    typePtr: ptrAt(buf, 0x08),
    parentPtr: ptrAt(buf, 0x10),
    offset: buf.readInt32LE(0x18)
  }
}

export interface TypeRecord {
  attrs: number
  typeEnum: number
  isStatic: boolean
}

export function decodeType(hex: string): TypeRecord {
  const buf = Buffer.from(hex, 'hex')
  const attrs = buf.readUInt16LE(0x08)
  return { attrs, typeEnum: buf.readUInt8(0x0a), isStatic: (attrs & 0x10) !== 0 }
}

export interface MethodRecord {
  pointer: string
  namePtr: string
  klassPtr: string
  flags: number
  isStatic: boolean
  paramCount: number
}

export function decodeMethod(hex: string): MethodRecord {
  const buf = Buffer.from(hex, 'hex')
  const flags = buf.readUInt16LE(0x4c)
  return {
    pointer: ptrAt(buf, 0x00),
    namePtr: ptrAt(buf, 0x18),
    klassPtr: ptrAt(buf, 0x20),
    flags,
    isStatic: (flags & 0x10) !== 0,
    paramCount: buf.readUInt8(0x52)
  }
}

// Il2CppTypeEnum values for the numeric primitives a cheat can write.
const TYPE_ENUM_TO_DATA_TYPE: Record<number, DataType> = {
  0x02: 'int8', // boolean
  0x04: 'int8', // i1
  0x05: 'int8', // u1
  0x06: 'int16',
  0x07: 'int16',
  0x08: 'int32',
  0x09: 'int32',
  0x0a: 'int64',
  0x0b: 'int64',
  0x0c: 'float',
  0x0d: 'double'
}

export function typeEnumToDataType(typeEnum: number): DataType | null {
  return TYPE_ENUM_TO_DATA_TYPE[typeEnum] ?? null
}

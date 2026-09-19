// A sparse fake of a target process's memory plus builders for the IL2CPP
// structs the factory reads, so tests can construct small worlds without a
// live game. Layout offsets mirror src/factory/il2cppLayout.ts.

export class FakeMemory {
  private bytes = new Map<bigint, number>()

  set(address: bigint | number, hex: string): void {
    const base = BigInt(address)
    const buf = Buffer.from(hex, 'hex')
    for (let i = 0; i < buf.length; i++) this.bytes.set(base + BigInt(i), buf[i])
  }

  // Like a real mapped page: unreadable only when the first byte is
  // unmapped; later unwritten bytes read as zero.
  readBytes = (address: string, length: number): string | null => {
    const base = BigInt(address)
    if (!this.bytes.has(base)) return null
    const out = Buffer.alloc(length)
    for (let i = 0; i < length; i++) out[i] = this.bytes.get(base + BigInt(i)) ?? 0
    return out.toString('hex')
  }

  cstr(address: bigint | number, text: string): void {
    this.set(address, Buffer.from(text + '\0', 'utf8').toString('hex'))
  }

  float(address: bigint | number, value: number): void {
    const buf = Buffer.alloc(4)
    buf.writeFloatLE(value)
    this.set(address, buf.toString('hex'))
  }

  qword(address: bigint | number, value: bigint | number): void {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(BigInt(value))
    this.set(address, buf.toString('hex'))
  }
}

export interface ClassSpec {
  image?: bigint | number
  name: bigint | number
  namespace?: bigint | number
  parent?: bigint | number
  fields?: bigint | number
  methods?: bigint | number
  statics?: bigint | number
  methodCount?: number
  fieldCount?: number
}

export function classHex(s: ClassSpec): string {
  const buf = Buffer.alloc(0x130)
  buf.writeBigUInt64LE(BigInt(s.image ?? 0x9000), 0x00)
  buf.writeBigUInt64LE(BigInt(s.name), 0x10)
  buf.writeBigUInt64LE(BigInt(s.namespace ?? 0), 0x18)
  buf.writeBigUInt64LE(BigInt(s.parent ?? 0), 0x58)
  buf.writeBigUInt64LE(BigInt(s.fields ?? 0), 0x80)
  buf.writeBigUInt64LE(BigInt(s.methods ?? 0), 0x98)
  buf.writeBigUInt64LE(BigInt(s.statics ?? 0), 0xb8)
  buf.writeUInt16LE(s.methodCount ?? 0, 0x120)
  buf.writeUInt16LE(s.fieldCount ?? 0, 0x124)
  return buf.toString('hex')
}

export function fieldHex(namePtr: bigint | number, typePtr: bigint | number, parent: bigint | number, offset: number): string {
  const buf = Buffer.alloc(0x20)
  buf.writeBigUInt64LE(BigInt(namePtr), 0x00)
  buf.writeBigUInt64LE(BigInt(typePtr), 0x08)
  buf.writeBigUInt64LE(BigInt(parent), 0x10)
  buf.writeInt32LE(offset, 0x18)
  return buf.toString('hex')
}

export function typeHex(attrs: number, typeEnum: number): string {
  const buf = Buffer.alloc(0x10)
  buf.writeUInt16LE(attrs, 0x08)
  buf.writeUInt8(typeEnum, 0x0a)
  return buf.toString('hex')
}

export function methodHex(pointer: bigint | number, namePtr: bigint | number, klass: bigint | number, flags: number, params = 0): string {
  const buf = Buffer.alloc(0x58)
  buf.writeBigUInt64LE(BigInt(pointer), 0x00)
  buf.writeBigUInt64LE(BigInt(namePtr), 0x18)
  buf.writeBigUInt64LE(BigInt(klass), 0x20)
  buf.writeUInt16LE(flags, 0x4c)
  buf.writeUInt8(params, 0x52)
  return buf.toString('hex')
}

// Well-known Il2CppTypeEnum values used across tests.
export const T_FLOAT = 0x0c
export const T_INT32 = 0x08
export const T_CLASS = 0x12
export const ATTR_PUBLIC = 0x0006
export const ATTR_STATIC = 0x0016

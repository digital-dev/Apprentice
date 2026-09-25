import { toHex } from './il2cppLayout'

// Chases one level of pointer-sized fields off a known object, resolving
// each target's own class name (so "what is this field?" comes from the
// runtime's own metadata instead of a guess) and scanning its first few
// bytes for small integers in a caller-given range (candidate enum values —
// C# enums often decode as an opaque valuetype field rather than a plain
// int, so this is usually the only way to spot one from outside). See
// il2cpp-engine-instance-discovery.md (session memory) for the technique
// this formalizes: it's how "GhostAI+0x38 -> class GhostInfo" and the
// ghost-type/name/room fields inside it were found, entirely offline.
export interface ChaseOps {
  readBytes(address: string, length: number): string | null
}

export interface ChasedField {
  offset: string
  targetAddress: string | null
  namespaceName: string | null
  className: string | null
  smallInts: { offset: string; value: number }[]
}

function readCString(ops: ChaseOps, ptr: string): string | null {
  if (BigInt(ptr) < 0x10000n) return null
  const hex = ops.readBytes(ptr, 128)
  if (hex === null) return null
  const buf = Buffer.from(hex, 'hex')
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8')
}

function normalizeOffset(offsetHex: string): bigint {
  return BigInt(offsetHex.startsWith('0x') ? offsetHex : '0x' + offsetHex)
}

export function chasePointerFields(
  ops: ChaseOps,
  baseAddress: string,
  offsets: string[],
  opts: { scanBytes?: number; intMin?: number; intMax?: number } = {}
): ChasedField[] {
  const scanBytes = opts.scanBytes ?? 0x60
  const intMin = opts.intMin ?? 0
  const intMax = opts.intMax ?? 29
  const base = BigInt(baseAddress)

  return offsets.map((offsetHex): ChasedField => {
    const empty = { offset: offsetHex, targetAddress: null, namespaceName: null, className: null, smallInts: [] }
    const addr = toHex(base + normalizeOffset(offsetHex))
    const ptrHex = ops.readBytes(addr, 8)
    if (ptrHex === null) return empty

    const target = Buffer.from(ptrHex, 'hex').readBigUInt64LE(0)
    if (target < 0x10000n) return empty
    const targetAddress = toHex(target)

    const objHex = ops.readBytes(targetAddress, scanBytes)
    if (objHex === null) return { ...empty, targetAddress }
    const obuf = Buffer.from(objHex, 'hex')

    let namespaceName: string | null = null
    let className: string | null = null
    const klassPtr = obuf.readBigUInt64LE(0)
    if (klassPtr > 0x10000n) {
      // Il2CppClass: namePtr @0x10, namespacePtr @0x18 (see il2cppLayout.ts).
      const classHex = ops.readBytes(toHex(klassPtr), 0x20)
      if (classHex !== null) {
        const cbuf = Buffer.from(classHex, 'hex')
        className = readCString(ops, toHex(cbuf.readBigUInt64LE(0x10)))
        namespaceName = readCString(ops, toHex(cbuf.readBigUInt64LE(0x18)))
      }
    }

    const smallInts: { offset: string; value: number }[] = []
    for (let o = 0x10; o + 4 <= obuf.length; o += 4) {
      const v = obuf.readInt32LE(o)
      if (v >= intMin && v <= intMax) smallInts.push({ offset: '0x' + o.toString(16), value: v })
    }

    return { offset: offsetHex, targetAddress, namespaceName, className, smallInts }
  })
}

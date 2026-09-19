import { leU64, toHex } from './il2cppLayout'

// The only step of IL2CPP enumeration that executes code in the target: a
// handful of il2cpp_* calls to reach the game image, then a memory scan for
// its contiguous class table. After this everything is plain reads.
// See docs/superpowers/specs/2026-09-07-il2cpp-symbol-resolution-design.md
// for why each call's result is validated before it is used as an argument:
// a bad pointer handed to a remote call crashes the game.
export type BootstrapCall =
  | 'domain_get'
  | 'assembly_open'
  | 'assembly_get_image'
  | 'image_class_count'
  | 'image_get_class'

export interface BootstrapOps {
  call(fn: BootstrapCall, args: string[]): Promise<string | null>
  // Writes a NUL-terminated string into a scratch buffer, returns its address.
  writeString(text: string): string
  scanQword(value: bigint): Promise<string[]>
  readBytes(address: string, length: number): string | null
}

const MAX_CLASSES = 200000
const READ_CHUNK_BYTES = 0x8000

async function callChecked(ops: BootstrapOps, fn: BootstrapCall, args: string[]): Promise<string> {
  const raw = await ops.call(fn, args)
  if (raw === null) throw new Error(`il2cpp ${fn} failed (remote call returned null)`)
  const value = BigInt(raw)
  if (value === 0n) throw new Error(`il2cpp ${fn} returned 0`)
  return toHex(value)
}

// Returns every class pointer of the named assembly, in table order.
export async function findClassTable(ops: BootstrapOps, assemblyName = 'Assembly-CSharp'): Promise<string[]> {
  const domain = await callChecked(ops, 'domain_get', [])
  const nameAddress = ops.writeString(assemblyName)
  const assembly = await callChecked(ops, 'assembly_open', [domain, nameAddress])
  const image = await callChecked(ops, 'assembly_get_image', [assembly])

  const count = Number(BigInt(await callChecked(ops, 'image_class_count', [image])))
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLASSES) {
    throw new Error(`implausible class count ${count} for image ${image}`)
  }

  const class0 = BigInt(await callChecked(ops, 'image_get_class', [image, '0x0']))
  const class1 = BigInt(await callChecked(ops, 'image_get_class', [image, '0x1']))

  // Class 0's pointer also appears inside class 0 itself (element_class and
  // friends); the table entry is the hit whose next qword is class 1.
  let tableAddress: bigint | null = null
  for (const hit of await ops.scanQword(class0)) {
    const next = ops.readBytes(toHex(BigInt(hit) + 8n), 8)
    if (next !== null && leU64(next, 0) === class1) {
      tableAddress = BigInt(hit)
      break
    }
  }
  if (tableAddress === null) {
    throw new Error(`could not find the class table for ${assemblyName} (no scan hit is followed by class 1)`)
  }

  const pointers: string[] = []
  const totalBytes = count * 8
  for (let done = 0; done < totalBytes; done += READ_CHUNK_BYTES) {
    const length = Math.min(READ_CHUNK_BYTES, totalBytes - done)
    const chunk = ops.readBytes(toHex(tableAddress + BigInt(done)), length)
    if (chunk === null) throw new Error(`class table unreadable at offset ${done}`)
    for (let i = 0; i < length; i += 8) pointers.push(toHex(leU64(chunk, i)))
  }
  return pointers
}

export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'

export interface MonoTarget {
  kind: 'mono'
  className: string
  staticFieldName: string
  instanceFieldName?: string
  instanceClassName?: string
  pointerFieldOffset?: string
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export interface AnchorTarget {
  kind: 'anchor'
  patchId: string
  offset: string
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export interface ChainTarget {
  moduleName: string
  baseOffset: string
  offsets: string[]
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export type CheatTarget = MonoTarget | AnchorTarget | ChainTarget

export interface CheatDefinition {
  kind?: 'value'
  id: string
  name: string
  dataType: DataType
  targets: CheatTarget[]
  value: number
}

export function isAnchorTarget(target: CheatTarget): target is AnchorTarget {
  return (target as AnchorTarget).kind === 'anchor'
}

export function isMonoTarget(target: CheatTarget): target is MonoTarget {
  return (target as MonoTarget).kind === 'mono'
}

export interface MonoResolveOps {
  resolveClass(handle: number, monoDllBase: string, namespaceName: string, className: string): Promise<string | null>
  resolveField(
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<{ offset: number } | null>
  staticFieldAddress(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<string | null>
  readBytes(address: string, length: number): string | null
}

function addHex(address: string, delta: bigint): string {
  return '0x' + (BigInt(address) + delta).toString(16)
}

function littleEndianPointer(hex: string): bigint {
  return Buffer.from(hex, 'hex').readBigUInt64LE(0)
}

// Direct port of src/main/monoTargetResolve.ts's resolveMonoTargetAddress --
// kept as a separate, self-contained copy rather than a cross-package import
// because that file transitively imports 'electron' via ipc.ts, which throws
// outside the Electron process.
export async function resolveMonoTargetAddress(
  target: MonoTarget,
  handle: number,
  monoDllBase: string,
  ops: MonoResolveOps
): Promise<string | null> {
  const classHandle = await ops.resolveClass(handle, monoDllBase, '', target.className)
  if (classHandle === null) return null

  const staticAddress = await ops.staticFieldAddress(handle, monoDllBase, classHandle, target.staticFieldName)
  if (staticAddress === null) return null

  if (target.instanceFieldName === undefined) return staticAddress

  const fieldClassHandle =
    target.instanceClassName === undefined
      ? classHandle
      : await ops.resolveClass(handle, monoDllBase, '', target.instanceClassName)
  if (fieldClassHandle === null) return null

  const field = await ops.resolveField(handle, monoDllBase, fieldClassHandle, target.instanceFieldName)
  if (field === null) return null

  const pointerHex = ops.readBytes(staticAddress, 8)
  if (pointerHex === null) return null
  const objectPointer = littleEndianPointer(pointerHex)
  if (objectPointer === 0n) return null

  const firstHopAddress = addHex('0x' + objectPointer.toString(16), BigInt(field.offset))
  if (target.pointerFieldOffset === undefined) return firstHopAddress

  const secondPointerHex = ops.readBytes(firstHopAddress, 8)
  if (secondPointerHex === null) return null
  const secondObjectPointer = littleEndianPointer(secondPointerHex)
  if (secondObjectPointer === 0n) return null

  return addHex('0x' + secondObjectPointer.toString(16), BigInt(target.pointerFieldOffset))
}

export function valueMatches(read: number, expected: number, dataType: DataType): boolean {
  if (dataType === 'float' || dataType === 'double') return Math.abs(read - expected) < 1.0
  return read === expected
}

export function extractBit(raw: number, bitIndex: number | undefined): number {
  return bitIndex !== undefined ? (raw >> bitIndex) & 1 : raw
}

export interface TargetStatus {
  supported: boolean
  alive: boolean | null
  value: number | null
  expected: number | null
  matches: boolean | null
  reason?: string
}

export function buildTargetStatus(
  resolvedAddress: string | null,
  readValue: (address: string) => number | null,
  target: MonoTarget | ChainTarget,
  cheatValue: number,
  cheatDataType: DataType
): TargetStatus {
  if (resolvedAddress === null) {
    return { supported: true, alive: false, value: null, expected: null, matches: null }
  }
  const raw = readValue(resolvedAddress)
  if (raw === null) {
    return { supported: true, alive: false, value: null, expected: null, matches: null }
  }
  const value = extractBit(raw, target.bitIndex)
  const expected = target.value ?? cheatValue
  const dataType = target.dataType ?? cheatDataType
  return { supported: true, alive: true, value, expected, matches: valueMatches(value, expected, dataType) }
}

export function unsupportedAnchorStatus(): TargetStatus {
  return {
    supported: false,
    alive: null,
    value: null,
    expected: null,
    matches: null,
    reason:
      'anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only'
  }
}

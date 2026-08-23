import path from 'node:path'

// The trainer app's own compiled native addon — this file is the only
// place in mcp-server/ that touches it directly, mirroring how
// src/main/nativeAddon.ts is the sole require() site on the Electron side.
// Same relative shape: mcp-server/src -> repo root -> native/build/Release.
const addon = require(path.join(__dirname, '../../native/build/Release/memory_addon.node'))

export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'

export interface ProcessInfo { pid: number; name: string }
export interface ModuleInfo {
  name: string
  base: string
  size: number
  timestamp: number
  version: string | null
}
export interface AttachResult { handle: number; baseAddress: string }
export interface Candidate { address: string; value: number }
export type ScanFilter =
  | { mode: 'exact'; value: number }
  | { mode: 'changed' | 'unchanged' | 'increased' | 'decreased' }
export interface DisasmRow {
  address: string
  bytes: string
  text: string
  length: number
}
export interface CaughtInstruction {
  instructionAddress: string
  bytes: string
  length: number
  signature: string
  baseRegister: string
  displacement: string
  baseAddress: string
  effectiveAddress: string
  accessBytes: number
  indexed: boolean
  moduleName: string | null
  moduleOffset: string | null
}

export const listProcesses = (): ProcessInfo[] => addon.listProcesses()
export const attach = (pid: number): AttachResult => addon.attach(pid)
export const listModules = (handle: number): ModuleInfo[] => addon.listModules(handle)
export const scanFirst = (handle: number, dataType: DataType, value: number): Promise<Candidate[]> =>
  addon.scanFirst(handle, dataType, value)
export const scanNext = (
  handle: number,
  candidates: Candidate[],
  dataType: DataType,
  filter: ScanFilter
): Promise<Candidate[]> => addon.scanNext(handle, candidates, dataType, filter)
export const scanAob = (
  handle: number,
  signature: string,
  rangeStart?: string,
  rangeEnd?: string
): Promise<string[]> => addon.scanAob(handle, signature, rangeStart, rangeEnd)
export const monoResolveClass = (
  handle: number,
  monoDllBase: string,
  namespaceName: string,
  className: string
): Promise<string | null> => addon.monoResolveClass(handle, monoDllBase, namespaceName, className)
export const monoResolveField = (
  handle: number,
  monoDllBase: string,
  classHandle: string,
  fieldName: string
): Promise<{ offset: number } | null> => addon.monoResolveField(handle, monoDllBase, classHandle, fieldName)
export const monoStaticFieldAddress = (
  handle: number,
  monoDllBase: string,
  classHandle: string,
  fieldName: string
): Promise<string | null> => addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName)
export const monoListFieldNames = (
  handle: number,
  monoDllBase: string,
  classHandle: string
): Promise<string[]> => addon.monoListFieldNames(handle, monoDllBase, classHandle)
export const monoListMethodNames = (
  handle: number,
  monoDllBase: string,
  classHandle: string
): Promise<string[]> => addon.monoListMethodNames(handle, monoDllBase, classHandle)
export const disassembleBuffer = (
  buffer: Buffer,
  baseAddress: string,
  maxCount?: number
): DisasmRow[] => addon.disassembleBuffer(buffer, baseAddress, maxCount)
export const startWriteWatch = (pid: number, address: string): void => addon.startWriteWatch(pid, address)
export const pollWriteWatch = (): CaughtInstruction[] => addon.pollWriteWatch()
export const stopWriteWatch = (): CaughtInstruction[] => addon.stopWriteWatch()

// readBytes/readValue throw on an unresolvable chain or unreadable memory —
// routine, expected outcomes during exploration (wrong address, module
// unloaded), not exceptional ones. Same non-throwing convention
// src/main/nativeAddon.ts already established for the same reason.
export const tryReadBytes = (handle: number, address: string, length: number): string | null => {
  try {
    return addon.readBytes(handle, address, length)
  } catch {
    return null
  }
}
export const tryReadValue = (
  handle: number,
  baseAddress: string,
  offsets: string[],
  dataType: DataType
): number | null => {
  try {
    return addon.readValue(handle, baseAddress, offsets, dataType)
  } catch {
    return null
  }
}

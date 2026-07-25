import path from 'node:path'

const addon = require(path.join(__dirname, '../../native/build/Release/memory_addon.node'))

export interface ProcessInfo { pid: number; name: string }
export interface AttachResult { handle: number; baseAddress: string }
export type ScanFilter =
  | { mode: 'exact'; value: number }
  | { mode: 'changed' | 'unchanged' | 'increased' | 'decreased'; previous: number[] }

export const nativeAddon = {
  listProcesses: (): ProcessInfo[] => addon.listProcesses(),
  attach: (pid: number): AttachResult => addon.attach(pid),
  scanFirst: (handle: number, dataType: string, value: number): string[] =>
    addon.scanFirst(handle, dataType, value),
  scanNext: (handle: number, addresses: string[], dataType: string, filter: ScanFilter): string[] =>
    addon.scanNext(handle, addresses, dataType, filter),
  resolvePointerChain: (
    handle: number,
    baseAddress: string,
    target: string,
    maxLevels: number
  ): { offsets: string[] } | null => addon.resolvePointerChain(handle, baseAddress, target, maxLevels),
  readValue: (handle: number, baseAddress: string, offsets: string[], dataType: string): number =>
    addon.readValue(handle, baseAddress, offsets, dataType),
  writeValue: (
    handle: number,
    baseAddress: string,
    offsets: string[],
    dataType: string,
    value: number
  ): boolean => addon.writeValue(handle, baseAddress, offsets, dataType, value)
}

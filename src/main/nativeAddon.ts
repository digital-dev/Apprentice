import path from 'node:path'

const addon = require(path.join(__dirname, '../../native/build/Release/memory_addon.node'))

export interface ProcessInfo { pid: number; name: string }
export interface AttachResult { handle: number; baseAddress: string }
export interface Candidate { address: string; value: number }
export type ScanFilter =
  | { mode: 'exact'; value: number }
  | { mode: 'changed' | 'unchanged' | 'increased' | 'decreased' }

export const nativeAddon = {
  listProcesses: (): ProcessInfo[] => addon.listProcesses(),
  attach: (pid: number): AttachResult => addon.attach(pid),
  // scanFirst and resolvePointerChain run on a background thread in the
  // native addon (Napi::AsyncWorker) and return Promises — walking a real
  // game's entire committed memory takes real wall-clock time even after
  // the read/search optimizations, and running that synchronously on the
  // main thread would block the whole Electron app for the duration.
  scanFirst: (handle: number, dataType: string, value: number): Promise<Candidate[]> =>
    addon.scanFirst(handle, dataType, value),
  scanNext: (
    handle: number,
    candidates: Candidate[],
    dataType: string,
    filter: ScanFilter
  ): Candidate[] => addon.scanNext(handle, candidates, dataType, filter),
  resolvePointerChain: (
    handle: number,
    target: string,
    maxLevels: number
  ): Promise<{ moduleName: string; offsets: string[] } | null> =>
    addon.resolvePointerChain(handle, target, maxLevels),
  getModuleBase: (handle: number, moduleName: string): string | null =>
    addon.getModuleBase(handle, moduleName),
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

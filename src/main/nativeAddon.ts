import path from 'node:path'

const addon = require(path.join(__dirname, '../../native/build/Release/memory_addon.node'))

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
export interface CaughtInstruction {
  instructionAddress: string
  bytes: string
  length: number
  signature: string
  baseRegister: string
  displacement: string
  baseAddress: string
  // The actually-decoded destination and its access width — distinct from
  // baseAddress/displacement, which (once a covering match is accepted) are
  // trivially reconstructible to the watched address and can't also serve as
  // a check that the right instruction was found. See write_watch.cc's
  // Caught struct comment.
  effectiveAddress: string
  accessBytes: number
  // Whether the matched operand used an index register — if so, the folded
  // `displacement` pins whatever index was live at capture time, which is
  // not necessarily stable across runs.
  indexed: boolean
  moduleName: string | null
  moduleOffset: string | null
}

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
  // readValue throws when the chain can't be resolved or the final address
  // isn't readable. Revalidation checks many targets and treats "unreadable"
  // as a normal, expected outcome (a dead target) rather than an error, so
  // it uses this non-throwing form: the value if the chain resolves to
  // readable memory, or null if it doesn't.
  tryReadValue: (
    handle: number,
    baseAddress: string,
    offsets: string[],
    dataType: string
  ): number | null => {
    try {
      return addon.readValue(handle, baseAddress, offsets, dataType)
    } catch {
      return null
    }
  },
  writeValue: (
    handle: number,
    baseAddress: string,
    offsets: string[],
    dataType: string,
    value: number
  ): boolean => addon.writeValue(handle, baseAddress, offsets, dataType, value),
  readBytes: (handle: number, address: string, length: number): string =>
    addon.readBytes(handle, address, length),
  // Verify-before-patch treats "can't read there" as a normal outcome (the
  // module moved, the JIT code is gone), not an error, so it uses this
  // non-throwing form — same split as readValue/tryReadValue.
  tryReadBytes: (handle: number, address: string, length: number): string | null => {
    try {
      return addon.readBytes(handle, address, length)
    } catch {
      return null
    }
  },
  writeBytes: (handle: number, address: string, hexBytes: string): boolean =>
    addon.writeBytes(handle, address, hexBytes),
  // Runs on a background thread in the addon (Napi::AsyncWorker) and returns
  // a Promise. Bounds are optional and restrict the walk to one module's
  // address range; absent bounds walk all executable memory, exactly as
  // before.
  scanAob: (
    handle: number,
    signature: string,
    rangeStart?: string,
    rangeEnd?: string
  ): Promise<string[]> => addon.scanAob(handle, signature, rangeStart, rangeEnd),
  startWriteWatch: (pid: number, address: string): void =>
    addon.startWriteWatch(pid, address),
  pollWriteWatch: (): CaughtInstruction[] => addon.pollWriteWatch(),
  stopWriteWatch: (): CaughtInstruction[] => addon.stopWriteWatch(),
  allocateCave: (handle: number, nearAddress: string): string | null =>
    addon.allocateCave(handle, nearAddress),
  decodeRun: (
    handle: number,
    address: string,
    minBytes: number
  ): {
    length: number
    decodable: boolean
    relocatable: boolean
    clobbers: string[]
  } => addon.decodeRun(handle, address, minBytes),
  encodeStore: (baseRegister: string, offset: number, imm32: number): string =>
    addon.encodeStore(baseRegister, offset, imm32),
  encodeCaptureOnce: (baseRegister: string, atAddress: string, slotAddress: string): string =>
    addon.encodeCaptureOnce(baseRegister, atAddress, slotAddress),
  // The guard prefix for a shared write: compares the object register
  // against a self-arming slot and skips the write for that object only.
  encodeGuardedSkip: (
    baseRegister: string,
    atAddress: string,
    slotAddress: string,
    returnAddress: string
  ): string => addon.encodeGuardedSkip(baseRegister, atAddress, slotAddress, returnAddress),
  encodeJump: (from: string, to: string): string => addon.encodeJump(from, to),
  // Which backend the addon was built with, and whether injection works on
  // it. The Linux stub loads and reports false rather than failing at some
  // later, more confusing point.
  platformName: (): { name: string; supported: boolean } => addon.platformName(),
  suspendThreads: (handle: number, pid: number): boolean =>
    addon.suspendThreads(handle, pid),
  resumeThreads: (): void => addon.resumeThreads(),
  // Every module loaded in the target, with the PE fields a build
  // fingerprint is made of. Returns [] rather than throwing when the
  // process is protected or exiting — "cannot verify" is a normal answer.
  listModules: (handle: number): ModuleInfo[] => addon.listModules(handle)
}

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

// The `state` handoff table only round-trips flat key->primitive entries;
// nested tables/functions a script stores in `state` are dropped natively.
export type LuaValue = string | number | boolean

export const nativeAddon = {
  listProcesses: (): ProcessInfo[] => addon.listProcesses(),
  attach: (pid: number): AttachResult => addon.attach(pid),
  // Closes the OS handle attach() returned. Every path that stops using a
  // handle (re-attach to a different pid, the watcher's onVanish, app quit)
  // must call this — attach() previously had no matching close anywhere in
  // the codebase, leaking one kernel handle per attach/relaunch cycle.
  detach: (handle: number): boolean => addon.detach(handle),
  // scanFirst, scanNext and resolvePointerChain run on a background thread in
  // the native addon (Napi::AsyncWorker) and return Promises — walking a real
  // game's entire committed memory takes real wall-clock time even after
  // the read/search optimizations, and running that synchronously on the
  // main thread would block the whole Electron app for the duration. scanNext
  // is the same story per-candidate: an under-narrowed first scan can leave
  // hundreds of thousands of addresses, one syscall each.
  scanFirst: (handle: number, dataType: string, value: number): Promise<Candidate[]> =>
    addon.scanFirst(handle, dataType, value),
  scanNext: (
    handle: number,
    candidates: Candidate[],
    dataType: string,
    filter: ScanFilter
  ): Promise<Candidate[]> => addon.scanNext(handle, candidates, dataType, filter),
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
  // Raw-Buffer counterpart to readBytes/tryReadBytes, for a caller that
  // wants to decode the bytes itself (DataView, multiple widths at once)
  // instead of re-parsing a hex string — the memory viewer's whole reason
  // for existing. Same throw-on-failure contract as readBytes.
  readMemoryBlock: (handle: number, address: string, length: number): Buffer =>
    addon.readBytes(handle, address, length, true),
  // Non-throwing form for a 250ms poll landing on unmapped memory — an
  // expected, routine outcome for a viewer jumping to an arbitrary
  // address, not an error. Same split as tryReadBytes/tryReadValue.
  tryReadMemoryBlock: (handle: number, address: string, length: number): Buffer | null => {
    try {
      return addon.readBytes(handle, address, length, true)
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
  // The entry-point guard for `immune` mode: compares argRegister (the
  // hooked method's "this") against the pointer stored at
  // playerPointerAddress and returns from the whole method on match; falls
  // through to returnAddress — where the caller places the replayed run —
  // on no match. Distinct from encodeGuardedSkip: a match here never falls
  // back into the function at all.
  // returnKind/returnBits are optional and both-or-neither: absent means
  // the original "return bare 0" shape (a skip, for a method like
  // ApplyDamage whose caller doesn't care what comes back). Set them to
  // force a SPECIFIC value back instead — the shape a getter like
  // Character:GetHealth needs, where returning nothing meaningful isn't an
  // option. returnBits is the raw 32 bits to load — an int32 value as-is,
  // or a float's IEEE-754 bit pattern (patchEngine.ts's own valueBits()
  // already produces exactly this for `force` mode; reuse it here too).
  encodeImmuneGuard: (
    playerPointerAddress: string,
    argRegister: string,
    caveCodeAddress: string,
    returnAddress: string,
    returnKind?: 'int32' | 'float',
    returnBits?: number
  ): string =>
    addon.encodeImmuneGuard(
      playerPointerAddress,
      argRegister,
      caveCodeAddress,
      returnAddress,
      returnKind,
      returnBits
    ),
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
  listModules: (handle: number): ModuleInfo[] => addon.listModules(handle),
  // Makes the target execute a call into one of its own exported
  // functions, on a throwaway thread, and reports the 8-byte return value
  // back (as 0x-prefixed hex), or null on failure/timeout. Up to 4
  // pointer/integer arguments. Runs on a background thread in the addon
  // (Napi::AsyncWorker) — a remote call can take up to its 2s timeout.
  callRemoteFunction: (
    handle: number,
    functionAddress: string,
    args: string[]
  ): Promise<string | null> => addon.callRemoteFunction(handle, functionAddress, args),
  // Resolves a MonoClass* by namespace + name, and a field's offset or its
  // own storage address, by making the target call its own Mono runtime's
  // introspection functions on a throwaway attached thread. Null on any
  // failure (class/field not found, Mono not loaded, attach failed) —
  // never throws.
  monoResolveClass: (
    handle: number,
    monoDllBase: string,
    namespaceName: string,
    className: string
  ): Promise<string | null> => addon.monoResolveClass(handle, monoDllBase, namespaceName, className),
  monoResolveField: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<{ offset: number } | null> =>
    addon.monoResolveField(handle, monoDllBase, classHandle, fieldName),
  monoStaticFieldAddress: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    fieldName: string
  ): Promise<string | null> => addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName),
  monoCompileMethod: (
    handle: number,
    monoDllBase: string,
    classHandle: string,
    methodName: string
  ): Promise<string | null> => addon.monoCompileMethod(handle, monoDllBase, classHandle, methodName),
  // Every field/method name on a class, or every loaded assembly handle —
  // loop-driven the same way resolveField/compileMethod are, except
  // collecting every match instead of stopping at the first. Empty array
  // rather than throwing on any failure (Mono not loaded, attach failed).
  monoListFieldNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    addon.monoListFieldNames(handle, monoDllBase, classHandle),
  monoListMethodNames: (handle: number, monoDllBase: string, classHandle: string): Promise<string[]> =>
    addon.monoListMethodNames(handle, monoDllBase, classHandle),
  monoListAssemblies: (handle: number, monoDllBase: string): Promise<string[]> =>
    addon.monoListAssemblies(handle, monoDllBase),
  monoListAssemblyNames: (
    handle: number,
    monoDllBase: string
  ): Promise<{ image: string; name: string }[]> => addon.monoListAssemblyNames(handle, monoDllBase),
  // classHandle is the class's own resolved MonoClass* — the TypeDef walk
  // behind this already produces it (mono_class_get, per row) to get the
  // name/namespace it returns anyway; returning it too means a caller can
  // use the class directly instead of a second, separate, ambiguous-by-name
  // monoResolveClass call for it. See mono_bridge.cc's ClassEntry comment
  // for the bug that silently resolving the wrong same-named class caused.
  monoListClassesInImage: (
    handle: number,
    monoDllBase: string,
    imageHandle: string
  ): Promise<{ namespaceName: string; className: string; classHandle: string }[]> =>
    addon.monoListClassesInImage(handle, monoDllBase, imageHandle),
  // Runs `source` in a fresh, sandboxed Lua 5.4 state: an explicit
  // allowlist of libraries (no io/package/debug/os.execute/os.exit/load),
  // a 5-second execution cap and an 8 MB allocation cap. `handle` is the
  // target process's HANDLE, threaded through so the bound memory globals
  // (readInt32/writeInt32/readBytes/etc.) know which process to touch.
  // Runs on a background thread (Napi::AsyncWorker), same as scanAob/
  // resolvePointerChain — a script can legitimately run for up to its
  // 5-second cap, and must not block the Electron main thread for that
  // whole time. stateIn seeds the script's `state` global (for the
  // enable/disable value handoff); stateOut is `state`'s contents after
  // the run.
  runScript: (
    handle: number,
    source: string,
    stateIn: Record<string, LuaValue>
  ): Promise<{
    success: boolean
    output: string[]
    error: string | null
    stateOut: Record<string, LuaValue>
  }> => addon.runScript(handle, source, stateIn)
}

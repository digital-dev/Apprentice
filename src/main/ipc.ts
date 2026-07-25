import { ipcMain, BrowserWindow } from 'electron'
import { nativeAddon, Candidate } from './nativeAddon'
import { loadCheats, saveCheat, deleteCheat, CheatDefinition, ChainTarget, StoredCheat, PatchCheat } from './store'
import { PatchEngine, PatchOps } from './patchEngine'
import { FreezeLoop } from './freezeLoop'

let attachedHandle: number | null = null
let attachedBase: string | null = null
let attachedPid: number | null = null

// The native addon's readValue/writeValue walk a single combined offsets
// array as: addr = base; for each offset: addr += offset; dereference
// unless it's the last one. Each target's schema splits that array into
// `baseOffset` (first element) and `offsets` (the remainder), so it must
// be recombined before being passed to the native addon.
function fullOffsets(target: ChainTarget): string[] {
  return [target.baseOffset, ...target.offsets]
}

// A cheat writes to every one of its targets on each call, not just the
// first. Naive memory scanning sometimes resolves a chain that only looks
// static and stops working after a few seconds even though other
// candidates from the same scan keep resolving correctly — writing to all
// selected targets and succeeding if ANY of them do makes the cheat
// resilient to any single target going stale, rather than the whole cheat
// flipping to broken the moment its one chain does.
//
// Each target can be anchored to a different module (see
// resolvePointerChain's moduleName), not necessarily the module attach()
// happened to report first — so each target's base must be looked up by
// name, fresh, rather than reusing the single attachedBase captured at
// attach time.
function writeCheat(handle: number, cheat: CheatDefinition): boolean {
  let anySucceeded = false
  for (const target of cheat.targets) {
    const moduleBase = nativeAddon.getModuleBase(handle, target.moduleName)
    if (moduleBase === null) continue
    const ok = nativeAddon.writeValue(
      handle,
      moduleBase,
      fullOffsets(target),
      cheat.dataType,
      cheat.value
    )
    if (ok) anySucceeded = true
  }
  return anySucceeded
}

// Per-target liveness for revalidation: alive means the target's module is
// loaded and its chain resolves to readable memory (optionally holding the
// expected value). `value` is what the target currently reads, or null if
// it doesn't resolve.
export interface TargetStatus {
  alive: boolean
  value: number | null
}

// The user-facing value they read off a rounded in-game display won't
// exactly equal the underlying float, so float verification tolerates a
// small window; ints are matched exactly.
function valueMatches(read: number, expected: number, dataType: string): boolean {
  if (dataType === 'float') return Math.abs(read - expected) < 1.0
  return read === expected
}

function verifyCheat(
  handle: number,
  cheat: CheatDefinition,
  expectedValue: number | null
): TargetStatus[] {
  return cheat.targets.map((target) => {
    const moduleBase = nativeAddon.getModuleBase(handle, target.moduleName)
    if (moduleBase === null) return { alive: false, value: null }
    const value = nativeAddon.tryReadValue(
      handle,
      moduleBase,
      fullOffsets(target),
      cheat.dataType
    )
    if (value === null) return { alive: false, value: null }
    const alive = expectedValue === null ? true : valueMatches(value, expectedValue, cheat.dataType)
    return { alive, value }
  })
}

const freezeLoop = new FreezeLoop((cheat) => {
  if (attachedHandle === null) return false
  return writeCheat(attachedHandle, cheat)
})
freezeLoop.start()

// The engine's view of the target process. Each call reads the CURRENT
// attachedHandle rather than capturing one, so the engine keeps working
// across a re-attach without being rebuilt. Reads are the non-throwing
// form: "can't read there" is an expected outcome for a patch whose code
// has moved, not an error.
const patchOps: PatchOps = {
  getModuleBase: (moduleName) =>
    attachedHandle === null ? null : nativeAddon.getModuleBase(attachedHandle, moduleName),
  readBytes: (address, length) =>
    attachedHandle === null ? null : nativeAddon.tryReadBytes(attachedHandle, address, length),
  writeBytes: (address, hexBytes) =>
    attachedHandle === null ? false : nativeAddon.writeBytes(attachedHandle, address, hexBytes),
  scanAob: async (signature) =>
    attachedHandle === null ? [] : nativeAddon.scanAob(attachedHandle, signature)
}

const patchEngine = new PatchEngine(patchOps)

// Called on app quit (from index.ts) so Tamper never leaves a game's code
// modified after it closes.
export function restoreAllPatches(): void {
  patchEngine.restoreAll()
}

export function registerIpcHandlers(getWindow: () => BrowserWindow): void {
  freezeLoop.onDegraded((cheatId) => {
    getWindow().webContents.send('cheat:broken', cheatId)
  })
  freezeLoop.onRecovered((cheatId) => {
    getWindow().webContents.send('cheat:recovered', cheatId)
  })

  ipcMain.handle('process:list', () => nativeAddon.listProcesses())

  ipcMain.handle('process:attach', (_e, pid: number) => {
    // Attaching elsewhere means letting go of the current process — put its
    // code back first, while its handle is still valid.
    if (attachedHandle !== null && attachedPid !== pid) patchEngine.restoreAll()
    const { handle, baseAddress } = nativeAddon.attach(pid)
    attachedHandle = handle
    attachedBase = baseAddress
    attachedPid = pid
    return { handle, baseAddress }
  })

  ipcMain.handle('cheats:load', (_e, exeName: string): StoredCheat[] => loadCheats(exeName))

  ipcMain.handle('cheats:save', (_e, exeName: string, cheat: StoredCheat) => {
    saveCheat(exeName, cheat)
  })

  ipcMain.handle('cheats:delete', (_e, exeName: string, cheatId: string) => {
    freezeLoop.disable(cheatId)
    // A deleted patch must not stay in the game's code — restore it while
    // we still have its recorded address and original bytes.
    if (patchEngine.isApplied(cheatId)) {
      const stored = loadCheats(exeName).find((c) => c.id === cheatId)
      if (stored && stored.kind === 'patch') patchEngine.restore(stored)
    }
    deleteCheat(exeName, cheatId)
  })

  ipcMain.handle('cheats:toggleFreeze', (_e, cheat: CheatDefinition, enabled: boolean) => {
    if (enabled) freezeLoop.enable(cheat)
    else freezeLoop.disable(cheat.id)
  })

  ipcMain.handle('cheats:oneShot', (_e, cheat: CheatDefinition) => {
    if (attachedHandle === null) return false
    return writeCheat(attachedHandle, cheat)
  })

  ipcMain.handle(
    'cheats:verify',
    (_e, cheat: CheatDefinition, expectedValue: number | null): TargetStatus[] => {
      if (attachedHandle === null) throw new Error('not attached')
      return verifyCheat(attachedHandle, cheat, expectedValue)
    }
  )

  ipcMain.handle('scan:first', (_e, dataType: string, value: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.scanFirst(attachedHandle, dataType, value)
  })

  ipcMain.handle('scan:next', (_e, candidates: Candidate[], dataType: string, filter: unknown) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.scanNext(attachedHandle, candidates, dataType, filter as never)
  })

  ipcMain.handle('scan:resolveChain', (_e, target: string, maxLevels: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.resolvePointerChain(attachedHandle, target, maxLevels)
  })

  ipcMain.handle('writeWatch:start', (_e, address: string) => {
    if (attachedPid === null) throw new Error('not attached')
    freezeLoop.stop() // pause freezing during a capture
    try {
      nativeAddon.startWriteWatch(attachedPid, address)
    } catch (err) {
      freezeLoop.start() // capture failed to start — don't leave freezing off
      throw err
    }
  })

  ipcMain.handle('writeWatch:poll', () => nativeAddon.pollWriteWatch())

  ipcMain.handle('writeWatch:stop', () => {
    const result = nativeAddon.stopWriteWatch()
    freezeLoop.start() // resume freezing
    return result
  })

  ipcMain.handle('patch:locate', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) throw new Error('not attached')
    return patchEngine.locate(patch)
  })

  ipcMain.handle('patch:apply', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) throw new Error('not attached')
    return patchEngine.apply(patch)
  })

  ipcMain.handle('patch:restore', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) return true // process gone; its code went with it
    return patchEngine.restore(patch)
  })
}

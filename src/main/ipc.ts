import { ipcMain, BrowserWindow } from 'electron'
import { nativeAddon, Candidate } from './nativeAddon'
import { loadCheats, saveCheat, deleteCheat, CheatDefinition, ChainTarget } from './store'
import { FreezeLoop } from './freezeLoop'

let attachedHandle: number | null = null
let attachedBase: string | null = null

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

const freezeLoop = new FreezeLoop((cheat) => {
  if (attachedHandle === null) return false
  return writeCheat(attachedHandle, cheat)
})
freezeLoop.start()

export function registerIpcHandlers(getWindow: () => BrowserWindow): void {
  freezeLoop.onBroken((cheatId) => {
    getWindow().webContents.send('cheat:broken', cheatId)
  })

  ipcMain.handle('process:list', () => nativeAddon.listProcesses())

  ipcMain.handle('process:attach', (_e, pid: number) => {
    const { handle, baseAddress } = nativeAddon.attach(pid)
    attachedHandle = handle
    attachedBase = baseAddress
    return { handle, baseAddress }
  })

  ipcMain.handle('cheats:load', (_e, exeName: string) => loadCheats(exeName))

  ipcMain.handle('cheats:save', (_e, exeName: string, cheat: CheatDefinition) => {
    saveCheat(exeName, cheat)
  })

  ipcMain.handle('cheats:delete', (_e, exeName: string, cheatId: string) => {
    freezeLoop.disable(cheatId)
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
}

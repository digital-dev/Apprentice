import { ipcMain, BrowserWindow } from 'electron'
import { nativeAddon } from './nativeAddon'
import { loadCheats, saveCheat, CheatDefinition } from './store'
import { FreezeLoop } from './freezeLoop'

let attachedHandle: number | null = null
let attachedBase: string | null = null

// The native addon's readValue/writeValue walk a single combined offsets
// array as: addr = base; for each offset: addr += offset; dereference
// unless it's the last one. resolvePointerChain returns that combined
// array under `offsets`. The CheatDefinition store schema splits that
// array into `baseOffset` (first element) and `offsets` (the remainder),
// so it must be recombined before being passed to the native addon.
function fullOffsets(cheat: CheatDefinition): string[] {
  return [cheat.baseOffset, ...cheat.offsets]
}

const freezeLoop = new FreezeLoop((cheat) => {
  if (attachedHandle === null || attachedBase === null) return false
  return nativeAddon.writeValue(attachedHandle, attachedBase, fullOffsets(cheat), cheat.dataType, cheat.value)
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

  ipcMain.handle('cheats:toggleFreeze', (_e, cheat: CheatDefinition, enabled: boolean) => {
    if (enabled) freezeLoop.enable(cheat)
    else freezeLoop.disable(cheat.id)
  })

  ipcMain.handle('cheats:oneShot', (_e, cheat: CheatDefinition) => {
    if (attachedHandle === null || attachedBase === null) return false
    return nativeAddon.writeValue(attachedHandle, attachedBase, fullOffsets(cheat), cheat.dataType, cheat.value)
  })

  ipcMain.handle('scan:first', (_e, dataType: string, value: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.scanFirst(attachedHandle, dataType, value)
  })

  ipcMain.handle('scan:next', (_e, addresses: string[], dataType: string, filter: unknown) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.scanNext(attachedHandle, addresses, dataType, filter as never)
  })

  ipcMain.handle('scan:resolveChain', (_e, target: string, maxLevels: number) => {
    if (attachedHandle === null || attachedBase === null) throw new Error('not attached')
    return nativeAddon.resolvePointerChain(attachedHandle, attachedBase, target, maxLevels)
  })
}

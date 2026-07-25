import { contextBridge, ipcRenderer } from 'electron'
import type { CheatDefinition } from '../main/store'

contextBridge.exposeInMainWorld('tamper', {
  listProcesses: () => ipcRenderer.invoke('process:list'),
  attach: (pid: number) => ipcRenderer.invoke('process:attach', pid),
  loadCheats: (exeName: string) => ipcRenderer.invoke('cheats:load', exeName),
  saveCheat: (exeName: string, cheat: CheatDefinition) =>
    ipcRenderer.invoke('cheats:save', exeName, cheat),
  toggleFreeze: (cheat: CheatDefinition, enabled: boolean) =>
    ipcRenderer.invoke('cheats:toggleFreeze', cheat, enabled),
  oneShot: (cheat: CheatDefinition) => ipcRenderer.invoke('cheats:oneShot', cheat),
  scanFirst: (dataType: string, value: number) => ipcRenderer.invoke('scan:first', dataType, value),
  scanNext: (candidates: unknown[], dataType: string, filter: unknown) =>
    ipcRenderer.invoke('scan:next', candidates, dataType, filter),
  resolveChain: (target: string, maxLevels: number) =>
    ipcRenderer.invoke('scan:resolveChain', target, maxLevels),
  onCheatBroken: (cb: (cheatId: string) => void) =>
    ipcRenderer.on('cheat:broken', (_e, cheatId) => cb(cheatId))
})

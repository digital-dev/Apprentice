import { contextBridge, ipcRenderer } from 'electron'
import type { CheatDefinition, StoredCheat, PatchCheat } from '../main/store'

contextBridge.exposeInMainWorld('tamper', {
  listProcesses: () => ipcRenderer.invoke('process:list'),
  attach: (pid: number) => ipcRenderer.invoke('process:attach', pid),
  loadCheats: (exeName: string) => ipcRenderer.invoke('cheats:load', exeName),
  saveCheat: (exeName: string, cheat: StoredCheat) =>
    ipcRenderer.invoke('cheats:save', exeName, cheat),
  deleteCheat: (exeName: string, cheatId: string) =>
    ipcRenderer.invoke('cheats:delete', exeName, cheatId),
  toggleFreeze: (cheat: CheatDefinition, enabled: boolean) =>
    ipcRenderer.invoke('cheats:toggleFreeze', cheat, enabled),
  oneShot: (cheat: CheatDefinition) => ipcRenderer.invoke('cheats:oneShot', cheat),
  verifyCheat: (cheat: CheatDefinition, expectedValue: number | null) =>
    ipcRenderer.invoke('cheats:verify', cheat, expectedValue),
  scanFirst: (dataType: string, value: number) => ipcRenderer.invoke('scan:first', dataType, value),
  scanNext: (candidates: unknown[], dataType: string, filter: unknown) =>
    ipcRenderer.invoke('scan:next', candidates, dataType, filter),
  resolveChain: (target: string, maxLevels: number) =>
    ipcRenderer.invoke('scan:resolveChain', target, maxLevels),
  onCheatBroken: (cb: (cheatId: string) => void) =>
    ipcRenderer.on('cheat:broken', (_e, cheatId) => cb(cheatId)),
  onCheatRecovered: (cb: (cheatId: string) => void) =>
    ipcRenderer.on('cheat:recovered', (_e, cheatId) => cb(cheatId)),
  startWriteWatch: (address: string) => ipcRenderer.invoke('writeWatch:start', address),
  pollWriteWatch: () => ipcRenderer.invoke('writeWatch:poll'),
  stopWriteWatch: () => ipcRenderer.invoke('writeWatch:stop'),
  locatePatch: (patch: PatchCheat) => ipcRenderer.invoke('patch:locate', patch),
  applyPatch: (patch: PatchCheat) => ipcRenderer.invoke('patch:apply', patch),
  restorePatch: (patch: PatchCheat) => ipcRenderer.invoke('patch:restore', patch),
  // What a capture patch has recorded so far: its slot, and the pointer in
  // it (null until the game runs the captured instruction).
  patchSlot: (patchId: string) => ipcRenderer.invoke('patch:slot', patchId),
  onCheatState: (cb: (payload: { cheatId: string; status: unknown }) => void) =>
    ipcRenderer.on('cheat:state', (_e, payload) => cb(payload)),
  onGameState: (cb: (payload: { exe: string | null; pid: number | null; changedModules: string[] }) => void) =>
    ipcRenderer.on('game:state', (_e, payload) => cb(payload)),
  currentGame: () => ipcRenderer.invoke('game:current')
})

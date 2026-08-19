import { contextBridge, ipcRenderer } from 'electron'
import type { CheatDefinition, StoredCheat, PatchCheat, ScriptCheat, CheatTarget } from '../main/store'
import type { CtSearchResult } from '../main/ctSource'

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
  runScript: (source: string, stateIn: Record<string, string | number | boolean>) =>
    ipcRenderer.invoke('scripts:run', source, stateIn),
  toggleScript: (cheat: ScriptCheat, enabled: boolean) =>
    ipcRenderer.invoke('scripts:toggle', cheat, enabled),
  isScriptEnabled: (cheatId: string) => ipcRenderer.invoke('scripts:isEnabled', cheatId),
  readMemoryBlock: (address: string, length: number) =>
    ipcRenderer.invoke('memory:readBlock', address, length),
  writeMemoryByte: (address: string, value: number) =>
    ipcRenderer.invoke('memory:writeByte', address, value),
  disassemble: (buffer: ArrayBuffer, baseAddress: string, maxCount?: number) =>
    ipcRenderer.invoke('memory:disassemble', Buffer.from(buffer), baseAddress, maxCount),
  resolveTargetAddress: (moduleName: string, baseOffset: string) =>
    ipcRenderer.invoke('memory:resolveTargetAddress', moduleName, baseOffset),
  listThreads: () => ipcRenderer.invoke('threads:list'),
  getThreadRegisters: (tid: number) => ipcRenderer.invoke('threads:registers', tid),
  resolveCheatTargetAddress: (target: CheatTarget) =>
    ipcRenderer.invoke('cheats:resolveTargetAddress', target),
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
  currentGame: () => ipcRenderer.invoke('game:current'),
  monoResolveClass: (namespaceName: string, className: string) =>
    ipcRenderer.invoke('mono:resolveClass', namespaceName, className),
  monoListFields: (classHandle: string) => ipcRenderer.invoke('mono:listFields', classHandle),
  monoListMethods: (classHandle: string) => ipcRenderer.invoke('mono:listMethods', classHandle),
  monoResolvePlayerPointer: (className: string, fieldName: string, instanceFieldName?: string) =>
    ipcRenderer.invoke('mono:resolvePlayerPointer', className, fieldName, instanceFieldName),
  monoListAssemblyNames: () => ipcRenderer.invoke('mono:listAssemblyNames'),
  monoListClassesInImage: (imageHandle: string) =>
    ipcRenderer.invoke('mono:listClassesInImage', imageHandle),
  monoClassLocations: (className: string) => ipcRenderer.invoke('mono:classLocations', className),
  monoResolveMethodBytes: (className: string, methodName: string, length: number) =>
    ipcRenderer.invoke('mono:resolveMethodBytes', className, methodName, length),
  monoReadLiveValue: (className: string, staticFieldName: string, instanceFieldName?: string) =>
    ipcRenderer.invoke('mono:readLiveValue', className, staticFieldName, instanceFieldName),
  importCheatTable: (exeName: string) => ipcRenderer.invoke('ct:import', exeName),
  exportCheatTable: (exeName: string) => ipcRenderer.invoke('ct:export', exeName),
  searchCtTables: (gameName: string) => ipcRenderer.invoke('ctSource:search', gameName),
  fetchCtTable: (exeName: string, result: CtSearchResult) =>
    ipcRenderer.invoke('ctSource:fetch', exeName, result),
  onHotkeyFired: (
    cb: (payload: { cheatId: string; outcome: 'on' | 'off' | 'applied' | 'error'; error?: string }) => void
  ) => {
    const handler = (
      _e: unknown,
      payload: { cheatId: string; outcome: 'on' | 'off' | 'applied' | 'error'; error?: string }
    ) => cb(payload)
    ipcRenderer.on('hotkey:fired', handler)
    return () => ipcRenderer.removeListener('hotkey:fired', handler)
  },
  onHotkeyConflict: (cb: (failed: { name: string; hotkey: string }[]) => void) => {
    const handler = (_e: unknown, failed: { name: string; hotkey: string }[]) => cb(failed)
    ipcRenderer.on('hotkey:conflict', handler)
    return () => ipcRenderer.removeListener('hotkey:conflict', handler)
  },
  getHotkeyConflicts: () => ipcRenderer.invoke('hotkeys:conflicts')
})

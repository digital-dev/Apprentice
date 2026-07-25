import type { CheatDefinition } from '../../main/store'

export {}

declare global {
  interface Window {
    tamper: {
      listProcesses: () => Promise<{ pid: number; name: string }[]>
      attach: (pid: number) => Promise<{ handle: number; baseAddress: string }>
      loadCheats: (exeName: string) => Promise<CheatDefinition[]>
      saveCheat: (exeName: string, cheat: CheatDefinition) => Promise<void>
      toggleFreeze: (cheat: CheatDefinition, enabled: boolean) => Promise<void>
      oneShot: (cheat: CheatDefinition) => Promise<boolean>
      scanFirst: (dataType: string, value: number) => Promise<string[]>
      scanNext: (addresses: string[], dataType: string, filter: unknown) => Promise<string[]>
      resolveChain: (target: string, maxLevels: number) => Promise<{ offsets: string[] } | null>
      // void return is intentional—idiomatic for event listeners; underlying IpcRenderer.on() return is not used
      onCheatBroken: (cb: (cheatId: string) => void) => void
    }
  }
}

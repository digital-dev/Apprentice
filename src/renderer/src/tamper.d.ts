import type { CheatDefinition } from '../../main/store'

export {}

export interface Candidate {
  address: string
  value: number
}

declare global {
  interface Window {
    tamper: {
      listProcesses: () => Promise<{ pid: number; name: string }[]>
      attach: (pid: number) => Promise<{ handle: number; baseAddress: string }>
      loadCheats: (exeName: string) => Promise<CheatDefinition[]>
      saveCheat: (exeName: string, cheat: CheatDefinition) => Promise<void>
      toggleFreeze: (cheat: CheatDefinition, enabled: boolean) => Promise<void>
      oneShot: (cheat: CheatDefinition) => Promise<boolean>
      scanFirst: (dataType: string, value: number) => Promise<Candidate[]>
      scanNext: (candidates: Candidate[], dataType: string, filter: unknown) => Promise<Candidate[]>
      resolveChain: (
        target: string,
        maxLevels: number
      ) => Promise<{ moduleName: string; offsets: string[] } | null>
      // void return is intentional—idiomatic for event listeners; underlying IpcRenderer.on() return is not used
      onCheatBroken: (cb: (cheatId: string) => void) => void
    }
  }
}

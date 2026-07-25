import type { CheatDefinition, StoredCheat, PatchCheat } from '../../main/store'

export {}

export type PatchState = 'original' | 'applied' | 'not-found' | 'mismatch'

export interface PatchStatus {
  address: string | null
  state: PatchState
  applicable: boolean
}

export interface Candidate {
  address: string
  value: number
}

export interface TargetStatus {
  alive: boolean
  value: number | null
}

export interface CaughtInstruction {
  instructionAddress: string
  bytes: string
  length: number
  signature: string
  baseRegister: string
  displacement: string
  baseAddress: string
  moduleName: string | null
  moduleOffset: string | null
}

declare global {
  interface Window {
    tamper: {
      listProcesses: () => Promise<{ pid: number; name: string }[]>
      attach: (pid: number) => Promise<{ handle: number; baseAddress: string }>
      loadCheats: (exeName: string) => Promise<StoredCheat[]>
      saveCheat: (exeName: string, cheat: StoredCheat) => Promise<void>
      deleteCheat: (exeName: string, cheatId: string) => Promise<void>
      toggleFreeze: (cheat: CheatDefinition, enabled: boolean) => Promise<void>
      oneShot: (cheat: CheatDefinition) => Promise<boolean>
      verifyCheat: (
        cheat: CheatDefinition,
        expectedValue: number | null
      ) => Promise<TargetStatus[]>
      scanFirst: (dataType: string, value: number) => Promise<Candidate[]>
      scanNext: (candidates: Candidate[], dataType: string, filter: unknown) => Promise<Candidate[]>
      resolveChain: (
        target: string,
        maxLevels: number
      ) => Promise<{ moduleName: string; offsets: string[] } | null>
      // void return is intentional—idiomatic for event listeners; underlying IpcRenderer.on() return is not used
      onCheatBroken: (cb: (cheatId: string) => void) => void
      onCheatRecovered: (cb: (cheatId: string) => void) => void
      startWriteWatch: (address: string) => Promise<void>
      pollWriteWatch: () => Promise<CaughtInstruction[]>
      stopWriteWatch: () => Promise<CaughtInstruction[]>
      locatePatch: (patch: PatchCheat) => Promise<PatchStatus>
      applyPatch: (patch: PatchCheat) => Promise<{ ok: boolean; error: string | null }>
      restorePatch: (patch: PatchCheat) => Promise<boolean>
    }
  }
}

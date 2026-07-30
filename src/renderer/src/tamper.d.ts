import type { CheatDefinition, StoredCheat, PatchCheat } from '../../main/store'

export {}

// Re-exported from the engine rather than re-declared: these travel over IPC
// unchanged, and a second copy of the shape drifts from the one the engine
// actually produces. This is a type-only import, so nothing from the main
// process ends up in the renderer bundle.
export type { PatchState, PatchStatus } from '../../main/patchEngine'
export type { CheatState, CheatStatus } from '../../main/cheatRuntime'

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
  // Bytes of the signature that precede this instruction — the pattern
  // covers surrounding method code, so a match is at instruction - this.
  signatureOffset: number
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
      // What a capture patch has recorded. null when it isn't a capture
      // patch, isn't installed, or the game hasn't run the instruction yet.
      patchSlot: (
        patchId: string
      ) => Promise<{ slot: string; pointer: string | null } | null>
      // void return is intentional—idiomatic for event listeners; underlying IpcRenderer.on() return is not used
      onCheatState: (cb: (payload: { cheatId: string; status: CheatStatus }) => void) => void
      onGameState: (
        cb: (payload: { exe: string | null; pid: number | null; changedModules: string[] }) => void
      ) => void
      currentGame: () => Promise<{ exe: string | null; pid: number | null; changedModules: string[] }>
    }
  }
}

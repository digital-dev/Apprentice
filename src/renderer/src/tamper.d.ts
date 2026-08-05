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
      // Mono Explorer's read side. Resolve returns a class handle (an
      // opaque address, encoded as a hex string) or null when the class
      // isn't loaded yet / the runtime isn't attached; the two list calls
      // resolve to [] on the same conditions.
      monoResolveClass: (namespaceName: string, className: string) => Promise<string | null>
      monoListFields: (classHandle: string) => Promise<string[]>
      monoListMethods: (classHandle: string) => Promise<string[]>
      // Resolves a live object pointer from a named class's static field —
      // e.g. ('Player', 'm_localPlayer') — for an immune patch's armValue.
      // With instanceFieldName set, follows one more instance field on that
      // SAME class to a second object (Player.m_localPlayer -> .m_skills),
      // for an armValue that isn't the player itself but something the
      // player owns. Null if the runtime isn't attached, either field isn't
      // found, or either hop's pointer hasn't been set yet this session.
      monoResolvePlayerPointer: (
        className: string,
        fieldName: string,
        instanceFieldName?: string
      ) => Promise<string | null>
      // Every loaded assembly's image handle paired with a human-readable
      // name (e.g. "assembly_valheim") — for a picker, instead of the
      // opaque handle-only list monoListAssemblies (unused directly by the
      // UI) would give.
      monoListAssemblyNames: () => Promise<{ image: string; name: string }[]>
      // Every (namespace, className) pair in the given image — walks the
      // assembly's own TypeDef metadata table, not a cached/precomputed
      // list, so it reflects whatever the runtime actually has loaded.
      monoListClassesInImage: (
        imageHandle: string
      ) => Promise<{ namespaceName: string; className: string }[]>
      // Reads `length` bytes from the method's CURRENT live entry address,
      // for auto-filling a Mono-anchored patch's originalBytes/length
      // instead of requiring an external disassembler. Null on the same
      // conditions monoResolveClass returns null for, or if the method
      // hasn't been JIT-compiled yet and can't be forced to (see
      // monoResolver.compileMethod's safety-rule comment).
      monoResolveMethodBytes: (
        className: string,
        methodName: string,
        length: number
      ) => Promise<{ bytes: string; length: number } | null>
      // Opens a native file picker for a .CT file and imports every
      // recognizable entry as a force-mode patch, saving them immediately.
      // Null if the user cancelled the file picker; otherwise a summary of
      // what was imported and what was skipped (with why).
      importCheatTable: (
        exeName: string
      ) => Promise<{ importedNames: string[]; skipped: { description: string; reason: string }[] } | null>
    }
  }
}

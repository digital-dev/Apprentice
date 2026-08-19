import type { CheatDefinition, StoredCheat, PatchCheat, ScriptCheat, CheatTarget } from '../../main/store'
import type { CtSearchResult } from '../../main/ctSource'

export {}

// Re-exported from the engine rather than re-declared: these travel over IPC
// unchanged, and a second copy of the shape drifts from the one the engine
// actually produces. This is a type-only import, so nothing from the main
// process ends up in the renderer bundle.
export type { PatchState, PatchStatus } from '../../main/patchEngine'
export type { CheatState, CheatStatus } from '../../main/cheatRuntime'
export type { DisasmRow } from '../../main/nativeAddon'

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
      // Runs `source` as a one-shot Lua chunk against the attached
      // process — used only by ScriptEditor's ad-hoc "Run enable/disable
      // now" test buttons, against a throwaway state (the script may not
      // even be saved yet). A saved script cheat's real enable/disable
      // goes through toggleScript below instead, so its `state` handoff
      // and enabled-flag stay correct regardless of whether it was last
      // toggled by a click or a hotkey. Throws 'not attached'.
      runScript: (
        source: string,
        stateIn: Record<string, string | number | boolean>
      ) => Promise<{
        success: boolean
        output: string[]
        error: string | null
        stateOut: Record<string, string | number | boolean>
      }>
      // The real, state-tracked toggle for a saved script cheat — routes
      // through ScriptRuntime (main/scriptRuntime.ts) exactly like a
      // hotkey firing this same cheat does.
      toggleScript: (cheat: ScriptCheat, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
      // Current ScriptRuntime-tracked enabled state for a script cheat —
      // pulled on CheatList mount to initialize each checkbox correctly
      // (mirrors getHotkeyConflicts' pull-based pattern above, for the
      // same reason: ScriptRuntime's state can already reflect a hotkey
      // fire that happened before this screen mounted).
      isScriptEnabled: (cheatId: string) => Promise<boolean>
      // Fetches up to 4096 raw bytes starting at `address` from the attached
      // process, for the memory viewer. null when the read fails outright
      // (unmapped, wrong permissions) — the caller shows the page as
      // unreadable rather than treating this as an error.
      //
      // Declared as Uint8Array, not ArrayBuffer: structured-clone over
      // Electron IPC delivers the main process's Node Buffer to the
      // renderer as a Uint8Array view (typically over its own freshly
      // allocated backing buffer, but that is not a contract this type may
      // rely on) — never a real, zero-offset ArrayBuffer. A caller that
      // needs a genuine ArrayBuffer (e.g. dissect.ts's decodeAt, via
      // `new DataView`) must normalize explicitly — see MemoryViewer.tsx's
      // toArrayBuffer helper — rather than assume this is already one.
      readMemoryBlock: (address: string, length: number) => Promise<Uint8Array | null>
      // Writes a single unsigned byte (0-255) at `address` — the memory
      // viewer's inline byte editor.
      writeMemoryByte: (address: string, value: number) => Promise<boolean>
      // Decodes a block already fetched via readMemoryBlock into x86-64
      // instruction rows (Zydis, Intel syntax) — no address/process args
      // beyond what's needed to label each row, since it never reads memory
      // itself. maxCount bounds how many instructions to decode (default 200
      // on the main-process side).
      disassemble: (
        buffer: ArrayBuffer,
        baseAddress: string,
        maxCount?: number
      ) => Promise<DisasmRow[]>
      // Resolves a ChainTarget's absolute address (moduleBase + baseOffset)
      // for the "View in Memory" button — only valid for a target with no
      // remaining offsets (offsets.length === 0), where baseOffset is the
      // last/only element of the chain and needs no dereference. null when
      // not attached or the module isn't loaded. baseOffset is
      // module-relative, never an address to navigate to directly.
      resolveTargetAddress: (moduleName: string, baseOffset: string) => Promise<string | null>
      // Every thread belonging to the attached process, for the Registers
      // panel's thread picker. [] when nothing is attached.
      listThreads: () => Promise<{ tid: number }[]>
      // One thread's live registers (rax..r15, rip, rsp, rbp, rflags),
      // each an 0x-prefixed hex string. null when nothing is attached or
      // the thread has already exited.
      getThreadRegisters: (tid: number) => Promise<Record<string, string> | null>
      // General counterpart for a saved value cheat's own CheatTarget —
      // handles all three target shapes (anchor, mono, module+offsets
      // chain), unlike resolveTargetAddress above which only covers the
      // simplest module+baseOffset case. Used by CheatList's "View in
      // Memory" menu item. null when not attached or the target doesn't
      // currently resolve (module not loaded, chain broken, etc).
      resolveCheatTargetAddress: (target: CheatTarget) => Promise<string | null>
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
      // Every (namespace, className) pair in the given image, WITH each
      // class's own resolved handle — walks the assembly's own TypeDef
      // metadata table (not a cached/precomputed list, so it reflects
      // whatever the runtime actually has loaded), and returns the handle
      // that same walk already produced per class. Use classHandle directly
      // (monoListFields/monoListMethods take it) instead of a second,
      // separate monoResolveClass(namespaceName, className) call — a
      // name-only resolve is ambiguous across every loaded assembly (see
      // monoClassLocations below), but a class picked from THIS list is
      // already known to be the one in THIS specific assembly.
      monoListClassesInImage: (
        imageHandle: string
      ) => Promise<{ namespaceName: string; className: string; classHandle: string }[]>
      // Every assembly that defines a class with this exact name (namespace
      // ignored). A name-only resolve (monoResolveClass with an empty
      // namespace) silently picks whichever loaded assembly's match comes
      // first — a real game can load dozens of assemblies, and a common
      // name like "Player" can exist in more than one of them. Call this
      // right after a resolve succeeds and warn if it returns more than one
      // name — that's the only way to tell "resolved the class you meant"
      // from "resolved A class with that name, silently, maybe the wrong
      // one" before building a whole cheat around it. Empty array if the
      // runtime isn't attached or nothing matches.
      monoClassLocations: (className: string) => Promise<string[]>
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
      // Reads the CURRENT value at a Mono-resolved field, decoded as both
      // int32 and float (Explorer doesn't know the field's real type ahead
      // of time) — for watching a field change live while playing, to
      // recognize which one it is. Same static/instance-field shape as a
      // MonoTarget value cheat (see store.ts's MonoTarget). Null if the
      // runtime isn't attached or either field doesn't resolve.
      monoReadLiveValue: (
        className: string,
        staticFieldName: string,
        instanceFieldName?: string
      ) => Promise<{ raw: string; int32: number; float: number } | null>
      // Opens a native file picker for a .CT file and imports every
      // recognizable entry as a force-mode patch, saving them immediately.
      // Null if the user cancelled the file picker; otherwise a summary of
      // what was imported and what was skipped (with why).
      importCheatTable: (
        exeName: string
      ) => Promise<{ importedNames: string[]; skipped: { description: string; reason: string }[] } | null>
      // Opens a native save dialog and writes every 'force'-mode patch out
      // as a Cheat Engine .CT table. Null if the user cancelled the save
      // dialog; otherwise a summary of what was exported and what was
      // skipped (with why) — see ctExport.ts.
      exportCheatTable: (
        exeName: string
      ) => Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null>
      // Searches the curated GitHub CT-table repos for a game name. `error`
      // is set (results empty) on a network/rate-limit failure — the UI
      // shows it rather than throwing.
      searchCtTables: (gameName: string) => Promise<{ results: CtSearchResult[]; error: string | null }>
      // Fetches and imports one search result, saving immediately —
      // mirrors importCheatTable's own convention. Returns an { error }
      // shape on fetch failure instead of the usual import summary.
      fetchCtTable: (
        exeName: string,
        result: CtSearchResult
      ) => Promise<
        | { importedNames: string[]; skipped: { description: string; reason: string }[] }
        | { error: string }
      >
      // Fired whenever a global hotkey toggles/applies a cheat — the
      // trainer window won't be focused when this happens (the game is),
      // so this is how the renderer learns to update its own on/off state
      // and play the matching sound cue. See hotkeys.ts. Returns a disposer
      // that removes exactly this listener — CheatList unmounts/remounts on
      // every visit, so a caller must clean up on unmount or listeners
      // stack across visits (each firing its own sound on every press).
      onHotkeyFired: (
        cb: (payload: {
          cheatId: string
          outcome: 'on' | 'off' | 'applied' | 'error'
          error?: string
        }) => void
      ) => () => void
      // Fired once per registerAll() call that had at least one hotkey
      // Electron's globalShortcut refused to register (already owned by
      // another running app). Returns a disposer — see onHotkeyFired.
      onHotkeyConflict: (cb: (failed: { name: string; hotkey: string }[]) => void) => () => void
      // Pull-based counterpart to onHotkeyConflict: the conflicts from the
      // most recent registerAll() call, for a caller that starts existing
      // after registerAll already ran (e.g. this screen mounting after
      // process:attach's synchronous registerAll).
      getHotkeyConflicts: () => Promise<{ name: string; hotkey: string }[]>
    }
  }
}

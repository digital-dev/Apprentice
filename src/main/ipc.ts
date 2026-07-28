import { ipcMain, BrowserWindow } from 'electron'
import { nativeAddon, Candidate } from './nativeAddon'
import {
  loadCheats,
  saveCheat,
  deleteCheat,
  CheatDefinition,
  ChainTarget,
  AnchorTarget,
  isAnchorTarget,
  StoredCheat,
  PatchCheat,
  patchMode
} from './store'
import { PatchEngine, PatchOps } from './patchEngine'
import { FreezeLoop } from './freezeLoop'

let attachedHandle: number | null = null
let attachedBase: string | null = null
let attachedPid: number | null = null

// The native addon's readValue/writeValue walk a single combined offsets
// array as: addr = base; for each offset: addr += offset; dereference
// unless it's the last one. Each target's schema splits that array into
// `baseOffset` (first element) and `offsets` (the remainder), so it must
// be recombined before being passed to the native addon.
function fullOffsets(target: ChainTarget): string[] {
  return [target.baseOffset, ...target.offsets]
}

// The slot holds a raw little-endian pointer: byte 0 is the least
// significant byte. Reading the unspaced hex blob as-is would parse it
// big-endian and produce a plausible-looking but wrong address, so the byte
// pairs are reversed before parsing.
export function littleEndianToBigInt(hex: string): bigint {
  let reversed = ''
  for (let i = hex.length - 2; i >= 0; i -= 2) {
    reversed += hex.slice(i, i + 2)
  }
  return BigInt('0x' + reversed)
}

// An anchored target resolves in two reads: the captured pointer, then the
// field. A slot that still reads zero means the game has not executed the
// captured instruction yet this session, which is a not-live target rather
// than an error — the same state a stale chain produces.
function resolveAnchor(handle: number, target: AnchorTarget): string | null {
  const slot = patchEngine.slotAddress(target.patchId)
  if (slot === null) {
    // No breadcrumb here: this is the routine case for any anchor target
    // whose capture patch isn't currently installed, not a fault.
    return null
  }
  const pointerHex = nativeAddon.tryReadBytes(handle, slot, 8)
  if (pointerHex === null) {
    // Distinguish this from the other two null returns below — this one
    // means the slot address itself couldn't be read (e.g. the cave went
    // away), which is worth knowing when debugging live against a game.
    console.warn(`[patch] anchor ${target.patchId}: slot ${slot} unreadable`)
    return null
  }
  const pointer = littleEndianToBigInt(pointerHex)
  if (pointer === 0n) {
    // No breadcrumb here: this is the expected transient state on every
    // tick until the game executes the captured instruction, not a fault —
    // logging it here would spam the console at freeze-loop cadence.
    return null
  }
  return '0x' + (pointer + BigInt(target.offset)).toString(16)
}

// A cheat writes to every one of its targets on each call, not just the
// first. Naive memory scanning sometimes resolves a chain that only looks
// static and stops working after a few seconds even though other
// candidates from the same scan keep resolving correctly — writing to all
// selected targets and succeeding if ANY of them do makes the cheat
// resilient to any single target going stale, rather than the whole cheat
// flipping to broken the moment its one chain does.
//
// Each target can be anchored to a different module (see
// resolvePointerChain's moduleName), not necessarily the module attach()
// happened to report first — so each target's base must be looked up by
// name, fresh, rather than reusing the single attachedBase captured at
// attach time.
function writeCheat(handle: number, cheat: CheatDefinition): boolean {
  let anySucceeded = false
  for (const target of cheat.targets) {
    if (isAnchorTarget(target)) {
      const resolved = resolveAnchor(handle, target)
      if (resolved === null) continue
      const ok = nativeAddon.writeValue(handle, resolved, [], cheat.dataType, cheat.value)
      if (ok) anySucceeded = true
      continue
    }
    const moduleBase = nativeAddon.getModuleBase(handle, target.moduleName)
    if (moduleBase === null) continue
    const ok = nativeAddon.writeValue(
      handle,
      moduleBase,
      fullOffsets(target),
      cheat.dataType,
      cheat.value
    )
    if (ok) anySucceeded = true
  }
  return anySucceeded
}

// Per-target liveness for revalidation: alive means the target's module is
// loaded and its chain resolves to readable memory (optionally holding the
// expected value). `value` is what the target currently reads, or null if
// it doesn't resolve.
export interface TargetStatus {
  alive: boolean
  value: number | null
}

// The user-facing value they read off a rounded in-game display won't
// exactly equal the underlying float, so float verification tolerates a
// small window; ints are matched exactly.
function valueMatches(read: number, expected: number, dataType: string): boolean {
  if (dataType === 'float') return Math.abs(read - expected) < 1.0
  return read === expected
}

function verifyCheat(
  handle: number,
  cheat: CheatDefinition,
  expectedValue: number | null
): TargetStatus[] {
  return cheat.targets.map((target) => {
    if (isAnchorTarget(target)) {
      const resolved = resolveAnchor(handle, target)
      if (resolved === null) return { alive: false, value: null }
      const value = nativeAddon.tryReadValue(handle, resolved, [], cheat.dataType)
      if (value === null) return { alive: false, value: null }
      const alive = expectedValue === null ? true : valueMatches(value, expectedValue, cheat.dataType)
      return { alive, value }
    }
    const moduleBase = nativeAddon.getModuleBase(handle, target.moduleName)
    if (moduleBase === null) return { alive: false, value: null }
    const value = nativeAddon.tryReadValue(
      handle,
      moduleBase,
      fullOffsets(target),
      cheat.dataType
    )
    if (value === null) return { alive: false, value: null }
    const alive = expectedValue === null ? true : valueMatches(value, expectedValue, cheat.dataType)
    return { alive, value }
  })
}

const freezeLoop = new FreezeLoop((cheat) => {
  if (attachedHandle === null) return false
  return writeCheat(attachedHandle, cheat)
})
freezeLoop.start()

// The engine's view of the target process. Each call reads the CURRENT
// attachedHandle rather than capturing one, so the engine keeps working
// across a re-attach without being rebuilt. Reads are the non-throwing
// form: "can't read there" is an expected outcome for a patch whose code
// has moved, not an error.
const patchOps: PatchOps = {
  getModuleBase: (moduleName) =>
    attachedHandle === null ? null : nativeAddon.getModuleBase(attachedHandle, moduleName),
  readBytes: (address, length) =>
    attachedHandle === null ? null : nativeAddon.tryReadBytes(attachedHandle, address, length),
  writeBytes: (address, hexBytes) =>
    attachedHandle === null ? false : nativeAddon.writeBytes(attachedHandle, address, hexBytes),
  scanAob: async (signature) =>
    attachedHandle === null ? [] : nativeAddon.scanAob(attachedHandle, signature),
  allocateCave: (nearAddress) =>
    attachedHandle === null ? null : nativeAddon.allocateCave(attachedHandle, nearAddress),
  decodeRun: (address, minBytes) => {
    if (attachedHandle === null)
      return { length: 0, decodable: false, relocatable: false, clobbers: [] }
    return nativeAddon.decodeRun(attachedHandle, address, minBytes)
  },
  encodeStore: (baseRegister, offset, imm32) => nativeAddon.encodeStore(baseRegister, offset, imm32),
  encodeCaptureOnce: (baseRegister, atAddress, slotAddress) =>
    nativeAddon.encodeCaptureOnce(baseRegister, atAddress, slotAddress),
  encodeJump: (from, to) => nativeAddon.encodeJump(from, to),
  // The native call throws on failure (after resuming whatever it already
  // suspended) rather than returning false — PatchOps promises a plain
  // boolean, so catch here rather than let it escape as a rejected promise
  // out of PatchEngine.apply.
  suspendThreads: () => {
    if (attachedHandle === null || attachedPid === null) return false
    try {
      return nativeAddon.suspendThreads(attachedHandle, attachedPid)
    } catch {
      return false
    }
  },
  resumeThreads: () => nativeAddon.resumeThreads()
}

const patchEngine = new PatchEngine(patchOps)

// A Linux build loads and runs — scanning and value cheats work through the
// existing Win32-free paths — but injection has no backend there yet. Say so
// plainly at the point of use rather than letting a cave allocation return
// null and surfacing as "no memory available near the instruction".
const platformSupportsInjection = nativeAddon.platformName().supported

// Called on app quit (from index.ts) so Tamper never leaves a game's code
// modified after it closes.
export function restoreAllPatches(): void {
  patchEngine.restoreAll()
}

// Everything that must happen before Tamper stops existing, in this order.
//
// Stopping the capture is not optional politeness: an armed write-watch has
// a hardware breakpoint (Dr0/Dr7) set on every thread of the target. Those
// live in the threads' contexts, and detaching the debugger does not clear
// them — so a Tamper that exits mid-capture leaves the game primed to raise
// a debug exception with no debugger attached to handle it, and Windows
// kills the game. Quitting used to restore patches but never stop the
// capture, which is exactly how closing Tamper took Valheim down with it.
//
// Patches are restored second, while the process handle is still valid.
export function releaseTarget(): void {
  try {
    nativeAddon.stopWriteWatch() // clears the breakpoints, then detaches
  } catch {
    // No session, or the target is already gone — nothing to disarm.
  }
  patchEngine.restoreAll()
}

export function registerIpcHandlers(getWindow: () => BrowserWindow): void {
  freezeLoop.onDegraded((cheatId) => {
    getWindow().webContents.send('cheat:broken', cheatId)
  })
  freezeLoop.onRecovered((cheatId) => {
    getWindow().webContents.send('cheat:recovered', cheatId)
  })

  ipcMain.handle('process:list', () => nativeAddon.listProcesses())

  ipcMain.handle('process:attach', (_e, pid: number) => {
    // Attaching elsewhere means letting go of the current process — put its
    // code back first, while its handle is still valid.
    if (attachedHandle !== null && attachedPid !== pid) patchEngine.restoreAll()
    const { handle, baseAddress } = nativeAddon.attach(pid)
    attachedHandle = handle
    attachedBase = baseAddress
    attachedPid = pid
    return { handle, baseAddress }
  })

  ipcMain.handle('cheats:load', (_e, exeName: string): StoredCheat[] => loadCheats(exeName))

  ipcMain.handle('cheats:save', (_e, exeName: string, cheat: StoredCheat) => {
    saveCheat(exeName, cheat)
  })

  ipcMain.handle('cheats:delete', (_e, exeName: string, cheatId: string) => {
    freezeLoop.disable(cheatId)
    // A deleted patch must not stay in the game's code — restore it while
    // we still have its recorded address and original bytes.
    if (patchEngine.isApplied(cheatId)) {
      const stored = loadCheats(exeName).find((c) => c.id === cheatId)
      if (stored && stored.kind === 'patch') patchEngine.restore(stored)
    }
    deleteCheat(exeName, cheatId)
  })

  ipcMain.handle('cheats:toggleFreeze', (_e, cheat: CheatDefinition, enabled: boolean) => {
    if (enabled) freezeLoop.enable(cheat)
    else freezeLoop.disable(cheat.id)
  })

  ipcMain.handle('cheats:oneShot', (_e, cheat: CheatDefinition) => {
    if (attachedHandle === null) return false
    return writeCheat(attachedHandle, cheat)
  })

  ipcMain.handle(
    'cheats:verify',
    (_e, cheat: CheatDefinition, expectedValue: number | null): TargetStatus[] => {
      if (attachedHandle === null) throw new Error('not attached')
      return verifyCheat(attachedHandle, cheat, expectedValue)
    }
  )

  ipcMain.handle('scan:first', (_e, dataType: string, value: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.scanFirst(attachedHandle, dataType, value)
  })

  ipcMain.handle('scan:next', (_e, candidates: Candidate[], dataType: string, filter: unknown) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.scanNext(attachedHandle, candidates, dataType, filter as never)
  })

  ipcMain.handle('scan:resolveChain', (_e, target: string, maxLevels: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    return nativeAddon.resolvePointerChain(attachedHandle, target, maxLevels)
  })

  ipcMain.handle('writeWatch:start', (_e, address: string) => {
    if (attachedPid === null) throw new Error('not attached')
    freezeLoop.stop() // pause freezing during a capture
    try {
      nativeAddon.startWriteWatch(attachedPid, address)
    } catch (err) {
      freezeLoop.start() // capture failed to start — don't leave freezing off
      throw err
    }
  })

  ipcMain.handle('writeWatch:poll', () => nativeAddon.pollWriteWatch())

  ipcMain.handle('writeWatch:stop', () => {
    const result = nativeAddon.stopWriteWatch()
    freezeLoop.start() // resume freezing
    return result
  })

  ipcMain.handle('patch:locate', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) throw new Error('not attached')
    return patchEngine.locate(patch)
  })

  ipcMain.handle('patch:apply', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) throw new Error('not attached')
    if (patchMode(patch) !== 'nop' && !platformSupportsInjection) {
      return { ok: false, error: 'Code injection is not supported on this platform yet.' }
    }
    return patchEngine.apply(patch)
  })

  ipcMain.handle('patch:restore', (_e, patch: PatchCheat) => {
    if (attachedHandle === null) return true // process gone; its code went with it
    return patchEngine.restore(patch)
  })

  // What a capture patch has recorded, so the user can see whether it has
  // caught anything and read the address an anchored cheat resolves through.
  // Without this, authoring an anchor means inferring the object's address
  // from two value scans and some subtraction — which is how the last
  // session had to do it.
  //
  // null covers every not-live case alike: not a capture patch, not
  // installed, or installed but the game has not run the instruction yet.
  // A slot reading all zeroes is the last of those and is reported as such
  // rather than as an address, because 0x0 is not somewhere to point a
  // cheat.
  ipcMain.handle('patch:slot', (_e, patchId: string) => {
    if (attachedHandle === null) return null
    const slot = patchEngine.slotAddress(patchId)
    if (slot === null) return null
    const raw = nativeAddon.tryReadBytes(attachedHandle, slot, 8)
    if (raw === null) return null
    const pointer = littleEndianToBigInt(raw)
    return {
      slot,
      pointer: pointer === 0n ? null : '0x' + pointer.toString(16)
    }
  })
}

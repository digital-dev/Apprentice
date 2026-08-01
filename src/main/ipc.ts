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
  isMonoTarget,
  MonoTarget,
  StoredCheat,
  PatchCheat,
  patchMode,
  isPatchCheat
} from './store'
import { PatchEngine, PatchOps } from './patchEngine'
import { FreezeLoop } from './freezeLoop'
import { monoResolver } from './monoResolver'
import { resolveMonoTargetAddress, MonoResolverOps } from './monoTargetResolve'
import {
  loadProfile,
  recordModuleFingerprint,
  verifiedModules,
  fingerprintOf,
  profileFileExists
} from './profile'
import { CheatRuntime } from './cheatRuntime'
import { ProcessWatcher } from './watcher'
import type { LoadedModule, MonoOps } from './anchor'

let attachedHandle: number | null = null
let attachedBase: string | null = null
let attachedPid: number | null = null
// The exe this session is attached to (no .exe suffix — matches profile file
// naming), and what refreshModuleContext worked out about its modules on the
// most recent attach: which are loaded now, and which of the ones cheats in
// this profile depend on no longer match the fingerprint they were captured
// against.
let attachedExe: string | null = null
let loadedModules = new Map<string, LoadedModule>()
let changedModules: string[] = []

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

// Finds mono.dll's (or the embedded-runtime variant's) base among the
// modules refreshModuleContext already recorded for the current attach —
// resolved once per attach, the same way every other module lookup here
// reuses that map rather than re-listing modules per cheat.
function monoDllBase(): string | null {
  const mono = loadedModules.get('mono.dll') ?? loadedModules.get('mono-2.0-bdwgc.dll')
  return mono ? mono.base : null
}

const monoOps: MonoResolverOps = {
  resolveClass: (h, base, ns, cls) => monoResolver.resolveClass(h, base, ns, cls),
  resolveField: (h, base, cls, field) => monoResolver.resolveField(h, base, cls, field),
  staticFieldAddress: (h, base, cls, field) => monoResolver.staticFieldAddress(h, base, cls, field),
  readBytes: (address, length) =>
    attachedHandle === null ? null : nativeAddon.tryReadBytes(attachedHandle, address, length)
}

// Resolves a MonoTarget's live address, or null if it can't right now (Mono
// runtime not loaded, class/field not found, or the object pointer hasn't
// been set yet this session — all routine, not errors). monoResolver's
// underlying native calls are documented to resolve to null on every
// failure rather than reject, but this is defended anyway: writeCheat and
// verifyCheat must never reject (see freezeLoop.ts's WriteFn contract —
// tick() awaits every active cheat's write together via Promise.all, so one
// rejected promise would take every OTHER cheat's result down with it).
async function resolveMonoTarget(handle: number, target: MonoTarget): Promise<string | null> {
  const base = monoDllBase()
  if (base === null) return null
  try {
    return await resolveMonoTargetAddress(target, handle, base, monoOps)
  } catch (err) {
    console.warn(`[mono] target resolution failed: ${String(err)}`)
    return null
  }
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
//
// Async because the Mono branch awaits two resolver round-trips; every
// other branch stays synchronous under the hood and resolves immediately.
async function writeCheat(handle: number, cheat: CheatDefinition): Promise<boolean> {
  let anySucceeded = false
  for (const target of cheat.targets) {
    if (isAnchorTarget(target)) {
      const resolved = resolveAnchor(handle, target)
      if (resolved === null) continue
      const ok = nativeAddon.writeValue(handle, resolved, [], cheat.dataType, cheat.value)
      if (ok) anySucceeded = true
      continue
    }
    if (isMonoTarget(target)) {
      const resolved = await resolveMonoTarget(handle, target)
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

// Async for the same reason writeCheat is: the Mono branch awaits
// resolveMonoTarget. Targets are checked concurrently (Promise.all over an
// async map) rather than one at a time — nothing here depends on one
// target's result to check the next, and this keeps a slow Mono resolve
// from delaying every other target's read, the same reasoning behind
// tick()'s concurrent dispatch in freezeLoop.ts.
async function verifyCheat(
  handle: number,
  cheat: CheatDefinition,
  expectedValue: number | null
): Promise<TargetStatus[]> {
  return Promise.all(
    cheat.targets.map(async (target): Promise<TargetStatus> => {
      if (isAnchorTarget(target)) {
        const resolved = resolveAnchor(handle, target)
        if (resolved === null) return { alive: false, value: null }
        const value = nativeAddon.tryReadValue(handle, resolved, [], cheat.dataType)
        if (value === null) return { alive: false, value: null }
        const alive = expectedValue === null ? true : valueMatches(value, expectedValue, cheat.dataType)
        return { alive, value }
      }
      if (isMonoTarget(target)) {
        const resolved = await resolveMonoTarget(handle, target)
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
  )
}

const freezeLoop = new FreezeLoop(async (cheat) => {
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
  scanAob: async (signature, rangeStart, rangeEnd) =>
    attachedHandle === null
      ? []
      : nativeAddon.scanAob(attachedHandle, signature, rangeStart, rangeEnd),
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
  encodeGuardedSkip: (baseRegister, atAddress, slotAddress, returnAddress) =>
    nativeAddon.encodeGuardedSkip(baseRegister, atAddress, slotAddress, returnAddress),
  encodeImmuneGuard: (playerPointerAddress, argRegister, caveCodeAddress, returnAddress) =>
    nativeAddon.encodeImmuneGuard(playerPointerAddress, argRegister, caveCodeAddress, returnAddress),
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

// The third anchor path: resolve a patch by asking the live Mono runtime
// for a class+method's compiled entry address. Wired once, alongside
// patchEngine's other ops — reads attachedHandle through the closure the
// same way patchOps/monoOps above do, rather than capturing one, so it
// keeps working across a re-attach without being rebuilt.
const monoPatchOps: MonoOps = {
  monoDllBase,
  resolveClass: (base, cls) =>
    attachedHandle === null ? Promise.resolve(null) : monoResolver.resolveClass(attachedHandle, base, '', cls),
  compileMethod: (base, cls, method) =>
    attachedHandle === null ? Promise.resolve(null) : monoResolver.compileMethod(attachedHandle, base, cls, method)
}
patchEngine.setMonoOps(monoPatchOps)

// A Linux build loads and runs — scanning and value cheats work through the
// existing Win32-free paths — but injection has no backend there yet. Say so
// plainly at the point of use rather than letting a cave allocation return
// null and surfacing as "no memory available near the instruction".
const platformSupportsInjection = nativeAddon.platformName().supported

// Everything that must be re-derived when we attach: which modules are
// loaded, and which of the ones this game's cheats depend on still look
// like the build they were captured against.
//
// Keyed lowercase throughout: the OS's reported casing for a module name
// can differ from what's stored in a profile (or from run to run), and
// profile.ts's verifiedModules already treats that as the same module —
// this must match, or a patch's arithmetic path silently stops resolving
// on nothing more than a casing difference. anchor.ts also lowercases at
// its own lookup site rather than trust a caller did this, but everything
// that reaches it should already be normalized.
export function buildModuleContext(
  profile: ReturnType<typeof loadProfile>,
  live: { name: string; base: string; size: number; timestamp: number }[]
): { modules: Map<string, LoadedModule>; verified: Set<string>; changedModules: string[] } {
  const modules = new Map<string, LoadedModule>()
  for (const m of live) {
    modules.set(m.name.toLowerCase(), { name: m.name, base: m.base, size: m.size })
  }
  const verified = new Set(Array.from(verifiedModules(profile, live), (name) => name.toLowerCase()))
  const changedModules = Object.keys(profile.modules)
    .map((name) => name.toLowerCase())
    .filter((name) => !verified.has(name))
  return { modules, verified, changedModules }
}

function refreshModuleContext(exeName: string): void {
  attachedExe = exeName.replace(/\.exe$/i, '')
  loadedModules = new Map()
  changedModules = []
  if (attachedHandle === null) return

  const live = nativeAddon.listModules(attachedHandle)
  const profile = loadProfile(attachedExe)
  const context = buildModuleContext(profile, live)
  loadedModules = context.modules
  changedModules = context.changedModules
  patchEngine.setAnchorContext(context.modules, context.verified)
}

// Shared by the manual process:attach handler and the watcher's onAppear —
// both must go through the same restore-before-switch guard (put a
// previously-attached process's code back while its handle is still valid)
// and the same module-context refresh, rather than one of the two paths
// quietly skipping it.
function attachTo(pid: number, exeName: string): { handle: number; baseAddress: string } {
  if (attachedHandle !== null && attachedPid !== pid) {
    patchEngine.restoreAll()
    // patchEngine's bookkeeping just got cleared for the process we're
    // leaving; cheatRuntime's must reset with it. Without this, a manual
    // re-attach to a different game leaves cheatRuntime reporting 'active'
    // for a patch that restoreAll() just uninstalled — the UI chip lies,
    // and arm() early-returns on 'active' so the user can't re-arm the
    // cheat without first disarming it by hand. Matches what the watcher's
    // onVanish path already does.
    cheatRuntime.processExited()
  }
  const { handle, baseAddress } = nativeAddon.attach(pid)
  attachedHandle = handle
  attachedBase = baseAddress
  attachedPid = pid
  refreshModuleContext(exeName)
  return { handle, baseAddress }
}

function currentGameState(): { exe: string | null; pid: number | null; changedModules: string[] } {
  return { exe: attachedExe, pid: attachedPid, changedModules }
}

// A patch anchored to a module is only trustworthy across builds if we know
// which build it was captured against. Record that module's fingerprint
// beside the cheat as it is saved — this is the only moment we are certain
// the anchor and the loaded module agree.
export function saveCheatWithFingerprint(exeName: string, cheat: StoredCheat): void {
  saveCheat(exeName, cheat)
  if (!isPatchCheat(cheat) || cheat.moduleName === null || attachedHandle === null) return
  const fp = fingerprintOf(nativeAddon.listModules(attachedHandle), cheat.moduleName)
  if (fp !== null) recordModuleFingerprint(exeName, cheat.moduleName, fp)
}

const cheatRuntime = new CheatRuntime({
  locate: async (patch) => {
    const status = await patchEngine.locate(patch)
    return { address: status.address, reason: status.reason ?? null }
  },
  apply: (patch) => patchEngine.apply(patch),
  restore: (patch) => {
    patchEngine.restore(patch)
  },
  isVerified: (patch) =>
    patch.moduleName === null || !changedModules.includes(patch.moduleName.toLowerCase())
})

// A relearned RVA is worth keeping — it turns the next launch of this build
// into the arithmetic path. Best-effort: a failed write must not stop a
// working cheat.
//
// Relearning only fires when the fingerprint DIDN'T match (arithmetic was
// skipped) but a scan found the code anyway — so persisting the new RVA
// without also updating the fingerprint means the next launch hits the same
// mismatch and re-scans forever, and the relearn mechanism never pays off
// in the one case it exists for. Recording the fingerprint here is safe
// despite skipping the usual save-time verification moment: persisting the
// relearned RVA already implicitly trusts the build that produced it, and
// anchor.ts always byte-checks the arithmetic result against the captured
// instruction before ever trusting it — a bad fingerprint here can only
// make the next launch fall back to a scan, never make it patch the wrong
// bytes.
// Pure: finds the relearned patch and returns it with the new offset
// applied, or null when there's nothing to persist (patch not found, or not
// a patch cheat at all). Kept separate from disk I/O so the decision is
// testable without loadProfile/saveCheat/electron.
export function applyRelearn(
  profile: ReturnType<typeof loadProfile>,
  patchId: string,
  offset: string
): PatchCheat | null {
  const cheat = profile.cheats.find((c) => c.id === patchId)
  if (!cheat || !isPatchCheat(cheat)) return null
  cheat.moduleOffset = offset
  return cheat
}

patchEngine.onRelearn((patchId, offset) => {
  if (attachedExe === null) return
  try {
    const profile = loadProfile(attachedExe)
    const cheat = applyRelearn(profile, patchId, offset)
    if (!cheat) return
    saveCheat(attachedExe, cheat)
    if (cheat.moduleName !== null && attachedHandle !== null) {
      const fp = fingerprintOf(nativeAddon.listModules(attachedHandle), cheat.moduleName)
      if (fp !== null) recordModuleFingerprint(attachedExe, cheat.moduleName, fp)
    }
  } catch (err) {
    console.warn(`[patch] could not persist relearned offset for ${patchId}: ${String(err)}`)
  }
})

// Wired into the watcher, which polls this against every running process
// every couple of seconds — it must never throw. loadProfile deliberately
// throws on a malformed games/*.json (a correct safety property for the
// save path, which must not silently overwrite a file it can't parse), but
// a corrupt profile must not crash the watcher's setInterval callback
// forever; treat "can't tell" as "no profile" here. profileFileExists is a
// cheap existsSync-only check first, so the common case (a process with no
// profile at all) never pays for a read+JSON.parse.
export function hasProfile(exeName: string): boolean {
  if (!profileFileExists(exeName)) return false
  try {
    return loadProfile(exeName).cheats.length > 0
  } catch {
    return false
  }
}

// Notices games we have cheats for launching and closing, and auto-attaches
// (read-capable handle) — never auto-arms. Arming stays a user action.
const watcher = new ProcessWatcher({
  listProcesses: () => nativeAddon.listProcesses(),
  hasProfile
})

export function startWatching(getWindow: () => BrowserWindow): void {
  watcher.onAppear((proc) => {
    attachTo(proc.pid, proc.name)
    getWindow().webContents.send('game:state', currentGameState())
  })
  watcher.onVanish(() => {
    // The process is gone: reset the runtime WITHOUT restoring (there is no
    // live handle to write a restore through), and forget every address
    // patchEngine recorded for it — restoreAll()'s next call must not carry
    // this process's addresses forward into whatever attaches next (see
    // PatchEngine.forgetAll).
    cheatRuntime.processExited()
    patchEngine.forgetAll()
    attachedHandle = null
    attachedBase = null
    attachedPid = null
    attachedExe = null
    loadedModules = new Map()
    changedModules = []
    getWindow().webContents.send('game:state', currentGameState())
  })
  watcher.start()
}

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
    // Also mirrored into the runtime's own tracking — inert for a plain
    // value cheat (no armed patch shares its id), but keeps the two
    // degraded/recovered notions from silently diverging if that ever
    // changes.
    cheatRuntime.markDegraded(cheatId)
    getWindow().webContents.send('cheat:broken', cheatId)
  })
  freezeLoop.onRecovered((cheatId) => {
    cheatRuntime.markRecovered(cheatId)
    getWindow().webContents.send('cheat:recovered', cheatId)
  })
  cheatRuntime.onChange((cheatId, status) => {
    getWindow().webContents.send('cheat:state', { cheatId, status })
  })

  ipcMain.handle('process:list', () => nativeAddon.listProcesses())

  ipcMain.handle('process:attach', (_e, pid: number) => {
    // The renderer only passes the pid; look the name up from the same
    // listing it picked the process from so the profile file (named by exe)
    // and module fingerprints can be resolved.
    const proc = nativeAddon.listProcesses().find((p) => p.pid === pid)
    return attachTo(pid, proc ? proc.name : String(pid))
  })

  ipcMain.handle('game:current', () => currentGameState())

  ipcMain.handle('cheats:load', (_e, exeName: string): StoredCheat[] => loadCheats(exeName))

  ipcMain.handle('cheats:save', (_e, exeName: string, cheat: StoredCheat) => {
    saveCheatWithFingerprint(exeName, cheat)
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

  ipcMain.handle('cheats:oneShot', async (_e, cheat: CheatDefinition) => {
    if (attachedHandle === null) return false
    return writeCheat(attachedHandle, cheat)
  })

  ipcMain.handle(
    'cheats:verify',
    async (_e, cheat: CheatDefinition, expectedValue: number | null): Promise<TargetStatus[]> => {
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
    // Arming is the retrying state machine now, not a one-shot apply: this
    // starts it and returns immediately. The real outcome (active / failed /
    // still arming) arrives on 'cheat:state'.
    cheatRuntime.arm(patch)
    return { ok: true, error: null }
  })

  ipcMain.handle('patch:restore', (_e, patch: PatchCheat) => {
    // Safe even when nothing is attached or nothing is armed: disarm()
    // sources its restore target from its own armed map, and patchOps'
    // writeBytes/suspendThreads already no-op against a null handle.
    cheatRuntime.disarm(patch.id, patch)
    return true
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

  // Mono Explorer's read side: resolve a class by (namespace, name) and list
  // its fields/methods by name. Search-by-exact-name only — a full class
  // listing needs per-assembly image walking not yet wired (see
  // mono:listClasses below), so this covers "type the class name you
  // already know" rather than a live browsable tree.
  ipcMain.handle('mono:listClasses', async () => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    // A class-name index doesn't exist as a single Mono call — this walks
    // every listed assembly's image and, per image, every class via the
    // fixed-namespace lookup this task's UI actually needs (searching by
    // typed name rather than a full unbounded class dump, matching the
    // design's "lazy, drill-down" choice: this handler resolves ONE
    // caller-supplied namespace+name pair, not a listing).
    return []
  })

  ipcMain.handle('mono:resolveClass', async (_e, namespaceName: string, className: string) => {
    if (attachedHandle === null) return null
    const base = monoDllBase()
    if (base === null) return null
    return monoResolver.resolveClass(attachedHandle, base, namespaceName, className)
  })

  ipcMain.handle('mono:listFields', async (_e, classHandle: string) => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    return monoResolver.listFieldNames(attachedHandle, base, classHandle)
  })

  ipcMain.handle('mono:listMethods', async (_e, classHandle: string) => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    return monoResolver.listMethodNames(attachedHandle, base, classHandle)
  })

  startWatching(getWindow)
}

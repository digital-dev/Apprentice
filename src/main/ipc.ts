import { ipcMain, BrowserWindow, dialog, globalShortcut } from 'electron'
import fs from 'node:fs'
import { nativeAddon, Candidate } from './nativeAddon'
import {
  loadCheats,
  saveCheat,
  deleteCheat,
  findHotkeyConflict,
  CheatDefinition,
  ChainTarget,
  AnchorTarget,
  isAnchorTarget,
  isMonoTarget,
  MonoTarget,
  StoredCheat,
  PatchCheat,
  patchMode,
  isPatchCheat,
  isScriptCheat,
  type ScriptCheat
} from './store'
import { importCheatTable } from './ctImport'
import { buildCheatTable } from './ctExport'
import { PatchEngine, PatchOps, slotHexToPointer } from './patchEngine'
import { FreezeLoop } from './freezeLoop'
import { monoResolver } from './monoResolver'
import {
  resolveMonoTargetAddress,
  resolveMonoPointerChain,
  resolveMonoLiveValue,
  MonoLiveValue,
  MonoResolverOps
} from './monoTargetResolve'
import { findClassLocations } from './monoClassLocations'
import {
  loadProfile,
  recordModuleFingerprint,
  verifiedModules,
  fingerprintOf,
  profileFileExists
} from './profile'
import { CheatRuntime } from './cheatRuntime'
import { HotkeyManager, HotkeyDeps } from './hotkeys'
import {
  ScriptRuntime,
  ScriptRunLimiter,
  SCRIPT_RUN_CAP_ERROR,
  type LuaValue
} from './scriptRuntime'
import { ProcessWatcher } from './watcher'
import type { LoadedModule, MonoOps } from './anchor'

let attachedHandle: number | null = null
let attachedBase: string | null = null
let attachedPid: number | null = null

// How many scan-family native async operations are currently in flight.
//
// ScanFirstWorker, ScanNextWorker, ScanAobWorker and ResolvePointerChain
// Worker each capture the raw HANDLE by value when they are dispatched and
// then use it minutes later on a libuv worker thread. If a re-attach closes
// that handle while one is still running, Windows is free to reissue the
// exact same handle VALUE to the next OpenProcess — handle values are
// recycled aggressively, immediately after a close — and the in-flight
// worker would then read the WRONG process without any error. Tracking the
// count lets attachTo say so out loud instead of switching silently.
let scanOpsInFlight = 0

function trackScanOp<T>(run: () => Promise<T>): Promise<T> {
  scanOpsInFlight++
  let p: Promise<T>
  try {
    p = run()
  } catch (err) {
    // Some of these throw synchronously (argument validation happens before
    // the AsyncWorker is queued), in which case nothing is ever in flight.
    scanOpsInFlight--
    throw err
  }
  // Promise.resolve rather than p.finally directly: these are declared
  // async but a test double (or a future sync fast path) may hand back a
  // plain value, and the counter must still come back down.
  return Promise.resolve(p).finally(() => {
    scanOpsInFlight--
  })
}
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

// Resolves a live object pointer from a named class's static field — e.g.
// Player.m_localPlayer — for an immune patch's armValue. staticFieldAddress
// alone only gives the field's storage location, not what it currently
// points at, so this reads the 8 bytes stored there and decodes them as a
// pointer. Scoped to exactly this one purpose (a named class + static
// field, not an arbitrary address) rather than exposing a general memory
// read to the renderer, matching this sub-project's existing safety rule
// against unscoped capabilities. Shared by the mono:resolvePlayerPointer
// IPC handler (one-off UI resolution) and monoPatchOps.resolvePointer
// (fresh-every-install resolution for an immune patch's armPointerClassName/
// armPointerFieldName pair) — same operation, two callers.
async function resolveMonoPointer(
  handle: number,
  base: string,
  className: string,
  fieldName: string,
  instanceFieldName?: string
): Promise<string | null> {
  return resolveMonoPointerChain(handle, base, className, fieldName, monoOps, instanceFieldName)
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
  if (dataType === 'float' || dataType === 'double') return Math.abs(read - expected) < 1.0
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
  scanAob: async (signature, rangeStart, rangeEnd) => {
    if (attachedHandle === null) return []
    const h = attachedHandle
    return trackScanOp(() => nativeAddon.scanAob(h, signature, rangeStart, rangeEnd))
  },
  allocateCave: (nearAddress) =>
    attachedHandle === null ? null : nativeAddon.allocateCave(attachedHandle, nearAddress),
  freeCave: (address) => {
    if (attachedHandle === null) return
    nativeAddon.freeMemory(attachedHandle, address)
  },
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
  encodeImmuneGuard: (playerPointerAddress, argRegister, caveCodeAddress, returnAddress, returnKind, returnBits) =>
    nativeAddon.encodeImmuneGuard(
      playerPointerAddress,
      argRegister,
      caveCodeAddress,
      returnAddress,
      returnKind,
      returnBits
    ),
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
    attachedHandle === null ? Promise.resolve(null) : monoResolver.compileMethod(attachedHandle, base, cls, method),
  resolvePointer: (base, cls, field, instanceField) =>
    attachedHandle === null
      ? Promise.resolve(null)
      : resolveMonoPointer(attachedHandle, base, cls, field, instanceField)
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
    // Same reasoning as cheatRuntime above: a hotkey registered for the
    // process we're leaving must not still fire (or fire against the
    // wrong game) after we've switched. registerAll below re-registers
    // fresh for the new exe.
    hotkeyManager.unregisterAll()
    for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
      scriptRuntime.clear(cheat.id)
    }
  }
  // The old handle (if any) is about to be replaced below — close it now,
  // while we still have it, rather than leaking it. Unconditional on the
  // branch above: a manual re-attach to the SAME already-attached pid
  // (reachable via the process:attach IPC handler) skips that branch but
  // still opens a brand-new HANDLE below, so the old one must be closed
  // here too or it leaks silently. Safe even when patchEngine.restoreAll()
  // above already used it: CloseHandle only releases OUR reference to the
  // kernel object, it doesn't affect the target process itself.
  //
  // NOT safe against aliasing, though — this used to claim it was. Windows
  // recycles handle VALUES aggressively, and can hand the very next
  // OpenProcess the exact value we just closed. Anything still holding the
  // old value would then silently address the NEW process. In this module
  // everything reads `attachedHandle` live through a closure, so the only
  // real exposure is a native scan-family AsyncWorker that captured the raw
  // handle by value at dispatch time and is still running. That is narrow
  // but real, so at minimum it is reported rather than hidden.
  if (scanOpsInFlight > 0) {
    console.warn(
      `[attach] re-attaching to pid ${pid} while ${scanOpsInFlight} scan operation(s) are still in flight; ` +
        'their results may belong to the previous process and should be discarded'
    )
  }
  // Clear attachedHandle BEFORE closing and before the attach attempt. If
  // the target died between being listed and now, nativeAddon.attach throws
  // (process_utils.cc's Attach throws for a dead pid) — and leaving
  // attachedHandle pointing at a handle we just CLOSED is strictly worse
  // than leaving it stale: every later use (patchEngine.restoreAll, freeze
  // writes, stopWriteWatch) would operate on a dead handle value that the
  // OS may already have reissued to something else. Nulling first means a
  // thrown attach leaves this module cleanly "not attached".
  const previousHandle = attachedHandle
  attachedHandle = null
  if (previousHandle !== null) nativeAddon.detach(previousHandle)
  const { handle, baseAddress } = nativeAddon.attach(pid)
  attachedHandle = handle
  attachedBase = baseAddress
  attachedPid = pid
  refreshModuleContext(exeName)
  hotkeyManager.registerAll(attachedExe ?? exeName)
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
  restore: (patch) => patchEngine.restore(patch),
  isVerified: (patch) =>
    patch.moduleName === null || !changedModules.includes(patch.moduleName.toLowerCase())
})

// Real HotkeyDeps: wraps the electron globalShortcut module and this
// file's own freezeLoop/patchEngine/cheatRuntime/loadCheats/writeCheat —
// the same operations cheats:toggleFreeze/cheats:oneShot/patch:apply/
// patch:restore already expose over IPC, just reached directly instead of
// through a renderer round trip.
// One budget for every script run in the process — cheat toggles (through
// ScriptRuntime) and ScriptEditor's ad-hoc `scripts:run` alike. See
// ScriptRunLimiter for why the cap exists and what it does not fix.
const scriptRunLimiter = new ScriptRunLimiter()

const scriptRuntime = new ScriptRuntime(async (source, stateIn) => {
  if (attachedHandle === null) {
    return { success: false, output: [], error: 'not attached', stateOut: stateIn }
  }
  return nativeAddon.runScript(attachedHandle, source, stateIn)
}, scriptRunLimiter)

const hotkeyDeps: HotkeyDeps = {
  loadCheats,
  isFreezeEnabled: (cheatId) => freezeLoop.isEnabled(cheatId),
  enableFreeze: (cheat) => freezeLoop.enable(cheat),
  disableFreeze: (cheatId) => freezeLoop.disable(cheatId),
  oneShot: async (cheat) => (attachedHandle === null ? false : writeCheat(attachedHandle, cheat)),
  isScriptEnabled: (cheatId) => scriptRuntime.isEnabled(cheatId),
  runScriptEnable: (cheat) => scriptRuntime.enable(cheat),
  runScriptDisable: (cheat) => scriptRuntime.disable(cheat),
  // Mirrors exactly the condition cheatRuntime.arm() itself uses to decide
  // whether to no-op, so "is this patch armed, from the hotkey's
  // perspective" agrees with "will calling arm() actually do anything".
  // patchEngine.isApplied() only flips true once a full locate+apply round
  // trip has succeeded, which lags well behind arm()'s own no-op guard —
  // using it here left a patch stuck 'arming' unable to ever be disarmed
  // by hotkey (see hotkeys.ts's HotkeyDeps.isPatchArmed doc).
  isPatchArmed: (patchId) => {
    const state = cheatRuntime.status(patchId).state
    return state === 'arming' || state === 'active' || state === 'degraded'
  },
  armPatch: (patch) => cheatRuntime.arm(patch),
  disarmPatch: (patch) => cheatRuntime.disarm(patch.id, patch),
  registerShortcut: (accelerator, callback) => globalShortcut.register(accelerator, callback),
  unregisterAllShortcuts: () => globalShortcut.unregisterAll()
}
const hotkeyManager = new HotkeyManager(hotkeyDeps)

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
    hotkeyManager.unregisterAll()
    for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
      scriptRuntime.clear(cheat.id)
    }
    if (attachedHandle !== null) nativeAddon.detach(attachedHandle)
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
  hotkeyManager.unregisterAll()
  for (const cheat of loadCheats(attachedExe ?? '').filter(isScriptCheat)) {
    scriptRuntime.clear(cheat.id)
  }
  // Nulled after closing so a second before-quit call (Electron's quit can
  // in principle fire more than once if an earlier one is aborted/retried)
  // is a no-op here instead of calling CloseHandle again on an already-
  // closed value — same idempotency onVanish already has.
  if (attachedHandle !== null) {
    nativeAddon.detach(attachedHandle)
    attachedHandle = null
  }
}

export function registerIpcHandlers(getWindow: () => BrowserWindow): void {
  hotkeyManager.onFired((cheatId, outcome, error) => {
    getWindow().webContents.send('hotkey:fired', { cheatId, outcome, error })
  })
  hotkeyManager.onConflict((failed) => {
    getWindow().webContents.send('hotkey:conflict', failed)
  })

  // Pull-based counterpart to the onConflict push above: registerAll() runs
  // synchronously during process:attach and the watcher's auto-attach, both
  // of which happen before the renderer's CheatList has mounted and
  // subscribed to the push — so those conflicts would otherwise reach
  // nobody. The renderer pulls this once on mount to pick up whatever
  // already happened.
  ipcMain.handle('hotkeys:conflicts', () => hotkeyManager.getConflicts())

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
    const conflict = findHotkeyConflict(loadCheats(exeName), cheat)
    if (conflict) {
      throw new Error(`Hotkey already used by "${conflict}" — pick a different combo.`)
    }
    if (cheat.hotkey && !isPatchCheat(cheat) && !isScriptCheat(cheat) && cheat.targets.some(isAnchorTarget)) {
      throw new Error(
        'Hotkeys are not yet supported for cheats anchored to a capture patch — toggle this one from the cheat list.'
      )
    }
    saveCheatWithFingerprint(exeName, cheat)
    // A save can add, change, or clear a hotkey. If the profile being
    // saved to is the currently-attached exe, re-registering the full set
    // now picks that up immediately instead of waiting for the next
    // attach; saving to a different (unattached) profile's file — not
    // reachable from the current UI, but the IPC channel doesn't
    // otherwise prevent it — correctly does nothing here, since only the
    // attached exe's hotkeys are ever live.
    if (attachedExe !== null && exeName.replace(/\.exe$/i, '') === attachedExe) {
      hotkeyManager.registerAll(attachedExe)
    }
  })

  ipcMain.handle('cheats:delete', (_e, exeName: string, cheatId: string) => {
    freezeLoop.disable(cheatId)
    // A deleted script must not leave its enabled flag and captured `state`
    // behind: ids are reused (a new cheat can be created with the same id
    // after a delete), and a stale entry would hand a fresh cheat someone
    // else's captured values — or report it enabled before it ever ran.
    scriptRuntime.clear(cheatId)
    // A deleted patch must not stay in the game's code — restore it while
    // we still have its recorded address and original bytes.
    if (patchEngine.isApplied(cheatId)) {
      const stored = loadCheats(exeName).find((c) => c.id === cheatId)
      if (stored && stored.kind === 'patch') patchEngine.restore(stored)
    }
    deleteCheat(exeName, cheatId)
    // A deleted cheat's hotkey must stop firing — without this,
    // HotkeyManager's registered accelerator still closes over the
    // now-deleted cheat definition and re-adds it to the freeze loop
    // every time the key is pressed, with no UI row left to disable it.
    // Same guard cheats:save already uses: only re-register if we're
    // deleting from the currently-attached exe's profile.
    if (attachedExe !== null && exeName.replace(/\.exe$/i, '') === attachedExe) {
      hotkeyManager.registerAll(attachedExe)
    }
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
    'scripts:toggle',
    async (_e, cheat: ScriptCheat, enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      return enabled ? scriptRuntime.enable(cheat) : scriptRuntime.disable(cheat)
    }
  )

  ipcMain.handle('scripts:isEnabled', (_e, cheatId: string): boolean => scriptRuntime.isEnabled(cheatId))

  ipcMain.handle(
    'scripts:run',
    async (
      _e,
      source: string,
      stateIn: Record<string, LuaValue>
    ): Promise<{
      success: boolean
      output: string[]
      error: string | null
      stateOut: Record<string, LuaValue>
    }> => {
      if (attachedHandle === null) throw new Error('not attached')
      // Unlike scripts:toggle, this path has no in-flight guard of its own —
      // the test button can be clicked as fast as the user likes. It must
      // still count against the same global budget, or a few impatient
      // clicks on a stuck script would strand the whole threadpool.
      if (!scriptRunLimiter.tryAcquire()) {
        return { success: false, output: [], error: SCRIPT_RUN_CAP_ERROR, stateOut: stateIn }
      }
      try {
        return await nativeAddon.runScript(attachedHandle, source, stateIn)
      } finally {
        scriptRunLimiter.release()
      }
    }
  )

  ipcMain.handle(
    'memory:readBlock',
    (_e, address: string, length: number): Buffer | null => {
      if (attachedHandle === null) throw new Error('not attached')
      return nativeAddon.tryReadMemoryBlock(attachedHandle, address, length)
    }
  )

  // No attach check: this only decodes a buffer the renderer already read
  // via memory:readBlock — it never touches the process itself, so it works
  // (or fails on its own bytes-related terms) regardless of attach state.
  ipcMain.handle(
    'memory:disassemble',
    (_e, buffer: Buffer, baseAddress: string, maxCount?: number) =>
      nativeAddon.disassembleBuffer(buffer, baseAddress, maxCount)
  )

  ipcMain.handle('memory:writeByte', (_e, address: string, value: number): boolean => {
    if (attachedHandle === null) throw new Error('not attached')
    // Same call writeCheat makes for an int8 target — int8 is this app's
    // unsigned 1-byte width, exactly what a hex editor's 0-255 byte field
    // wants (see store.ts's DataType comment).
    return nativeAddon.writeValue(attachedHandle, address, [], 'int8', value)
  })

  // Resolves a ChainTarget's absolute address for the "View in Memory"
  // button — only meaningful for a target with no offsets left to walk
  // (offsets.length === 0), where baseOffset is the only/last element of
  // the chain and needs no dereference: moduleBase + baseOffset, exactly
  // the arithmetic fullOffsets/writeCheat already do for the general case.
  // baseOffset is module-relative, never an absolute address on its own —
  // handing it straight to the memory viewer without this resolution step
  // navigates to the wrong address entirely.
  ipcMain.handle(
    'memory:resolveTargetAddress',
    (_e, moduleName: string, baseOffset: string): string | null => {
      if (attachedHandle === null) return null
      const moduleBase = nativeAddon.getModuleBase(attachedHandle, moduleName)
      if (moduleBase === null) return null
      return '0x' + (BigInt(moduleBase) + BigInt(baseOffset)).toString(16)
    }
  )

  // General "View in Memory" resolver for a saved value cheat's target —
  // unlike memory:resolveTargetAddress above (module+baseOffset only, no
  // dereference), this handles all three target shapes a cheat can have:
  // anchor (capture patch slot), mono (class/field), and a full module+
  // offsets pointer chain (walked via the same ResolveChain readValue/
  // writeValue use, but returning the address itself — see nativeAddon.ts's
  // resolveAddress and memory_ops.cc's native counterpart).
  ipcMain.handle(
    'cheats:resolveTargetAddress',
    async (_e, target: ChainTarget): Promise<string | null> => {
      if (attachedHandle === null) return null
      if (isAnchorTarget(target)) return resolveAnchor(attachedHandle, target)
      if (isMonoTarget(target)) return resolveMonoTarget(attachedHandle, target)
      const moduleBase = nativeAddon.getModuleBase(attachedHandle, target.moduleName)
      if (moduleBase === null) return null
      return nativeAddon.resolveAddress(attachedHandle, moduleBase, fullOffsets(target))
    }
  )

  ipcMain.handle(
    'cheats:verify',
    async (_e, cheat: CheatDefinition, expectedValue: number | null): Promise<TargetStatus[]> => {
      if (attachedHandle === null) throw new Error('not attached')
      return verifyCheat(attachedHandle, cheat, expectedValue)
    }
  )

  // Each of these is wrapped in trackScanOp so attachTo can tell whether a
  // native worker still holds a by-value copy of the handle it is about to
  // close — see scanOpsInFlight's comment.
  ipcMain.handle('scan:first', (_e, dataType: string, value: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    const h = attachedHandle
    return trackScanOp(() => nativeAddon.scanFirst(h, dataType, value))
  })

  ipcMain.handle('scan:next', (_e, candidates: Candidate[], dataType: string, filter: unknown) => {
    if (attachedHandle === null) throw new Error('not attached')
    const h = attachedHandle
    return trackScanOp(() => nativeAddon.scanNext(h, candidates, dataType, filter as never))
  })

  ipcMain.handle('scan:resolveChain', (_e, target: string, maxLevels: number) => {
    if (attachedHandle === null) throw new Error('not attached')
    const h = attachedHandle
    return trackScanOp(() => nativeAddon.resolvePointerChain(h, target, maxLevels))
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

  ipcMain.handle('mono:listAssemblyNames', async () => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    return monoResolver.listAssemblyNames(attachedHandle, base)
  })

  ipcMain.handle('mono:listClassesInImage', async (_e, imageHandle: string) => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    return monoResolver.listClassesInImage(attachedHandle, base, imageHandle)
  })

  ipcMain.handle('mono:classLocations', async (_e, className: string): Promise<string[]> => {
    if (attachedHandle === null) return []
    const base = monoDllBase()
    if (base === null) return []
    const handle = attachedHandle
    return findClassLocations(className, {
      listAssemblyNames: () => monoResolver.listAssemblyNames(handle, base),
      listClassesInImage: (imageHandle) => monoResolver.listClassesInImage(handle, base, imageHandle)
    })
  })

  ipcMain.handle(
    'mono:resolvePlayerPointer',
    async (
      _e,
      className: string,
      fieldName: string,
      instanceFieldName?: string
    ): Promise<string | null> => {
      if (attachedHandle === null) return null
      const base = monoDllBase()
      if (base === null) return null
      return resolveMonoPointer(attachedHandle, base, className, fieldName, instanceFieldName)
    }
  )

  ipcMain.handle(
    'mono:readLiveValue',
    async (
      _e,
      className: string,
      staticFieldName: string,
      instanceFieldName?: string
    ): Promise<MonoLiveValue | null> => {
      if (attachedHandle === null) return null
      const base = monoDllBase()
      if (base === null) return null
      const target: MonoTarget = instanceFieldName
        ? { kind: 'mono', className, staticFieldName, instanceFieldName }
        : { kind: 'mono', className, staticFieldName }
      return resolveMonoLiveValue(target, attachedHandle, base, monoOps)
    }
  )

  // Auto-fills a Mono-anchored patch's originalBytes/length from the
  // method's actual live entry bytes, instead of making the user guess
  // instruction boundaries with an external disassembler. Safe as a
  // fixed-length snapshot regardless of mode: locate()'s mismatch check
  // only ever compares these bytes byte-for-byte against what's there now
  // (detecting "something else changed this code"). nop mode's length
  // directly becomes the NOP run, so a nop-mode patch must still have its
  // length trimmed to a whole-instruction boundary by hand before saving.
  //
  // patch.length governs how many bytes get NOP'd/overwritten only in
  // 'nop' mode — but for 'force' mode specifically, patchEngine.ts's
  // installInjection now REQUIRES patch.length to exactly match the
  // first decoded instruction's length (refusing to install otherwise),
  // since force mode slices the displaced run at that boundary. This
  // auto-fill is a fixed snapshot size, not a decoded boundary — if the
  // user picks force mode with an auto-filled length, installInjection's
  // own guard is what catches a mismatch, not this comment's old claim
  // that length "never" matters.
  ipcMain.handle(
    'mono:resolveMethodBytes',
    async (
      _e,
      className: string,
      methodName: string,
      length: number
    ): Promise<{ bytes: string; length: number } | null> => {
      if (attachedHandle === null) return null
      const base = monoDllBase()
      if (base === null) return null
      const classHandle = await monoResolver.resolveClass(attachedHandle, base, '', className)
      if (classHandle === null) return null
      const address = await monoResolver.compileMethod(attachedHandle, base, classHandle, methodName)
      if (address === null) return null
      const bytes = nativeAddon.tryReadBytes(attachedHandle, address, length)
      if (bytes === null) return null
      return { bytes, length }
    }
  )

  // Opens a native file picker for a .CT file, converts every recognizable
  // entry (see ctImport.ts's module comment for exactly which shape) into
  // a force-mode PatchCheat, and saves them immediately — matching how
  // every other bulk write in this app works (no separate "confirm"
  // step). Returns a summary for the renderer to display, not the full
  // patch objects; the saved cheats themselves are picked up the normal
  // way, through cheats:load's existing reactive flow.
  ipcMain.handle(
    'ct:import',
    async (
      _e,
      exeName: string
    ): Promise<{ importedNames: string[]; skipped: { description: string; reason: string }[] } | null> => {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Import Cheat Engine table',
        filters: [{ name: 'Cheat Table', extensions: ['CT', 'ct'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null

      let xml: string
      try {
        xml = fs.readFileSync(result.filePaths[0], 'utf8')
      } catch (err) {
        return { importedNames: [], skipped: [{ description: result.filePaths[0], reason: String(err) }] }
      }

      const { imported, skipped } = importCheatTable(xml)
      for (const patch of imported) saveCheat(exeName, patch)
      return { importedNames: imported.map((p) => p.name), skipped }
    }
  )

  // Opens a native save dialog and writes out every 'force'-mode patch as
  // a Cheat Engine Auto Assembler entry — the exact reverse of ct:import
  // above. Everything that mode can't represent (other patch modes, value
  // cheats) is skipped and reported, not approximated; see ctExport.ts's
  // module comment for why.
  ipcMain.handle(
    'ct:export',
    async (
      _e,
      exeName: string
    ): Promise<{ exportedNames: string[]; skipped: { name: string; reason: string }[] } | null> => {
      const allCheats = loadCheats(exeName)
      // internal: true patches are capture-anchored plumbing for value
      // cheats and are never shown in the cheat list UI (see store.ts's
      // comment on PatchCheat.internal) — they must not surface as skip
      // entries for patches the user never saw.
      const patches = allCheats.filter(isPatchCheat).filter((p) => !p.internal)
      const scripts = allCheats.filter(isScriptCheat)
      const valueCheats = allCheats.filter((c) => !isPatchCheat(c) && !isScriptCheat(c))
      const { xml, exported, skipped: patchSkipped } = buildCheatTable(patches)
      const skipped = [
        ...patchSkipped,
        ...valueCheats.map((cheat) => ({
          name: cheat.name,
          reason: "Value cheats have no equivalent Auto Assembler script shape and can't be exported to .CT."
        })),
        ...scripts.map((cheat) => ({
          name: cheat.name,
          reason: "Lua-scripted cheats have no equivalent Auto Assembler script shape and can't be exported to .CT."
        }))
      ]
      const result = await dialog.showSaveDialog(getWindow(), {
        title: 'Export Cheat Engine table',
        defaultPath: `${exeName.replace(/\.exe$/i, '')}.CT`,
        filters: [{ name: 'Cheat Table', extensions: ['CT'] }]
      })
      if (result.canceled || !result.filePath) return null
      try {
        fs.writeFileSync(result.filePath, xml, 'utf8')
      } catch (err) {
        return { exportedNames: [], skipped: [{ name: result.filePath, reason: String(err) }] }
      }
      return { exportedNames: exported, skipped }
    }
  )

  startWatching(getWindow)
}

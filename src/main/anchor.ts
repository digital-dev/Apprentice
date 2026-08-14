import type { PatchCheat } from './store'

// Why a patch could not be located. These are opposite problems with
// opposite fixes and must not collapse into one "not found": a user told
// the signature matched four places knows to re-capture a longer
// instruction; a user told it matched none knows the code is gone.
export type AnchorReason =
  | 'module-missing'
  | 'no-match'
  | 'ambiguous'
  | 'bytes-differ'
  // Not an error. Mono compiles a method on first call, so a scan before
  // the game has run the code correctly finds nothing. The caller keeps
  // retrying rather than reporting a failure.
  | 'not-yet-compiled'
  // mono.dll isn't in the target's module list yet.
  | 'mono-not-loaded'
  // The runtime is up but the named class's assembly hasn't loaded yet
  // (a scene not yet entered, content not yet active).
  | 'mono-assembly-not-loaded'
  // Added: disarm()'s restore write failed — the game's code is still
  // patched even though the user asked to turn it off. Distinct from every
  // other reason above, which all describe a FAILED ARM; this describes a
  // failed DISARM, surfaced through the same CheatStatus.reason field
  // since CheatRuntime already has no separate channel for it.
  | 'restore-failed'

export interface AnchorResult {
  address: string | null
  matchCount: number | null
  reason: AnchorReason | null
  // A new RVA worth writing back to the profile: set when a module-anchored
  // patch had to be found by scanning, so the next launch of this build
  // takes the arithmetic path instead.
  relearnedOffset: string | null
  scanned: boolean
}

export interface AnchorOps {
  readBytes(address: string, length: number): string | null
  scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]>
}

// A third way to locate a patch: ask the live Mono runtime for a
// class+method's compiled entry address, instead of module+RVA arithmetic
// or an AOB scan. compileMethod is the one call that can force real JIT
// compilation of a method the game hasn't run yet — see monoResolver.ts.
export interface MonoOps {
  monoDllBase(): string | null
  resolveClass(monoDllBase: string, className: string): Promise<string | null>
  compileMethod(monoDllBase: string, classHandle: string, methodName: string): Promise<string | null>
  // Resolves a live object pointer from a named class's static field (e.g.
  // Player.m_localPlayer) — for re-arming an immune patch's guard fresh on
  // every install, instead of trusting a pointer captured in a previous
  // process instance. Optional: only patches using the dynamic
  // armPointerClassName/armPointerFieldName pair need it, and older
  // MonoOps implementations (tests, etc.) don't have to supply it.
  resolvePointer?(
    monoDllBase: string,
    className: string,
    fieldName: string,
    instanceFieldName?: string
  ): Promise<string | null>
}

export interface LoadedModule {
  name: string
  base: string
  size: number
}

function addHex(address: string, delta: bigint): string {
  return '0x' + (BigInt(address) + delta).toString(16)
}

function bytesMatch(ops: AnchorOps, address: string, patch: PatchCheat): boolean {
  const current = ops.readBytes(address, patch.length)
  if (current === null) return false
  return current.toLowerCase() === patch.originalBytes.toLowerCase()
}

// Where a patch lives right now. Tries arithmetic first, then a scan, and
// verifies the bytes on BOTH paths — an RVA that still points at the
// captured instruction is trustworthy even in a build we have never seen,
// and an RVA that does not is discarded rather than patched. That is what
// makes "warn and allow" safe after a game update.
export async function resolvePatchAddress(
  patch: PatchCheat,
  modules: Map<string, LoadedModule>,
  verified: Set<string>,
  ops: AnchorOps,
  monoOps?: MonoOps
): Promise<AnchorResult> {
  // Path 0: Mono class+method. Only for a patch that names no module — a
  // class+method-anchored patch has no meaningful AOB signature to fall
  // back to (it never had one captured), so there is no scan fallback here
  // the way there is below for a module-anchored/JIT patch.
  if (patch.monoClass !== undefined && patch.monoMethod !== undefined && monoOps) {
    const monoDllBase = monoOps.monoDllBase()
    if (monoDllBase === null) {
      return { address: null, matchCount: null, reason: 'mono-not-loaded', relearnedOffset: null, scanned: false }
    }
    const classHandle = await monoOps.resolveClass(monoDllBase, patch.monoClass)
    if (classHandle === null) {
      return {
        address: null,
        matchCount: null,
        reason: 'mono-assembly-not-loaded',
        relearnedOffset: null,
        scanned: false
      }
    }
    const address = await monoOps.compileMethod(monoDllBase, classHandle, patch.monoMethod)
    if (address === null) {
      return { address: null, matchCount: null, reason: 'not-yet-compiled', relearnedOffset: null, scanned: false }
    }
    // Deliberately no bytesMatch() gate here, unlike every other path below.
    // Mono JIT output is not a stable cross-session signature — a fresh
    // launch reliably recompiles this method to different bytes (embedded
    // absolute addresses, register allocation, code layout can all differ),
    // so comparing against a byte snapshot captured in an EARLIER session
    // would make every Mono-anchored patch fail to relocate after every
    // single game restart — exactly the "capture once, use once" bug this
    // whole sub-project exists to avoid. Mono's own class+method resolution
    // IS the verification here: if it resolved to a real, currently-loaded
    // method, that address is trustworthy on its own. locate() still checks
    // the bytes actually AT this address for its own purposes (detecting
    // "already applied" / a foreign injection), just not against a stored
    // snapshot from a different process instance.
    return { address, matchCount: 1, reason: null, relearnedOffset: null, scanned: false }
  }

  // modules/verified are keyed lowercase by the caller (see ipc.ts's
  // refreshModuleContext), but this function shouldn't assume that — the OS
  // can report a module's casing differently across launches (or the stored
  // moduleName can differ only in case from what's live right now), and
  // profile.ts's verifiedModules already treats that as the same module.
  // Lowercase at the lookup site rather than trust the caller normalized.
  const module =
    patch.moduleName === null ? undefined : modules.get(patch.moduleName.toLowerCase())

  // Path 1: module base + RVA, for a module whose fingerprint still matches.
  if (
    patch.moduleName !== null &&
    patch.moduleOffset !== null &&
    module &&
    verified.has(patch.moduleName.toLowerCase())
  ) {
    let candidate: string | null = null
    try {
      candidate = addHex(module.base, BigInt(patch.moduleOffset))
    } catch {
      // A hand-edited games/*.json can carry a malformed offset. BigInt()
      // throws SyntaxError rather than failing gracefully; treat it as
      // unresolvable and let the scan path have a go.
      candidate = null
    }
    if (candidate !== null && bytesMatch(ops, candidate, patch)) {
      return { address: candidate, matchCount: null, reason: null, relearnedOffset: null, scanned: false }
    }
  }

  // Path 2: scan, bounded to the module when we know which one.
  const bounded = module !== undefined
  const matches = bounded
    ? await ops.scanAob(patch.signature, module.base, addHex(module.base, BigInt(module.size)))
    : await ops.scanAob(patch.signature)

  if (matches.length !== 1) {
    const reason: AnchorReason =
      matches.length === 0
        ? patch.moduleName === null
          ? 'not-yet-compiled'
          : module === undefined
            ? 'module-missing'
            : 'no-match'
        : 'ambiguous'
    return { address: null, matchCount: matches.length, reason, relearnedOffset: null, scanned: true }
  }

  // A match is the start of the PATTERN, which may begin before the
  // captured instruction — the signature covers surrounding method code so
  // a short method is still uniquely identifiable. Step forward to the
  // instruction itself. Absent offset means the pattern starts at the
  // instruction, which is how every pre-injection patch was saved.
  const address = addHex(matches[0], BigInt(patch.signatureOffset ?? 0))
  if (!bytesMatch(ops, address, patch)) {
    return { address: null, matchCount: 1, reason: 'bytes-differ', relearnedOffset: null, scanned: true }
  }

  const relearnedOffset =
    module === undefined ? null : '0x' + (BigInt(address) - BigInt(module.base)).toString(16)

  return { address, matchCount: 1, reason: null, relearnedOffset, scanned: true }
}

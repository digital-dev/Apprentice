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
  ops: AnchorOps
): Promise<AnchorResult> {
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

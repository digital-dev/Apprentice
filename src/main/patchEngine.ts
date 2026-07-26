import type { PatchCheat, DataType } from './store'
import { patchMode } from './store'

// Everything PatchEngine needs from the target process. Injected rather
// than imported so the engine's locate/apply/restore logic — the part that
// must never write to a wrong or unverified address — can be tested
// exhaustively against a fake process (same style as FreezeLoop's writeFn).
export interface PatchOps {
  getModuleBase(moduleName: string): string | null
  readBytes(address: string, length: number): string | null
  writeBytes(address: string, hexBytes: string): boolean
  scanAob(signature: string): Promise<string[]>
  allocateCave(nearAddress: string): string | null
  decodeRun(
    address: string,
    minBytes: number
  ): { length: number; decodable: boolean; relocatable: boolean }
  encodeStore(baseRegister: string, offset: number, imm32: number): string
  encodeJump(from: string, to: string): string
  suspendThreads(): boolean
  resumeThreads(): void
}

export type PatchState = 'original' | 'applied' | 'not-found' | 'mismatch' | 'unreadable'

export interface PatchStatus {
  address: string | null
  state: PatchState
  // Safe to toggle on: we found it AND its bytes are what we expect.
  applicable: boolean
  // How many places the AOB signature matched, or null for a module-anchored
  // patch (which resolves by arithmetic and never scans). The engine refuses
  // anything other than exactly one match, but "the code is gone" (0) and
  // "this signature isn't unique" (>1) are opposite problems with opposite
  // fixes — re-capture vs. a longer signature — so the count has to survive
  // as far as the UI rather than collapsing into one 'not-found'.
  matchCount: number | null
}

// What resolveAddress worked out: where the patch currently lives, and how
// many candidates the signature scan saw getting there.
interface Resolution {
  address: string | null
  matchCount: number | null
}

export function nopHex(length: number): string {
  return '90'.repeat(length)
}

// "Can't relocate" covers three different situations with three different
// remedies, so say which one happened. A user who is told the signature
// matched four places knows to re-capture a longer instruction; a user told
// it matched none knows the code is gone.
export function relocationError(status: PatchStatus): string {
  if (status.matchCount === null) {
    return "The module this patch lives in isn't loaded, so it can't be located."
  }
  if (status.matchCount === 0) {
    return "This instruction's signature no longer appears in the game's code — it may have been re-compiled since capture. Re-capture it."
  }
  return `This instruction's signature matches ${status.matchCount} places in the game's code, so there's no way to tell which one to patch. Not guessing. Re-capture a longer instruction if you can.`
}

interface AppliedPatch {
  address: string
  originalBytes: string
  // Kept for diagnostics and for capture-mode readers; never freed.
  caveAddress: string | null
}

// A 5-byte `jmp rel32` is the smallest redirect that reaches anywhere in
// range, so the site must give up at least that many bytes — always whole
// instructions, which is what decodeRun computes.
const JUMP_LENGTH = 5

// `value` becomes the exact 32 bits the injected store writes. A float has
// to go through its IEEE-754 bit pattern: 350.0 is 0x43af0000, and writing
// the integer 350 instead would land as a denormal fraction in the game.
export function valueBits(value: number, dataType: DataType): number {
  if (dataType === 'float') {
    const buffer = new ArrayBuffer(4)
    new DataView(buffer).setFloat32(0, value, true)
    return new DataView(buffer).getUint32(0, true)
  }
  return value >>> 0
}

interface InstallResult {
  ok: boolean
  error: string | null
  caveAddress: string | null
}

function addHex(address: string, delta: number): string {
  return '0x' + (BigInt(address) + BigInt(delta)).toString(16)
}

export class PatchEngine {
  private ops: PatchOps
  // The source of truth for what must be restored. Authoritative over the
  // stored definition: if the code moved after we patched it, the address
  // we actually wrote to is the only one that matters for putting the
  // original bytes back.
  private applied = new Map<string, AppliedPatch>()

  constructor(ops: PatchOps) {
    this.ops = ops
  }

  isApplied(id: string): boolean {
    return this.applied.has(id)
  }

  async locate(patch: PatchCheat): Promise<PatchStatus> {
    const { address, matchCount } = await this.resolveAddress(patch)
    if (address === null) return { address: null, state: 'not-found', applicable: false, matchCount }

    const current = this.ops.readBytes(address, patch.length)
    // Resolved but unreadable: the address is still worth reporting — it
    // distinguishes "the code page went away" from "we never found it",
    // which look identical to a user staring at one error message.
    if (current === null) return { address, state: 'unreadable', applicable: false, matchCount }

    const original = patch.originalBytes.toLowerCase()
    if (current.toLowerCase() === original)
      return { address, state: 'original', applicable: true, matchCount }
    if (current.toLowerCase() === nopHex(patch.length))
      return { address, state: 'applied', applicable: true, matchCount }
    // Something else lives there now — another trainer, an update, or a
    // wrong relocation. Never overwrite it.
    return { address, state: 'mismatch', applicable: false, matchCount }
  }

  async apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }> {
    // Already applied: the recorded address is authoritative. Re-locating
    // here could resolve to a different address (JIT code moved) and
    // overwrite that record, orphaning the NOPs we already wrote — this is
    // a no-op success, not a re-patch.
    if (this.applied.has(patch.id)) return { ok: true, error: null }

    const status = await this.locate(patch)
    if (status.address === null || status.state === 'not-found') {
      return { ok: false, error: relocationError(status) }
    }
    if (status.state === 'unreadable') {
      return {
        ok: false,
        error: `Found it at ${status.address} but that memory is no longer readable — the code was probably freed.`
      }
    }
    if (status.state === 'mismatch') {
      return {
        ok: false,
        error: "The bytes at that address don't match what was captured — not patching."
      }
    }

    let caveAddress: string | null = null
    if (status.state === 'original') {
      const mode = patchMode(patch)
      const installed =
        mode === 'nop'
          ? this.installNop(patch, status.address)
          : this.installInjection(patch, status.address)
      if (!installed.ok) return installed
      caveAddress = installed.caveAddress
    }
    // 'applied' falls through: the NOPs are already there (e.g. we
    // re-attached to a process we had patched), so nothing needs writing —
    // but we must still record it so it gets restored.
    this.applied.set(patch.id, {
      address: status.address,
      // Normalize once here so restore() can never write a differently
      // cased blob than the one locate() compared against.
      originalBytes: patch.originalBytes.toLowerCase(),
      caveAddress
    })
    return { ok: true, error: null }
  }

  restore(patch: PatchCheat): boolean {
    const entry = this.applied.get(patch.id)
    if (!entry) return true
    this.ops.suspendThreads()
    let ok: boolean
    try {
      ok = this.ops.writeBytes(entry.address, entry.originalBytes)
    } finally {
      this.ops.resumeThreads()
    }
    if (ok) this.applied.delete(patch.id)
    return ok
  }

  // Detach / app quit: put every patched instruction back. A failed write
  // here is ignored — it means the process is already gone, and its code
  // went with it. The set is cleared either way so a later attach starts
  // from a clean slate. Suspended once around the whole loop rather than
  // per patch.
  restoreAll(): void {
    this.ops.suspendThreads()
    try {
      for (const entry of this.applied.values()) {
        this.ops.writeBytes(entry.address, entry.originalBytes)
      }
    } finally {
      this.ops.resumeThreads()
    }
    this.applied.clear()
  }

  private installNop(patch: PatchCheat, address: string): InstallResult {
    if (!this.ops.writeBytes(address, nopHex(patch.length))) {
      return { ok: false, error: 'Write failed — the patch was not applied.', caveAddress: null }
    }
    return { ok: true, error: null, caveAddress: null }
  }

  // Build the cave first, while nothing is redirected into it, then swap the
  // site under suspension. Ordering matters: a jump installed before its
  // cave holds valid code sends the game into garbage.
  private installInjection(patch: PatchCheat, address: string): InstallResult {
    const run = this.ops.decodeRun(address, JUMP_LENGTH)
    if (!run.decodable) {
      return {
        ok: false,
        error: "Couldn't read enough whole instructions at that address to redirect it.",
        caveAddress: null
      }
    }
    if (!run.relocatable) {
      return {
        ok: false,
        error:
          "This instruction sits with code that refers to its own address, so moving it would change what it does. Try a different caught instruction.",
        caveAddress: null
      }
    }

    const displaced = this.ops.readBytes(address, run.length)
    if (displaced === null) {
      return { ok: false, error: 'That memory became unreadable.', caveAddress: null }
    }

    const cave = this.ops.allocateCave(address)
    if (cave === null) {
      return {
        ok: false,
        error: "No memory available near the instruction to hold the injected code.",
        caveAddress: null
      }
    }

    // The injected code starts at the cave's own address; there is no
    // reserved header in force mode (capture mode, not built yet, will
    // define its own layout when it lands).
    const codeAddress = cave
    const effect = this.ops.encodeStore(
      patch.baseRegister as string,
      Number(BigInt(patch.fieldOffset as string)),
      valueBits(patch.value as number, patch.dataType as DataType)
    )
    const returnTo = addHex(address, run.length)
    const jumpBackFrom = addHex(codeAddress, displaced.length / 2 + effect.length / 2)
    const body = displaced + effect + this.ops.encodeJump(jumpBackFrom, returnTo)

    if (!this.ops.writeBytes(codeAddress, body)) {
      return { ok: false, error: 'Failed to write the injected code.', caveAddress: null }
    }

    const jump = this.ops.encodeJump(address, codeAddress)
    const padded = jump + nopHex(run.length - JUMP_LENGTH)

    this.ops.suspendThreads()
    try {
      if (!this.ops.writeBytes(address, padded)) {
        return { ok: false, error: 'Failed to redirect the instruction.', caveAddress: null }
      }
    } finally {
      // Always resume: a target left suspended is a hung game, which is
      // worse than a failed patch.
      this.ops.resumeThreads()
    }
    return { ok: true, error: null, caveAddress: cave }
  }

  private async resolveAddress(patch: PatchCheat): Promise<Resolution> {
    if (patch.moduleName !== null && patch.moduleOffset !== null) {
      const base = this.ops.getModuleBase(patch.moduleName)
      if (base === null) return { address: null, matchCount: null }
      // PatchCheat isn't runtime-validated — a hand-edited games/*.json can
      // carry a malformed offset. BigInt() throws SyntaxError on that
      // rather than failing gracefully, so treat it as unresolvable.
      try {
        return {
          address: '0x' + (BigInt(base) + BigInt(patch.moduleOffset)).toString(16),
          matchCount: null
        }
      } catch {
        return { address: null, matchCount: null }
      }
    }
    // JIT / anonymous code: only a signature can find it again. Anything
    // other than exactly one match is ambiguous, and a guess here means
    // NOPping an unknown instruction.
    const matches = await this.ops.scanAob(patch.signature)
    if (matches.length !== 1) return { address: null, matchCount: matches.length }
    return { address: matches[0], matchCount: 1 }
  }
}

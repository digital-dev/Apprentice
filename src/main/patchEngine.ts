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
  ): {
    length: number
    decodable: boolean
    relocatable: boolean
    // Every 64-bit GPR the displaced run writes, by its widest name (a
    // `mov eax, 1` reports 'rax'). An effect cannot address the field
    // through a register that appears here.
    clobbers: string[]
  }
  encodeStore(baseRegister: string, offset: number, imm32: number): string
  encodeCaptureOnce(baseRegister: string, atAddress: string, slotAddress: string): string
  encodeGuardedSkip(
    baseRegister: string,
    atAddress: string,
    slotAddress: string,
    returnAddress: string
  ): string
  encodeJump(from: string, to: string): string
  suspendThreads(): boolean
  resumeThreads(): void
}

export type PatchState =
  | 'original'
  | 'applied'
  | 'not-found'
  | 'mismatch'
  | 'unreadable'
  // A jmp trampoline sits at the site but this engine instance has no record
  // of installing it — e.g. Tamper crashed or was relaunched while the game
  // kept running. We have `originalBytes` (the captured instruction) but not
  // the full displaced run the trampoline actually covers, and we don't have
  // `caveAddress` either, so there is no safe way to restore or adopt it.
  // The only correct move is to refuse and say so; the game must be
  // restarted to clear it.
  | 'foreign-injection'

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
  // The bytes to write back on restore. For a NOP patch this is exactly the
  // captured instruction (patch.length bytes). For an injection it is the
  // FULL displaced run installInjection read before overwriting the site —
  // which is frequently longer than patch.length, because decodeRun rounds
  // up to whole instructions and folds in whatever follows the captured one.
  // Restoring only patch.length bytes here would leave the remainder as
  // leftover NOPs in the game's code — see Finding 1.
  originalBytes: string
  // Kept for diagnostics and for capture-mode readers; never freed.
  caveAddress: string | null
  // Only a capture patch has a readable slot; recorded so slotAddress can
  // tell a capture cave from a force cave without re-deriving the mode.
  mode: 'nop' | 'force' | 'capture' | 'guard'
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
  // The bytes actually displaced at the site, unspaced lowercase hex — the
  // full run installInjection/installNop overwrote, which restore() must
  // write back. Null on failure, where nothing was written and there is
  // nothing to restore.
  displaced: string | null
}

// An address as the 8 little-endian bytes the slot holds, so a guard can be
// pre-armed with the object the capture actually saw.
export function pointerToSlotHex(address: string): string {
  let value = BigInt(address)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += (value & 0xffn).toString(16).padStart(2, '0')
    value >>= 8n
  }
  return out
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
    // A patch we installed is at the address we installed it at — no need to
    // go looking, and looking gives the wrong answer.
    //
    // An injection replaces the instruction with a jump, so the signature
    // (which describes the ORIGINAL bytes) genuinely matches nothing once
    // the patch is on. Re-scanning then reported "no signature match" the
    // moment a cheat was enabled, which reads as a failure but is the patch
    // working exactly as intended — it sent a real session chasing a
    // relocation bug that did not exist. A NOP patch has the same problem in
    // milder form: its bytes are all 0x90 and only match by luck.
    const installed = this.applied.get(patch.id)
    if (installed) {
      return { address: installed.address, state: 'applied', applicable: true, matchCount: 1 }
    }

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
    // A jmp trampoline this engine instance isn't tracking: an injection
    // installed by a previous Tamper session (crash, or relaunch) is still
    // live in the game. We cannot restore it correctly (Finding 1's missing
    // run length) or adopt it (no recovered caveAddress either), so this
    // must fail closed and say why, rather than falling into 'mismatch's
    // generic message.
    if (patchMode(patch) !== 'nop' && !this.applied.has(patch.id) && current.toLowerCase().startsWith('e9')) {
      return { address, state: 'foreign-injection', applicable: false, matchCount }
    }
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
    if (status.state === 'foreign-injection') {
      return {
        ok: false,
        error:
          "An injection from a previous Tamper session is still active at this address. Restart the game to clear it before patching again."
      }
    }
    if (status.state === 'mismatch') {
      return {
        ok: false,
        error: "The bytes at that address don't match what was captured — not patching."
      }
    }

    let caveAddress: string | null = null
    // What restore() must write back. Defaults to the captured instruction —
    // correct for the 'applied' fallthrough below and for NOP installs,
    // where the displaced run is always exactly patch.length bytes.
    // Normalized once here so restore() can never write a differently cased
    // blob than the one locate() compared against.
    let displacedBytes = patch.originalBytes.toLowerCase()
    if (status.state === 'original') {
      const mode = patchMode(patch)
      const installed =
        mode === 'nop'
          ? this.installNop(patch, status.address)
          : this.installInjection(patch, status.address)
      if (!installed.ok) return { ok: false, error: installed.error }
      caveAddress = installed.caveAddress
      // An injection's displaced run is frequently longer than patch.length
      // (decodeRun rounds up to whole instructions) — installInjection
      // already read those exact bytes before overwriting the site, so use
      // them verbatim rather than re-deriving from patch.length.
      if (installed.displaced !== null) displacedBytes = installed.displaced
    }
    // 'applied' falls through: the NOPs are already there (e.g. we
    // re-attached to a process we had patched), so nothing needs writing —
    // but we must still record it so it gets restored.
    this.applied.set(patch.id, {
      address: status.address,
      originalBytes: displacedBytes,
      caveAddress,
      mode: patchMode(patch)
    })
    return { ok: true, error: null }
  }

  // The captured pointer lives in the first 8 bytes of the cave. Only a
  // capture patch has one, and only while it is installed — an uninstalled
  // patch has no memory in the game to read from.
  slotAddress(id: string): string | null {
    const entry = this.applied.get(id)
    // Both injected modes that remember something use the same slot at the
    // cave's start: capture records the object for an anchored cheat to read
    // through, guard records the one object it protects. Reporting guard's
    // too is what lets the UI show which entity a guard locked onto — without
    // it, a guard that armed on the wrong thing is indistinguishable from one
    // that isn't working, and both just look like "it does nothing".
    if (!entry || (entry.mode !== 'capture' && entry.mode !== 'guard')) return null
    return entry.caveAddress
  }

  // Policy for this whole restore path (restore() and restoreAll() below),
  // stated once here rather than left to live only in a task report:
  // install refuses when suspendThreads() fails, but restore does not. That
  // is deliberate, not an oversight — the two operations face opposite
  // risks. Refusing to write NEW code into a live process is the safe
  // default; a torn write there could execute garbage. But refusing to
  // RESTORE would leave the game permanently patched, which is the exact
  // failure this whole sub-project exists to prevent — a torn restore write
  // is the lesser evil. Do not make restore/restoreAll refuse on a failed
  // suspend without revisiting this call.
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
  // per patch. As in restore(), a failed suspend does not stop the loop —
  // restoring live is still better than leaving the game patched forever.
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
      return {
        ok: false,
        error: 'Write failed — the patch was not applied.',
        caveAddress: null,
        displaced: null
      }
    }
    // The NOP path always displaces exactly patch.length bytes — the
    // captured instruction locate() already verified is sitting there.
    return { ok: true, error: null, caveAddress: null, displaced: patch.originalBytes.toLowerCase() }
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
        caveAddress: null,
        displaced: null
      }
    }
    if (!run.relocatable) {
      return {
        ok: false,
        error:
          "This instruction sits with code that refers to its own address, so moving it would change what it does. Try a different caught instruction.",
        caveAddress: null,
        displaced: null
      }
    }

    const displaced = this.ops.readBytes(address, run.length)
    if (displaced === null) {
      return { ok: false, error: 'That memory became unreadable.', caveAddress: null, displaced: null }
    }

    // PatchCheat isn't runtime-validated — a hand-edited games/*.json can
    // carry a force-mode patch missing baseRegister/fieldOffset/value/
    // dataType, or a fieldOffset that isn't valid hex. BigInt() throws on
    // that rather than failing gracefully, same hazard resolveAddress
    // guards against for moduleOffset. Checked before allocateCave so a bad
    // patch never leaks an allocated cave. A capture patch needs only
    // baseRegister — it has no fieldOffset/value/dataType to validate, and
    // must not be rejected for lacking fields it does not use. This only
    // validates that the fields parse; fieldOffset itself is recomputed
    // where it's used, in the force branch of the effect below, so the
    // compiler can enforce it's a plain `number` rather than a
    // possibly-unset one carried across this whole function.
    const mode = patchMode(patch)
    try {
      if (typeof patch.baseRegister !== 'string') {
        throw new Error('missing base register')
      }
      // capture and guard both need only the register: capture records it,
      // guard compares against it. Neither writes a value of its own, so
      // demanding value/dataType/fieldOffset would reject them for lacking
      // fields they never use.
      if (mode === 'force') {
        if (typeof patch.value !== 'number' || !patch.dataType) {
          throw new Error('missing force-mode fields')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
    } catch {
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : "This patch is missing the register, offset, value, or data type a force injection needs, or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
      }
    }

    const cave = this.ops.allocateCave(address)
    if (cave === null) {
      return {
        ok: false,
        error: "No memory available near the instruction to hold the injected code.",
        caveAddress: null,
        displaced: null
      }
    }

    // The slot occupies the first 8 bytes so capture mode can find it at a
    // fixed offset; code starts after it in both modes, so the layout is
    // the same whichever mode installed the cave.
    const codeAddress = addHex(cave, 8)

    // The effect runs FIRST, before any displaced bytes.
    //
    // The obvious layout — replay the game's instructions, then apply the
    // effect — is what crashed Valheim. The displaced run is not the
    // captured instruction alone: decodeRun rounds up to whole instructions
    // to reach the 5 a jmp rel32 needs, so a short captured store drags in
    // whatever follows. A swallowed instruction that writes the base
    // register then leaves the effect dereferencing a value the game has
    // already repurposed — `movss [rax], xmm5` followed by `mov eax, 1`
    // made the injected store fault on address 0x1, every time.
    //
    // Running the effect first means it always sees the registers exactly
    // as they were at the patched instruction — the state the capture
    // recorded them in. What follows it differs by mode:
    //
    //   force   the captured store is the write being REPLACED, so it is
    //           not replayed at all. Replaying it and then overwriting
    //           reaches the same value by doing the work twice, and only
    //           survives when the base register happens to be untouched.
    //           Instructions swallowed AFTER it are unrelated game code and
    //           must still run.
    //   capture records where the object is without changing what the game
    //           does, so the game's own write still has to happen. The
    //           whole displaced run is replayed after the effect.
    // guard replays everything, like capture: it does not replace the write,
    // it decides per-object whether to run it.
    const replay =
      mode === 'capture' || mode === 'guard' ? displaced : displaced.slice(patch.length * 2)

    // The capture store is RIP-relative, so it must be encoded for the
    // address it actually executes at — codeAddress, now that it runs
    // first. Encoding it for anywhere else silently corrupts whatever the
    // wrong RIP-relative target happens to be.
    const returnTo = addHex(address, run.length)
    const effect =
      mode === 'capture'
        ? this.ops.encodeCaptureOnce(patch.baseRegister as string, codeAddress, cave)
        : mode === 'guard'
          ? // The guard needs the return address up front: its whole point is
            // an early exit that skips the replayed write, so one of its two
            // paths jumps straight back rather than falling through.
            this.ops.encodeGuardedSkip(
              patch.baseRegister as string,
              codeAddress,
              cave,
              returnTo
            )
          : this.ops.encodeStore(
              patch.baseRegister as string,
              Number(BigInt(patch.fieldOffset as string)),
              valueBits(patch.value as number, patch.dataType as DataType)
            )
    const jumpBackFrom = addHex(codeAddress, effect.length / 2 + replay.length / 2)
    const body = effect + replay + this.ops.encodeJump(jumpBackFrom, returnTo)

    // Pre-arm the guard before anything can reach the cave. Self-arming
    // takes whichever entity the game touches first, and at a site that runs
    // for every loaded creature that is essentially never the player — a
    // real session watched it lock onto a stranger three times running. The
    // capture already recorded the register's value at the moment it wrote
    // the address the user was watching, which is by construction theirs.
    if (mode === 'guard' && patch.armValue) {
      if (!this.ops.writeBytes(cave, pointerToSlotHex(patch.armValue))) {
        return {
          ok: false,
          error: 'Failed to arm the guard.',
          caveAddress: null,
          displaced: null
        }
      }
    }

    if (!this.ops.writeBytes(codeAddress, body)) {
      return { ok: false, error: 'Failed to write the injected code.', caveAddress: null, displaced: null }
    }

    const jump = this.ops.encodeJump(address, codeAddress)
    const padded = jump + nopHex(run.length - JUMP_LENGTH)

    // Suspension must actually hold before rewriting live code — a failed
    // suspend still runs resumeThreads() (harmless: the platform layer
    // clears an empty list) so the path stays uniform, but the write itself
    // is refused rather than proceeding against running threads.
    const suspended = this.ops.suspendThreads()
    try {
      if (!suspended) {
        return {
          ok: false,
          error: "Couldn't pause the game safely enough to redirect the instruction — not writing to running code.",
          caveAddress: null,
          displaced: null
        }
      }
      if (!this.ops.writeBytes(address, padded)) {
        return {
          ok: false,
          error: 'Failed to redirect the instruction.',
          caveAddress: null,
          displaced: null
        }
      }
    } finally {
      // Always resume: a target left suspended is a hung game, which is
      // worse than a failed patch.
      this.ops.resumeThreads()
    }
    // The full displaced run — may be longer than patch.length — is what
    // restore() must write back; see the AppliedPatch.originalBytes comment.
    return { ok: true, error: null, caveAddress: cave, displaced: displaced.toLowerCase() }
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
    // A match is the start of the PATTERN, which may begin before the
    // captured instruction — the signature covers surrounding method code
    // so a short method is still uniquely identifiable. Step forward to the
    // instruction itself. Absent offset means the pattern starts at the
    // instruction, which is how every pre-injection patch was saved.
    const lead = patch.signatureOffset ?? 0
    return { address: '0x' + (BigInt(matches[0]) + BigInt(lead)).toString(16), matchCount: 1 }
  }
}

import type { PatchCheat, DataType } from './store'
import { patchMode } from './store'
import { resolvePatchAddress } from './anchor'
import type { AnchorReason, LoadedModule, MonoOps } from './anchor'

// Local copy of ipc.ts's own littleEndianToBigInt — patchEngine.ts can't
// import from ipc.ts (ipc.ts imports patchEngine.ts; that direction would
// be circular), and this is a 3-line pure function, not worth a shared
// module for. Same tolerance CODEBASE_MAP.md already documents for the
// native side's duplicated ParseHex/ToHex.
function littleEndianToBigInt(hex: string): bigint {
  const swapped = (hex.match(/.{1,2}/g) ?? []).reverse().join('')
  return BigInt('0x' + (swapped === '' ? '0' : swapped))
}

// Walks a plain module+baseOffset+offsets pointer chain to the live
// POINTER VALUE it leads to — not an address, unlike ChainTarget's own
// resolution (which stops one hop short, since a value cheat wants
// somewhere to read/write, not what's stored there). This is the non-Mono
// counterpart to MonoOps.resolvePointer below: same "re-resolve fresh
// every install, a chain moves between game sessions" reasoning, just via
// an ordinary ReadProcessMemory walk instead of Mono metadata — safe to
// call anytime (no debugger, no hardware breakpoints), unlike the
// find-what-writes capture that originally located this chain.
function resolveChainPointer(
  ops: PatchOps,
  moduleName: string,
  baseOffset: string,
  offsets: string[]
): string | null {
  const moduleBase = ops.getModuleBase(moduleName)
  if (moduleBase === null) return null
  let addr = BigInt(moduleBase) + BigInt(baseOffset)
  for (const offset of offsets) {
    const bytes = ops.readBytes('0x' + addr.toString(16), 8)
    if (bytes === null) return null
    addr = littleEndianToBigInt(bytes) + BigInt(offset)
  }
  // One more dereference than the loop above performs per offset — addr
  // right now is "base + last offset, not yet dereferenced" (exactly a
  // ChainTarget's own final address); reading through it once more gets
  // the pointer VALUE stored there, which is what this function promises.
  const bytes = ops.readBytes('0x' + addr.toString(16), 8)
  if (bytes === null) return null
  return '0x' + littleEndianToBigInt(bytes).toString(16)
}

// Everything PatchEngine needs from the target process. Injected rather
// than imported so the engine's locate/apply/restore logic — the part that
// must never write to a wrong or unverified address — can be tested
// exhaustively against a fake process (same style as FreezeLoop's writeFn).
export interface PatchOps {
  getModuleBase(moduleName: string): string | null
  readBytes(address: string, length: number): string | null
  writeBytes(address: string, hexBytes: string): boolean
  // Optional bounds, `0x`-prefixed hex: absent means an unbounded scan.
  // Widened so PatchOps satisfies AnchorOps structurally.
  scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]>
  allocateCave(nearAddress: string): string | null
  // Releases a cave allocateCave reserved, when installation failed before
  // the site redirect ever pointed the game at it — safe to call in that
  // window specifically, since no thread can be executing inside a cave
  // the game was never redirected to. See platform::FreeMemory's own
  // safety comment for the general rule this is a narrow, provably-safe
  // instance of.
  freeCave(address: string): void
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
  encodeStoreRegister(destRegister: string, offset: number, sourceRegister: string): string
  encodeScale(sourceXmmRegister: string, atAddress: string, slotAddress: string): string
  // scale's conditional sibling: same multiply, but only when a call to
  // methodAddress (with baseRegister as its sole argument) returns the
  // pointer armed in slotAddress[0..8) — see cave_ops.cc's own comment on
  // the 16-byte slot layout this needs, vs. plain scale's 8.
  encodeConditionalScale(
    sourceXmmRegister: string,
    baseRegister: string,
    methodAddress: string,
    atAddress: string,
    slotAddress: string
  ): string
  encodeCaptureOnce(baseRegister: string, atAddress: string, slotAddress: string): string
  encodeGuardedSkip(
    baseRegister: string,
    atAddress: string,
    slotAddress: string,
    returnAddress: string
  ): string
  // The entry-point guard behind `immune` mode: compares argRegister (the
  // hooked method's "this") against the pointer stored at
  // playerPointerAddress, returning from the WHOLE method on a match and
  // falling through to returnAddress — where the replayed prologue sits —
  // on no match. Unlike encodeGuardedSkip's early exit, a match here never
  // falls back into the function.
  // returnKind/returnBits: absent means "return bare 0" (a skip — the
  // ApplyDamage shape). Set to force a SPECIFIC value back instead — the
  // GetHealth shape, for a getter where returning nothing meaningful isn't
  // an option.
  encodeImmuneGuard(
    playerPointerAddress: string,
    argRegister: string,
    caveCodeAddress: string,
    returnAddress: string,
    returnKind?: 'int32' | 'float',
    returnBits?: number
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
  // Which anchor failure this was, for the UI chip. Present only when
  // resolution went through the verified-module anchor path and failed;
  // undefined for the legacy resolution path and for states that never
  // needed resolution (e.g. the already-applied short-circuit in locate()).
  reason?: AnchorReason
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
  mode: 'nop' | 'replace' | 'force' | 'capture' | 'guard' | 'immune' | 'copy' | 'scale' | 'strip'
}

// A 5-byte `jmp rel32` is the smallest redirect that reaches anywhere in
// range, so the site must give up at least that many bytes — always whole
// instructions, which is what decodeRun computes.
const JUMP_LENGTH = 5

// Both the 16 64-bit GPR names and their 32-bit aliases, since a real Auto
// Assembler script names the 32-bit form for a dword store (e.g. "eax") —
// normalized here to the 64-bit name native/src/cave_ops.cc's
// RegisterByName actually knows, so a copy-mode patch imported from a .CT
// table's 32-bit register name doesn't need its own translation layer.
const GPR64_ALIASES: Record<string, string> = {
  rax: 'rax', eax: 'rax',
  rbx: 'rbx', ebx: 'rbx',
  rcx: 'rcx', ecx: 'rcx',
  rdx: 'rdx', edx: 'rdx',
  rsi: 'rsi', esi: 'rsi',
  rdi: 'rdi', edi: 'rdi',
  rbp: 'rbp', ebp: 'rbp',
  rsp: 'rsp', esp: 'rsp',
  r8: 'r8', r8d: 'r8',
  r9: 'r9', r9d: 'r9',
  r10: 'r10', r10d: 'r10',
  r11: 'r11', r11d: 'r11',
  r12: 'r12', r12d: 'r12',
  r13: 'r13', r13d: 'r13',
  r14: 'r14', r14d: 'r14',
  r15: 'r15', r15d: 'r15'
}

// The 16 128-bit XMM registers, scale mode's source-register set — the
// counterpart to GPR64_ALIASES above, and a table rather than a regex for
// the same reason: validation and the name actually handed to the native
// encoder read from ONE place, so they cannot drift apart. They did drift
// once — validation lowercased the name but the raw (possibly uppercase)
// string went to encodeScale, which does an exact-case lookup and threw
// from inside the cave-allocated section, leaking a cave in the target.
const XMM_REGISTERS: Record<string, string> = {
  xmm0: 'xmm0', xmm1: 'xmm1', xmm2: 'xmm2', xmm3: 'xmm3',
  xmm4: 'xmm4', xmm5: 'xmm5', xmm6: 'xmm6', xmm7: 'xmm7',
  xmm8: 'xmm8', xmm9: 'xmm9', xmm10: 'xmm10', xmm11: 'xmm11',
  xmm12: 'xmm12', xmm13: 'xmm13', xmm14: 'xmm14', xmm15: 'xmm15'
}

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

// A 32-bit value as the 4 little-endian bytes the cave's slot holds — the
// pointerToSlotHex of scale mode, which parks its multiplier's float bits in
// that same reserved slot for its RIP-relative mulss to read. Four bytes,
// not eight: the slot is 8 bytes wide but a single-precision factor only
// occupies the low dword, and the cave arrives zeroed.
export function bitsToSlotHex(bits: number): string {
  let value = bits >>> 0
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += (value & 0xff).toString(16).padStart(2, '0')
    value >>>= 8
  }
  return out
}

// The inverse of pointerToSlotHex: 8 little-endian bytes read back from a
// static field's storage address, as the pointer value they encode. Used
// to resolve a live object (e.g. the local player instance behind a
// Player.m_localPlayer static field) into an immune patch's armValue —
// staticFieldAddress alone only gives the field's storage location, not
// what it currently points at.
export function slotHexToPointer(hex: string): string {
  let value = 0n
  for (let i = 7; i >= 0; i--) {
    const byte = hex.slice(i * 2, i * 2 + 2) || '00'
    value = (value << 8n) | BigInt(parseInt(byte, 16))
  }
  return '0x' + value.toString(16)
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

  // What the engine currently knows about the target's modules. Set by the
  // caller after every attach; empty until then, which routes every patch —
  // module-anchored AND JIT — through the legacy getModuleBase/scanAob
  // arithmetic below rather than the verified anchor path — see
  // resolveAddress.
  private modules = new Map<string, LoadedModule>()
  private verified = new Set<string>()
  // Whether setAnchorContext has ever been called with real data. This, not
  // per-patch module membership, is what gates resolveAddress: gating
  // per-patch would strand JIT patches (moduleName is always null, so a
  // per-module check never matches them) and a loaded-but-unverified module
  // (the "game updated" case this whole anchor path exists for) on the
  // legacy path forever, even after the caller starts supplying context —
  // exactly the two cases resolvePatchAddress's scan-and-relearn fallback is
  // for.
  private contextSet = false
  // Optional third anchor path, set via setMonoOps: resolvePatchAddress
  // only uses it once supplied, and only for a patch that names a
  // monoClass/monoMethod. Passed straight through the same contextSet gate
  // as everything else in resolveAddress — see the comment there.
  private monoOps: MonoOps | undefined
  private relearnCb: ((patchId: string, offset: string) => void) | null = null
  // Set fresh on every resolveAddress call; only the anchor path (module
  // verified, or a JIT patch) ever assigns it a real reason. Left undefined
  // by the legacy path and by success, so a status built from it via
  // `reason: this.lastReason` omits the key entirely under toEqual rather
  // than asserting a stale one from a previous call.
  private lastReason: AnchorReason | undefined = undefined

  constructor(ops: PatchOps) {
    this.ops = ops
  }

  setAnchorContext(modules: Map<string, LoadedModule>, verified: Set<string>): void {
    this.modules = modules
    this.verified = verified
    this.contextSet = true
  }

  setMonoOps(ops: MonoOps): void {
    this.monoOps = ops
  }

  // Fired when a scan relocated a module-anchored patch, so the caller can
  // write the new RVA back to the profile. Best-effort by design: a failed
  // write must not stop an otherwise working cheat from arming.
  onRelearn(cb: (patchId: string, offset: string) => void): void {
    this.relearnCb = cb
  }

  isApplied(id: string): boolean {
    return this.applied.has(id)
  }

  // The process is gone (not merely being switched away from): its code —
  // and every address this engine recorded for it — went with it. Forgetting
  // is deliberately NOT restoring: restore() writes through the CURRENT
  // attachedHandle, and after a vanish there either is none or, worse, one
  // that has since moved on to a different process. Leaving these entries in
  // `applied` would carry a dead process's addresses forward into whatever
  // attaches next — restoreAll() would then blindly write through a live
  // handle at an address it was never resolved against. Call this instead of
  // restoreAll() when the target process is already gone.
  forgetAll(): void {
    this.applied.clear()
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
    if (address === null)
      return { address: null, state: 'not-found', applicable: false, matchCount, reason: this.lastReason }

    const current = this.ops.readBytes(address, patch.length)
    // Resolved but unreadable: the address is still worth reporting — it
    // distinguishes "the code page went away" from "we never found it",
    // which look identical to a user staring at one error message.
    if (current === null) return { address, state: 'unreadable', applicable: false, matchCount }

    if (current.toLowerCase() === nopHex(patch.length))
      return { address, state: 'applied', applicable: true, matchCount }
    // replace mode's installed state is whatever replacementBytes says, not
    // a fixed NOP fill — same "already there, nothing to do" outcome as the
    // NOP check above, just for the mode where "applied" isn't 0x90 repeated.
    if (
      patchMode(patch) === 'replace' &&
      patch.replacementBytes !== undefined &&
      current.toLowerCase() === patch.replacementBytes.toLowerCase()
    ) {
      return { address, state: 'applied', applicable: true, matchCount }
    }
    // A jmp trampoline this engine instance isn't tracking: an injection
    // installed by a previous Tamper session (crash, or relaunch) is still
    // live in the game. We cannot restore it correctly (Finding 1's missing
    // run length) or adopt it (no recovered caveAddress either), so this
    // must fail closed and say why, rather than falling into 'mismatch's
    // generic message.
    if (patchMode(patch) !== 'nop' && !this.applied.has(patch.id) && current.toLowerCase().startsWith('e9')) {
      return { address, state: 'foreign-injection', applicable: false, matchCount }
    }
    // Mono-anchored patches have no meaningful stored byte signature to
    // verify against across sessions — see resolvePatchAddress's Path 0
    // comment in anchor.ts, which skips the same check for the same reason.
    // Mono's own class+method resolution already proved this is the right
    // method; whatever is actually there (once it's ruled out as already
    // NOP'd or a foreign jmp, above) is trusted as 'original' rather than
    // compared against a snapshot from a different process instance.
    const isMonoAnchored = patch.monoClass !== undefined && patch.monoMethod !== undefined
    if (isMonoAnchored || current.toLowerCase() === patch.originalBytes.toLowerCase()) {
      return { address, state: 'original', applicable: true, matchCount }
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
      // Re-resolve the arm pointer fresh for THIS install, rather than
      // trusting patch.armValue — which may be a snapshot from a previous
      // process instance (a prior game launch's player object, now gone).
      // Falls back to patch.armValue when the dynamic pair isn't set, or
      // this particular resolve fails (better to try a stale-but-present
      // value than refuse outright). guard patches need this exactly as
      // much as immune ones do — Scanner's own capture-based armValue is a
      // one-time snapshot of whichever object happened to be touched during
      // scanning (store.ts's own comment on armPointerClassName documents
      // guard falling back to self-arming, i.e. this pair was always meant
      // to cover it too; this condition just never included it).
      const isConditionalScale = mode === 'scale' && patch.compareMonoMethod !== undefined
      let armValueOverride: string | undefined
      if (
        (mode === 'immune' || mode === 'guard' || isConditionalScale) &&
        patch.armPointerClassName !== undefined &&
        patch.armPointerFieldName !== undefined &&
        this.monoOps?.resolvePointer
      ) {
        const monoDllBase = this.monoOps.monoDllBase()
        if (monoDllBase !== null) {
          const resolved = await this.monoOps.resolvePointer(
            monoDllBase,
            patch.armPointerClassName,
            patch.armPointerFieldName,
            patch.armPointerInstanceFieldName
          )
          if (resolved !== null) armValueOverride = resolved
        }
      } else if (
        (mode === 'immune' || mode === 'guard' || isConditionalScale) &&
        patch.armPointerModuleName !== undefined &&
        patch.armPointerBaseOffset !== undefined &&
        patch.armPointerOffsets !== undefined
      ) {
        const resolved = resolveChainPointer(
          this.ops,
          patch.armPointerModuleName,
          patch.armPointerBaseOffset,
          patch.armPointerOffsets
        )
        if (resolved !== null) armValueOverride = resolved
      }
      // Re-resolved fresh every install for the same reason armValueOverride
      // is: JIT code moves between game sessions, so a compareMonoMethod
      // address is only ever trustworthy from THIS process instance.
      let compareMethodAddress: string | undefined
      if (isConditionalScale && patch.monoClass !== undefined && this.monoOps) {
        const monoDllBase = this.monoOps.monoDllBase()
        if (monoDllBase !== null) {
          const classHandle = await this.monoOps.resolveClass(monoDllBase, patch.monoClass)
          if (classHandle !== null) {
            const resolved = await this.monoOps.compileMethod(
              monoDllBase,
              classHandle,
              patch.compareMonoMethod as string
            )
            if (resolved !== null) compareMethodAddress = resolved
          }
        }
      }
      const installed =
        mode === 'nop'
          ? this.installNop(patch, status.address)
          : mode === 'replace'
            ? this.installReplace(patch, status.address)
            : this.installInjection(patch, status.address, armValueOverride, compareMethodAddress)
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

  // In-place, equal-length byte substitution — see PatchCheat.replacementBytes'
  // doc in store.ts for why this exists as its own mode instead of overloading
  // 'nop' (fixed 0x90 fill only) or 'force'/'copy' (a cave-relocated jump,
  // more machinery than a same-length swap needs). Refuses rather than
  // guessing if replacementBytes is missing or the wrong length — writing the
  // wrong byte count either overruns into the next instruction or leaves some
  // of the original one behind, either of which corrupts code no restore can
  // undo cleanly since the "original" bytes to restore from come from
  // elsewhere (locate()'s own capture), not from what actually got written.
  private installReplace(patch: PatchCheat, address: string): InstallResult {
    const replacement = (patch.replacementBytes ?? '').toLowerCase()
    if (replacement.length !== patch.length * 2) {
      return {
        ok: false,
        error: `replace mode needs exactly ${patch.length} bytes of replacementBytes — got ${replacement.length / 2}.`,
        caveAddress: null,
        displaced: null
      }
    }
    if (!this.ops.writeBytes(address, replacement)) {
      return {
        ok: false,
        error: 'Write failed — the patch was not applied.',
        caveAddress: null,
        displaced: null
      }
    }
    return { ok: true, error: null, caveAddress: null, displaced: patch.originalBytes.toLowerCase() }
  }

  // Build the cave first, while nothing is redirected into it, then swap the
  // site under suspension. Ordering matters: a jump installed before its
  // cave holds valid code sends the game into garbage.
  //
  // `armValueOverride`, when provided, is used in place of patch.armValue —
  // the caller's freshly-resolved pointer for THIS install, see apply()'s
  // comment on why a stored armValue alone goes stale across game restarts.
  // `compareMethodAddress`, when provided, is a conditional scale's
  // freshly-resolved compareMonoMethod JIT address for THIS install — same
  // "resolve fresh every time, JIT code moves" reasoning as armValueOverride,
  // just for a method address instead of a field pointer.
  private installInjection(
    patch: PatchCheat,
    address: string,
    armValueOverride?: string,
    compareMethodAddress?: string
  ): InstallResult {
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
    // A conditional scale needs everything plain scale doesn't: the base
    // register to call compareMonoMethod on, the resolved method address
    // itself, and an armed comparison pointer — see store.ts's own comment
    // on compareMonoMethod for what this whole shape is for.
    const conditionalScale = mode === 'scale' && patch.compareMonoMethod !== undefined
    try {
      if ((mode !== 'scale' || conditionalScale) && typeof patch.baseRegister !== 'string') {
        throw new Error('missing base register')
      }
      // capture and guard both need only the register: capture records it,
      // guard compares against it. Neither writes a value of its own, so
      // demanding value/dataType/fieldOffset would reject them for lacking
      // fields they never use.
      if (mode === 'force') {
        if (
          typeof patch.value !== 'number' ||
          !patch.dataType ||
          (patch.dataType !== 'int32' && patch.dataType !== 'float')
        ) {
          // Force mode encodes the value as a 32-bit immediate (see
          // valueBits below and cave_ops.cc's encodeStore) — any other
          // width, including a legitimately-set int8/int16/int64/double,
          // would be silently mis-encoded rather than refused if this
          // check only looked for presence.
          throw new Error('missing or unencodable force-mode fields')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
      if (mode === 'copy') {
        // copy mode encodes "store whatever sourceRegister currently holds"
        // — no value/dataType to validate, since it never writes a fixed
        // immediate the way force does.
        if (
          typeof patch.sourceRegister !== 'string' ||
          !(patch.sourceRegister.toLowerCase() in GPR64_ALIASES)
        ) {
          // Unrecognized names must be refused HERE, before allocateCave —
          // native RegisterByName (cave_ops.cc) throws on an unknown name
          // too, but only once encodeStoreRegister runs in the effect
          // ternary below, which is after the cave is already allocated and
          // has no surrounding try/catch. Refusing early is what keeps a
          // bad sourceRegister from leaking a 4KB cave in the target
          // process.
          throw new Error('missing or unrecognized copy-mode source register')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
      if (mode === 'strip') {
        // strip writes several fields off the same baseRegister (already
        // required above), re-read live on every invocation — no
        // fieldOffset/value/dataType of its own to validate, only the
        // fields array. Each entry gets the exact same width check force's
        // single field already gets, for the exact same reason: EncodeStore
        // only ever writes a dword, so any other dataType would be silently
        // mis-encoded rather than refused.
        if (!Array.isArray(patch.fields) || patch.fields.length === 0) {
          throw new Error('missing or unencodable strip-mode fields')
        }
        for (const field of patch.fields) {
          if (
            typeof field.value !== 'number' ||
            (field.dataType !== 'int32' && field.dataType !== 'float')
          ) {
            throw new Error('missing or unencodable strip-mode fields')
          }
          BigInt(field.fieldOffset) // throws on unparsable hex
        }
      }
      if (mode === 'scale') {
        // scale never uses fieldOffset/baseRegister — only a recognized
        // xmm source register and a float multiplier.
        if (
          typeof patch.sourceRegister !== 'string' ||
          !(patch.sourceRegister.toLowerCase() in XMM_REGISTERS)
        ) {
          // Refused HERE, before allocateCave, for the same reason copy's
          // check above is: native XmmRegisterByName throws on an unknown
          // name too, but only once encodeScale runs in the effect ternary
          // below — after the cave is allocated, with no surrounding
          // try/catch, which leaks a 4KB cave in the target process.
          throw new Error('missing or unrecognized scale-mode source register')
        }
        if (typeof patch.value !== 'number' || patch.dataType !== 'float') {
          // Scale only multiplies a float register — int32 has no XMM
          // representation this mode's mulss could operate on.
          throw new Error('missing or unencodable scale-mode multiplier')
        }
        if (conditionalScale) {
          if (compareMethodAddress === undefined) {
            // Refused here rather than left to encodeConditionalScale: an
            // unresolved compareMonoMethod means the class/method didn't
            // resolve THIS install (game not far enough loaded, wrong
            // name) — a caller bug or a transient timing issue, not
            // something to guess an address for.
            throw new Error('compareMonoMethod did not resolve to a method address this install')
          }
          if ((armValueOverride ?? patch.armValue) === undefined) {
            throw new Error('conditional scale has no armed comparison pointer')
          }
        }
      }
    } catch {
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : mode === 'copy'
              ? "This patch is missing the register or offset a copy injection needs, its source register isn't a recognized register, or its offset isn't valid hex — can't compute what to write."
              : mode === 'scale'
                ? conditionalScale
                  ? "This conditional scale is missing its base register, source xmm register, multiplier, resolved compare-method address, or armed comparison pointer — can't compute what to write."
                  : "This patch is missing its source xmm register or its multiplier, or the source register isn't recognized — can't compute what to write."
                : mode === 'strip'
                  ? "This patch has no fields to write, or one of them has an unencodable data type or an offset that isn't valid hex — can't compute what to write."
                  : "This patch is missing the register, offset, value, or data type a force injection needs, its data type isn't int32/float (the only widths force mode can write), or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
      }
    }

    // guard's slot self-arms: the first entity through fills it, because
    // guard sits on a per-object shared write that runs once per entity, and
    // any entity reaching it is a legitimate candidate to arm on. immune sits
    // on a method's ENTRY — the first call through is essentially never the
    // player, so there is no safe self-arming moment to fall back to. An
    // immune patch must already carry the resolved player pointer (from the
    // Mono anchor this whole sub-project exists to reach), or refuse rather
    // than guess. armValueOverride — apply()'s fresh-this-install resolve —
    // takes priority over the patch's own possibly-stale armValue.
    const effectiveArmValue = armValueOverride ?? patch.armValue
    if (mode === 'immune' && effectiveArmValue === undefined) {
      return {
        ok: false,
        error: 'This immune patch has no player pointer recorded — re-capture it.',
        caveAddress: null,
        displaced: null
      }
    }

    if (mode === 'force' || mode === 'copy') {
      // patch.length must be exactly the byte length of the FIRST
      // instruction in the displaced run — decodeRun with minBytes=1
      // reports that length. A Mono-anchored patch's auto-filled length
      // (mono:resolveMethodBytes in ipc.ts) is a fixed snapshot size, not a
      // decoded instruction boundary, and can disagree with it. Slicing at
      // the wrong boundary starts the replayed run mid-instruction —
      // undefined behavior in a live game. Checked before allocateCave, like
      // every other pre-flight refusal above, so a bad patch never leaks an
      // allocated cave. copy replaces exactly one instruction the same way
      // force does, so it needs the same boundary guard.
      //
      // Note: run.length (the whole, possibly rounded-up displaced run) is
      // always >= a decodable firstInsn.length by construction of decodeRun
      // — it either equals firstInsn.length (nothing swallowed) or is
      // strictly greater (more instructions pulled in to reach the jmp's
      // minimum). So once this check passes, patch.length can never exceed
      // run.length, and patch.length === run.length simply means there is
      // nothing left to replay after the effect — a legitimate, common case
      // (see the base "writes a jump" test), not a bug. No separate
      // "patch.length >= run.length" guard is needed or correct here.
      const firstInsn = this.ops.decodeRun(address, 1)
      if (!firstInsn.decodable || firstInsn.length !== patch.length) {
        return {
          ok: false,
          error:
            "This patch's recorded length does not match a real instruction boundary at this address — re-capture it.",
          caveAddress: null,
          displaced: null
        }
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
    // the same whichever mode installed the cave. Conditional scale is the
    // one exception: its slot holds an armed 8-byte pointer AND 4 bytes of
    // factor bits (cave_ops.cc's EncodeConditionalScale comment has the
    // full layout), so its code starts 8 bytes further in.
    const codeAddress = addHex(cave, conditionalScale ? 16 : 8)

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
    const returnTo = addHex(address, run.length)

    // immune gets its own clearly-separated assembly rather than folding
    // into the replay/effect ternaries above: its "match" path does not
    // rejoin this replay/jumpBack shape at all — it returns from the WHOLE
    // METHOD (xor eax,eax; ret) the instant the this-pointer matches, never
    // touching the displaced bytes or the site at all. Only the NON-match
    // path behaves like every other mode's cave: replay the displaced run,
    // then jump back into the function's continuation. That is a real
    // structural difference from guard's early exit (which always re-enters
    // the function, on both of its paths), not just a naming difference —
    // reusing guard's branch here by adding `|| mode === 'immune'` would
    // silently give immune guard's "skip one write and continue" semantics
    // instead of "skip the whole method".
    let body: string
    if (mode === 'immune') {
      // encodeImmuneGuard's own returnAddress parameter is where its
      // NON-matching path falls through to — the replayed run that follows
      // it in the cave, not returnTo (which points back into the original
      // function; only the jump at the very end of this cave does that).
      // That fall-through address is codeAddress + the guard blob's own
      // length, which is only known once the blob exists — but the blob's
      // length does not depend on the VALUE given for returnAddress (only
      // the trailing jne's 4 immediate bytes do), so encode once with a
      // placeholder to learn the length, then again with the real address.
      // A forced return value (the Character:GetHealth shape, gated the same
      // way ApplyDamage's skip is) instead of the default bare-0 skip —
      // reuses `value`/`dataType`, the same fields `force` mode already
      // means "what to write", rather than inventing parallel ones. 'byte'
      // rides the same int32 path as any other non-float value: only the
      // low byte a bool-reading caller would look at differs from a real
      // byte-width store, and this is a register return, not a memory
      // write, so there is no wider field to accidentally clobber.
      const returnKind: 'int32' | 'float' | undefined =
        patch.value === undefined ? undefined : patch.dataType === 'float' ? 'float' : 'int32'
      const returnBits =
        patch.value === undefined ? undefined : valueBits(patch.value, patch.dataType ?? 'int32')
      const probe = this.ops.encodeImmuneGuard(
        cave,
        patch.baseRegister as string,
        codeAddress,
        codeAddress,
        returnKind,
        returnBits
      )
      const replayAddress = addHex(codeAddress, probe.length / 2)
      const guardBytes = this.ops.encodeImmuneGuard(
        cave,
        patch.baseRegister as string,
        codeAddress,
        replayAddress,
        returnKind,
        returnBits
      )
      const jumpBackFrom = addHex(replayAddress, displaced.length / 2)
      body = guardBytes + displaced + this.ops.encodeJump(jumpBackFrom, returnTo)
    } else {
      const replay =
        mode === 'capture' || mode === 'guard' || mode === 'scale' || mode === 'strip'
          ? displaced
          : displaced.slice(patch.length * 2)

      // The capture store is RIP-relative, so it must be encoded for the
      // address it actually executes at — codeAddress, now that it runs
      // first. Encoding it for anywhere else silently corrupts whatever the
      // wrong RIP-relative target happens to be.
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
            : mode === 'scale'
              ? conditionalScale
                ? // Same RIP-relative-to-codeAddress reasoning as plain
                  // scale below, plus the resolved compare-method address
                  // and the base register to call it on — normalized
                  // through GPR64_ALIASES the same way copy's sourceRegister
                  // already is, since a hand-edited games/*.json could name
                  // a 32-bit alias.
                  this.ops.encodeConditionalScale(
                    XMM_REGISTERS[(patch.sourceRegister as string).toLowerCase()],
                    GPR64_ALIASES[(patch.baseRegister as string).toLowerCase()],
                    compareMethodAddress as string,
                    codeAddress,
                    cave
                  )
                : // The multiplier lives in the cave's slot (written just
                  // below, before the body goes down) and the mulss reads it
                  // RIP-relative, so like the capture store this must be
                  // encoded for the address it actually executes at —
                  // codeAddress. XMM_REGISTERS supplies the exact-case name
                  // the native lookup matches on; passing patch.sourceRegister
                  // raw would let "XMM5" pass validation and then throw from
                  // inside the native call, after the cave already exists.
                  this.ops.encodeScale(
                    XMM_REGISTERS[(patch.sourceRegister as string).toLowerCase()],
                    codeAddress,
                    cave
                  )
              : mode === 'copy'
                ? this.ops.encodeStoreRegister(
                    patch.baseRegister as string,
                    Number(BigInt(patch.fieldOffset as string)),
                    GPR64_ALIASES[(patch.sourceRegister as string).toLowerCase()]
                  )
                : mode === 'strip'
                  ? // One encodeStore per field, off the same baseRegister,
                    // concatenated in declared order — jumpBackFrom below
                    // is already generic over effect.length, so a
                    // multi-instruction effect needs no further change.
                    (patch.fields as NonNullable<PatchCheat['fields']>)
                      .map((field) =>
                        this.ops.encodeStore(
                          patch.baseRegister as string,
                          Number(BigInt(field.fieldOffset)),
                          valueBits(field.value, field.dataType)
                        )
                      )
                      .join('')
                  : this.ops.encodeStore(
                      patch.baseRegister as string,
                      Number(BigInt(patch.fieldOffset as string)),
                      valueBits(patch.value as number, patch.dataType as DataType)
                    )
      const jumpBackFrom = addHex(codeAddress, effect.length / 2 + replay.length / 2)
      body = effect + replay + this.ops.encodeJump(jumpBackFrom, returnTo)
    }

    // scale's slot is not an arming slot — it holds the multiplier its mulss
    // reads RIP-relative out of the cave's first bytes (plain scale) or
    // second 4 bytes (conditional scale, whose first 8 bytes are the armed
    // comparison pointer instead — written in the guard/immune/conditional-
    // scale block just below). Written unconditionally for every scale
    // patch (there is no "unarmed" multiplier), and, like the arming write
    // below, before the body goes down: the cave must never be reachable
    // holding a zeroed factor, which would multiply the game's value by
    // 0.0 rather than leaving it alone.
    if (mode === 'scale') {
      const factorAddress = conditionalScale ? addHex(cave, 8) : cave
      if (!this.ops.writeBytes(factorAddress, bitsToSlotHex(valueBits(patch.value as number, 'float')))) {
        this.ops.freeCave(cave)
        return {
          ok: false,
          error: 'Failed to write the scale multiplier.',
          caveAddress: null,
          displaced: null
        }
      }
    }

    // Pre-arm the guard/immune/conditional-scale check before anything can
    // reach the cave. Self-arming takes whichever entity the game touches
    // first, and at a site that runs for every loaded creature that is
    // essentially never the player — a real session watched it lock onto a
    // stranger three times running. The capture already recorded the
    // register's value at the moment it wrote the address the user was
    // watching, which is by construction theirs. immune and conditional
    // scale have already refused above if effectiveArmValue is missing —
    // neither has a self-arming fallback the way guard does — so this
    // always fires for them once installation gets here.
    if ((mode === 'guard' || mode === 'immune' || conditionalScale) && effectiveArmValue) {
      if (!this.ops.writeBytes(cave, pointerToSlotHex(effectiveArmValue))) {
        this.ops.freeCave(cave)
        return {
          ok: false,
          error: mode === 'immune' ? 'Failed to arm the immune check.' : 'Failed to arm the guard.',
          caveAddress: null,
          displaced: null
        }
      }
    }

    if (!this.ops.writeBytes(codeAddress, body)) {
      this.ops.freeCave(cave)
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
        this.ops.freeCave(cave)
        return {
          ok: false,
          error: "Couldn't pause the game safely enough to redirect the instruction — not writing to running code.",
          caveAddress: null,
          displaced: null
        }
      }
      if (!this.ops.writeBytes(address, padded)) {
        this.ops.freeCave(cave)
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

  // Verified module arithmetic before scanning, delegated to anchor.ts — but
  // only once the caller has ever supplied real anchor context. Until
  // setAnchorContext is called, fall back to legacyResolveAddress: the
  // pre-verification behavior every already-saved patch (module-anchored
  // AND JIT) was resolving through, which trusts getModuleBase's live base
  // unconditionally and lets locate() verify the bytes downstream instead
  // of resolveAddress gating a scan fallback on them. Keeping that split —
  // rather than routing everything through resolvePatchAddress from the
  // start — is what keeps a module patch reported 'mismatch' at its
  // arithmetic address instead of being silently rescanned into 'not-found'
  // the moment its bytes stop matching, and keeps a 'not-found' PatchStatus
  // free of a `reason` the caller never asked for until anchor context
  // exists.
  //
  // The gate is on contextSet, NOT on whether this particular patch's
  // module is present/verified: a per-patch check would permanently strand
  // JIT patches (moduleName is always null, so it can never match a
  // per-module condition) and a loaded-but-unverified module (the "game
  // updated" case the whole anchor path exists for) on the legacy,
  // never-relearns path — even once the caller starts supplying context.
  // Once contextSet is true, every patch goes through resolvePatchAddress,
  // unconditionally, exactly as originally specified.
  private async resolveAddress(patch: PatchCheat): Promise<Resolution> {
    this.lastReason = undefined
    if (!this.contextSet) return this.legacyResolveAddress(patch)

    const result = await resolvePatchAddress(patch, this.modules, this.verified, this.ops, this.monoOps)
    if (result.relearnedOffset !== null && result.relearnedOffset !== patch.moduleOffset) {
      this.relearnCb?.(patch.id, result.relearnedOffset)
    }
    this.lastReason = result.reason ?? undefined
    return { address: result.address, matchCount: result.matchCount }
  }

  private async legacyResolveAddress(patch: PatchCheat): Promise<Resolution> {
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

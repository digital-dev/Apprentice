import type { PatchCheat } from './store'

// Everything PatchEngine needs from the target process. Injected rather
// than imported so the engine's locate/apply/restore logic — the part that
// must never write to a wrong or unverified address — can be tested
// exhaustively against a fake process (same style as FreezeLoop's writeFn).
export interface PatchOps {
  getModuleBase(moduleName: string): string | null
  readBytes(address: string, length: number): string | null
  writeBytes(address: string, hexBytes: string): boolean
  scanAob(signature: string): Promise<string[]>
}

export type PatchState = 'original' | 'applied' | 'not-found' | 'mismatch'

export interface PatchStatus {
  address: string | null
  state: PatchState
  // Safe to toggle on: we found it AND its bytes are what we expect.
  applicable: boolean
}

export function nopHex(length: number): string {
  return '90'.repeat(length)
}

interface AppliedPatch {
  address: string
  originalBytes: string
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
    const address = await this.resolveAddress(patch)
    if (address === null) return { address: null, state: 'not-found', applicable: false }

    const current = this.ops.readBytes(address, patch.length)
    if (current === null) return { address: null, state: 'not-found', applicable: false }

    const original = patch.originalBytes.toLowerCase()
    if (current.toLowerCase() === original) return { address, state: 'original', applicable: true }
    if (current.toLowerCase() === nopHex(patch.length))
      return { address, state: 'applied', applicable: true }
    // Something else lives there now — another trainer, an update, or a
    // wrong relocation. Never overwrite it.
    return { address, state: 'mismatch', applicable: false }
  }

  async apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }> {
    // Already applied: the recorded address is authoritative. Re-locating
    // here could resolve to a different address (JIT code moved) and
    // overwrite that record, orphaning the NOPs we already wrote — this is
    // a no-op success, not a re-patch.
    if (this.applied.has(patch.id)) return { ok: true, error: null }

    const status = await this.locate(patch)
    if (status.address === null || status.state === 'not-found') {
      return { ok: false, error: "Can't relocate this instruction in the running game." }
    }
    if (status.state === 'mismatch') {
      return {
        ok: false,
        error: "The bytes at that address don't match what was captured — not patching."
      }
    }

    if (status.state === 'original') {
      if (!this.ops.writeBytes(status.address, nopHex(patch.length))) {
        return { ok: false, error: 'Write failed — the patch was not applied.' }
      }
    }
    // 'applied' falls through: the NOPs are already there (e.g. we
    // re-attached to a process we had patched), so nothing needs writing —
    // but we must still record it so it gets restored.
    this.applied.set(patch.id, {
      address: status.address,
      // Normalize once here so restore() can never write a differently
      // cased blob than the one locate() compared against.
      originalBytes: patch.originalBytes.toLowerCase()
    })
    return { ok: true, error: null }
  }

  restore(patch: PatchCheat): boolean {
    const entry = this.applied.get(patch.id)
    if (!entry) return true // never applied — nothing to undo
    const ok = this.ops.writeBytes(entry.address, entry.originalBytes)
    if (ok) this.applied.delete(patch.id)
    return ok
  }

  // Detach / app quit: put every patched instruction back. A failed write
  // here is ignored — it means the process is already gone, and its code
  // went with it. The set is cleared either way so a later attach starts
  // from a clean slate.
  restoreAll(): void {
    for (const entry of this.applied.values()) {
      this.ops.writeBytes(entry.address, entry.originalBytes)
    }
    this.applied.clear()
  }

  private async resolveAddress(patch: PatchCheat): Promise<string | null> {
    if (patch.moduleName !== null && patch.moduleOffset !== null) {
      const base = this.ops.getModuleBase(patch.moduleName)
      if (base === null) return null
      // PatchCheat isn't runtime-validated — a hand-edited games/*.json can
      // carry a malformed offset. BigInt() throws SyntaxError on that
      // rather than failing gracefully, so treat it as unresolvable.
      try {
        return '0x' + (BigInt(base) + BigInt(patch.moduleOffset)).toString(16)
      } catch {
        return null
      }
    }
    // JIT / anonymous code: only a signature can find it again. Anything
    // other than exactly one match is ambiguous, and a guess here means
    // NOPping an unknown instruction.
    const matches = await this.ops.scanAob(patch.signature)
    if (matches.length !== 1) return null
    return matches[0]
  }
}

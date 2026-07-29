import type { AnchorReason } from './anchor'
import type { PatchCheat } from './store'

export type CheatState = 'idle' | 'arming' | 'active' | 'degraded' | 'failed'

export interface CheatStatus {
  state: CheatState
  // Describes the BUILD, not the cheat's progress: a cheat whose module
  // fingerprint changed but whose bytes still verify is perfectly active
  // and merely flagged. That is why this is a flag and not a state.
  unverified: boolean
  reason: AnchorReason | null
  address: string | null
  attempts: number
}

export interface RuntimeDeps {
  locate(patch: PatchCheat): Promise<{ address: string | null; reason: AnchorReason | null }>
  apply(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }>
  restore(patch: PatchCheat): void
  isVerified(patch: PatchCheat): boolean
}

// Injected so backoff is testable by its scheduled delay instead of by
// waiting out five seconds of real time.
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export const BACKOFF_BASE_MS = 250
export const BACKOFF_CAP_MS = 5000

// Waiting fixes these: Mono has not compiled the method yet, a DLL has not
// loaded yet, the code has not appeared yet. Everything else — an ambiguous
// signature, bytes that are not what we captured — is a fact about the
// build that will not change by trying again, and retrying it would spin
// forever behind a chip that says "arming".
const RETRYABLE: AnchorReason[] = ['not-yet-compiled', 'no-match', 'module-missing']

function idle(): CheatStatus {
  return { state: 'idle', unverified: false, reason: null, address: null, attempts: 0 }
}

export class CheatRuntime {
  private deps: RuntimeDeps
  private clock: Clock
  private states = new Map<string, CheatStatus>()
  private timers = new Map<string, unknown>()
  private armed = new Map<string, PatchCheat>()
  private changeCb: ((patchId: string, status: CheatStatus) => void) | null = null

  constructor(deps: RuntimeDeps, clock: Clock = realClock) {
    this.deps = deps
    this.clock = clock
  }

  onChange(cb: (patchId: string, status: CheatStatus) => void): void {
    this.changeCb = cb
  }

  status(patchId: string): CheatStatus {
    return this.states.get(patchId) ?? idle()
  }

  private set(patchId: string, next: Partial<CheatStatus>): void {
    const merged = { ...this.status(patchId), ...next }
    this.states.set(patchId, merged)
    this.changeCb?.(patchId, merged)
  }

  arm(patch: PatchCheat): void {
    const current = this.status(patch.id).state
    if (current === 'arming' || current === 'active' || current === 'degraded') return
    this.armed.set(patch.id, patch)
    this.set(patch.id, {
      state: 'arming',
      unverified: !this.deps.isVerified(patch),
      reason: null,
      address: null,
      attempts: 0
    })
    void this.attempt(patch)
  }

  disarm(patchId: string, patch?: PatchCheat): void {
    this.cancelTimer(patchId)
    this.armed.delete(patchId)
    const target = patch ?? undefined
    if (target) this.deps.restore(target)
    this.states.set(patchId, idle())
    this.changeCb?.(patchId, idle())
  }

  markDegraded(patchId: string): void {
    if (this.status(patchId).state !== 'active') return
    this.set(patchId, { state: 'degraded' })
  }

  markRecovered(patchId: string): void {
    if (this.status(patchId).state !== 'degraded') return
    this.set(patchId, { state: 'active' })
  }

  // The game is gone. Everything resets to idle and every retry is
  // cancelled — deliberately WITHOUT restoring, because the process that
  // held the patched code no longer exists and writing to a dead handle is
  // pointless at best.
  processExited(): void {
    for (const id of Array.from(this.states.keys())) {
      this.cancelTimer(id)
      this.states.set(id, idle())
      this.changeCb?.(id, idle())
    }
    this.armed.clear()
  }

  private cancelTimer(patchId: string): void {
    const timer = this.timers.get(patchId)
    if (timer !== undefined) {
      this.clock.clearTimeout(timer)
      this.timers.delete(patchId)
    }
  }

  private async attempt(patch: PatchCheat): Promise<void> {
    if (!this.armed.has(patch.id)) return
    const attempts = this.status(patch.id).attempts + 1
    const located = await this.deps.locate(patch)
    if (!this.armed.has(patch.id)) return // disarmed while we were away

    if (located.address === null) {
      const retryable = located.reason !== null && RETRYABLE.includes(located.reason)
      if (!retryable) {
        this.set(patch.id, { state: 'failed', reason: located.reason, attempts })
        return
      }
      this.set(patch.id, { state: 'arming', reason: located.reason, attempts })
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)
      this.timers.set(
        patch.id,
        this.clock.setTimeout(() => {
          this.timers.delete(patch.id)
          void this.attempt(patch)
        }, delay)
      )
      return
    }

    const applied = await this.deps.apply(patch)
    if (!this.armed.has(patch.id)) return
    if (!applied.ok) {
      this.set(patch.id, { state: 'failed', reason: null, address: located.address, attempts })
      return
    }
    this.set(patch.id, { state: 'active', reason: null, address: located.address, attempts })
  }
}

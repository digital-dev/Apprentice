import type { CheatDefinition } from './store'

// Must never reject — a write attempt that failed has to surface as
// `false`, the same as it always has, not as a thrown/rejected promise.
// tick() dispatches every active cheat's write in the same tick and awaits
// them together (see tick()'s Promise.all): one rejected write would take
// the whole batch down with it, breaking every OTHER cheat's result that
// tick too.
export type WriteFn = (cheat: CheatDefinition) => Promise<boolean>

// ~2 seconds at the default 100ms tick. A cheat's write can legitimately
// fail for a moment — during a load screen, a respawn, or a map transition
// the pointer it resolves through is briefly null. Flagging it broken on
// the first failed tick produces constant false alarms; waiting for a run
// of consecutive failures distinguishes a genuine dead chain from a
// transient one.
const DEFAULT_DEGRADE_AFTER_TICKS = 20

export class FreezeLoop {
  private writeFn: WriteFn
  private intervalMs: number
  private degradeAfterTicks: number
  private timer: ReturnType<typeof setInterval> | null = null
  private active = new Map<string, CheatDefinition>()
  // Consecutive failed ticks per active cheat (reset to 0 on any success).
  private failCounts = new Map<string, number>()
  // Cheats currently flagged degraded (all targets failing past the
  // threshold). They stay ACTIVE and keep being retried — this is what
  // lets them self-heal once the game state comes back.
  private degraded = new Set<string>()
  private degradedCb: ((cheatId: string) => void) | null = null
  private recoveredCb: ((cheatId: string) => void) | null = null

  constructor(writeFn: WriteFn, intervalMs = 100, degradeAfterTicks = DEFAULT_DEGRADE_AFTER_TICKS) {
    this.writeFn = writeFn
    this.intervalMs = intervalMs
    this.degradeAfterTicks = degradeAfterTicks
  }

  enable(cheat: CheatDefinition): void {
    this.active.set(cheat.id, cheat)
    this.failCounts.set(cheat.id, 0)
    this.degraded.delete(cheat.id)
  }

  disable(cheatId: string): void {
    this.active.delete(cheatId)
    this.failCounts.delete(cheatId)
    this.degraded.delete(cheatId)
  }

  // Fired once when a cheat crosses from healthy to degraded (all targets
  // have failed for degradeAfterTicks consecutive ticks).
  onDegraded(cb: (cheatId: string) => void): void {
    this.degradedCb = cb
  }

  // Fired once when a previously-degraded cheat writes successfully again.
  onRecovered(cb: (cheatId: string) => void): void {
    this.recoveredCb = cb
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // WriteFn is contractually non-rejecting (see its doc comment), so
      // this catch only guards against something slipping through that
      // contract — it must never take the interval down.
      void this.tick().catch((err) => console.warn(`[freezeLoop] tick failed: ${String(err)}`))
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Every active cheat's write is STARTED in the same synchronous pass
  // (calling writeFn for each cheat before awaiting any of them), matching
  // the old dispatch-all-at-once-per-tick behavior, then awaited together.
  // Awaiting them one at a time instead would let one slow-resolving write
  // (e.g. a Mono target's two-hop resolve) push out every other cheat's
  // write that tick, degrading the effective tick rate for everyone the
  // moment any slow target is in the mix — this keeps the tick bounded by
  // the slowest single write, not the sum of all of them.
  private async tick(): Promise<void> {
    const cheats = Array.from(this.active.values())
    const pending = cheats.map((cheat) => this.writeFn(cheat))
    const results = await Promise.all(pending)

    cheats.forEach((cheat, i) => {
      const ok = results[i]
      if (ok) {
        this.failCounts.set(cheat.id, 0)
        if (this.degraded.delete(cheat.id)) {
          this.recoveredCb?.(cheat.id)
        }
      } else {
        const next = (this.failCounts.get(cheat.id) ?? 0) + 1
        this.failCounts.set(cheat.id, next)
        if (next >= this.degradeAfterTicks && !this.degraded.has(cheat.id)) {
          this.degraded.add(cheat.id)
          this.degradedCb?.(cheat.id)
        }
        // Note: the cheat is intentionally NOT removed from `active`. It
        // keeps being retried every tick so it can self-heal.
      }
    })
  }
}

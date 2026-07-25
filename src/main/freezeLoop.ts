import type { CheatDefinition } from './store'

export type WriteFn = (cheat: CheatDefinition) => boolean

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
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    for (const cheat of Array.from(this.active.values())) {
      const ok = this.writeFn(cheat)
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
    }
  }
}

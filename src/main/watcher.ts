export interface WatcherDeps {
  listProcesses(): { pid: number; name: string }[]
  hasProfile(exeName: string): boolean
}

export interface IntervalClock {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realClock: IntervalClock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

// Slow enough to be invisible in CPU terms, fast enough that a game is
// picked up before the player has finished the loading screen.
export const POLL_INTERVAL_MS = 2000

// Notices games we have cheats for coming and going. It attaches; it NEVER
// writes. Auto-attaching is a convenience — auto-arming into a build nobody
// has verified is a way to corrupt a save file unattended.
export class ProcessWatcher {
  private deps: WatcherDeps
  private clock: IntervalClock
  private timer: unknown = null
  private current: { pid: number; name: string } | null = null
  private appearCb: ((proc: { pid: number; name: string }) => void) | null = null
  private vanishCb: ((proc: { pid: number; name: string }) => void) | null = null

  constructor(deps: WatcherDeps, clock: IntervalClock = realClock) {
    this.deps = deps
    this.clock = clock
  }

  onAppear(cb: (proc: { pid: number; name: string }) => void): void {
    this.appearCb = cb
  }

  onVanish(cb: (proc: { pid: number; name: string }) => void): void {
    this.vanishCb = cb
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = this.clock.setInterval(() => this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearInterval(this.timer)
    this.timer = null
  }

  tick(): void {
    let processes: { pid: number; name: string }[]
    try {
      processes = this.deps.listProcesses()
    } catch {
      // A failed snapshot is a transient OS condition, not a reason to stop
      // watching. Skip this tick.
      return
    }

    // hasProfile is expected to be total (see ipc.ts's wiring, which is
    // careful to catch loadProfile's deliberate throw on a malformed
    // games/*.json), but this poll runs forever on a 2-second timer with no
    // one watching for an unhandled rejection to fix it — a single bad
    // implementation must not crash the process. Same belt-and-suspenders
    // treatment as listProcesses just above.
    let match: { pid: number; name: string } | null = null
    try {
      match = processes.find((p) => this.deps.hasProfile(p.name)) ?? null
    } catch {
      return
    }

    if (this.current !== null && (match === null || match.pid !== this.current.pid)) {
      const gone = this.current
      this.current = null
      this.vanishCb?.(gone)
    }
    if (match !== null && this.current === null) {
      this.current = match
      this.appearCb?.(match)
    }
  }
}

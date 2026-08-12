import type { ScriptCheat } from './store'

export type LuaValue = string | number | boolean
export type RunScriptFn = (
  source: string,
  stateIn: Record<string, LuaValue>
) => Promise<{
  success: boolean
  output: string[]
  error: string | null
  stateOut: Record<string, LuaValue>
}>

// At most this many script runs may be in flight at once across the WHOLE
// app — every cheat, plus ScriptEditor's ad-hoc "Run enable now" button.
export const MAX_CONCURRENT_SCRIPT_RUNS = 2

export const SCRIPT_RUN_CAP_ERROR =
  'Too many scripts are already running — wait for one to finish or restart Apprentice if one is stuck.'

// KNOWN, ACCEPTED LIMITATION — read before raising this cap.
//
// The 5-second timeout is delivered as an ordinary Lua error, so a script
// that wraps an infinite loop in pcall swallows it and spins forever. The
// run is still reported honestly as failed (see script_ops.cc's sticky
// timeout), but the libuv worker thread it is running on NEVER comes back:
// it is lost for the lifetime of the process. Killing that thread or tearing
// down its Lua state from outside is not safe, and is explicitly out of
// scope here — it is a known follow-up, not something this cap fixes.
//
// What the cap does is bound the damage. libuv's threadpool is shared with
// every other native async operation in this app (scanFirst, scanAob,
// resolvePointerChain, callRemoteFunction), so leaked script threads used to
// be able to consume it entirely — after four of them, scanning simply hung
// forever with nothing shown to the user. With UV_THREADPOOL_SIZE raised to
// 16 in main/index.ts and at most 2 runs in flight here, at most 2 of those
// 16 threads can ever be lost to a stuck script, leaving 14 for everything
// else.
//
// Deliberately a shared object rather than per-ScriptRuntime state: ipc.ts's
// `scripts:run` handler does not go through ScriptRuntime.run() at all, and
// must count against the same budget.
export class ScriptRunLimiter {
  private inFlight = 0

  tryAcquire(): boolean {
    if (this.inFlight >= MAX_CONCURRENT_SCRIPT_RUNS) return false
    this.inFlight++
    return true
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight--
  }
}

// Mirrors FreezeLoop's shape (an enabled-set, isEnabled), but unlike
// FreezeLoop.enable/disable — synchronous and cannot fail — a script run
// is async and can fail (a Lua runtime error or the native timeout). The
// enabled set is updated only on success, never optimistically, and a
// per-cheat in-flight guard makes a second toggle while one is still
// running a no-op rather than launching an overlapping run. `state` is
// the enable->disable value handoff the spec requires (e.g.
// `state.original = readInt32(addr)` in enableScript, read back in
// disableScript) — held per-cheat in-memory only, never persisted.
export class ScriptRuntime {
  private runScript: RunScriptFn
  private enabled = new Set<string>()
  private inFlight = new Set<string>()
  private state = new Map<string, Record<string, LuaValue>>()
  private limiter: ScriptRunLimiter

  // `limiter` is injectable so ipc.ts's `scripts:run` handler — which
  // bypasses run() entirely — can share one budget with every cheat toggle.
  // Defaulting to a fresh one keeps each ScriptRuntime independent in tests.
  constructor(runScript: RunScriptFn, limiter: ScriptRunLimiter = new ScriptRunLimiter()) {
    this.runScript = runScript
    this.limiter = limiter
  }

  isEnabled(cheatId: string): boolean {
    return this.enabled.has(cheatId)
  }

  async enable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }> {
    return this.run(cheat, cheat.enableScript, true)
  }

  async disable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }> {
    return this.run(cheat, cheat.disableScript, false)
  }

  // Detach/vanish/quit: the process handle is dead, so running
  // disableScript is pointless — just forget this cheat was enabled AND
  // discard its state (a fresh attach's enable script should not see a
  // stale value captured from a previous, now-dead process instance).
  clear(cheatId: string): void {
    this.enabled.delete(cheatId)
    this.inFlight.delete(cheatId)
    this.state.delete(cheatId)
  }

  private async run(
    cheat: ScriptCheat,
    source: string,
    markEnabledOnSuccess: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.inFlight.has(cheat.id)) {
      return { ok: false, error: 'A run is already in progress for this cheat.' }
    }
    // The per-cheat guard above stops the SAME cheat double-running; this
    // global cap stops too many DIFFERENT runs collectively eating the
    // threadpool. See ScriptRunLimiter's note on the leak it bounds.
    if (!this.limiter.tryAcquire()) {
      return { ok: false, error: SCRIPT_RUN_CAP_ERROR }
    }
    this.inFlight.add(cheat.id)
    try {
      const stateIn = this.state.get(cheat.id) ?? {}
      const result = await this.runScript(source, stateIn)
      if (result.success) {
        this.state.set(cheat.id, result.stateOut)
        if (markEnabledOnSuccess) this.enabled.add(cheat.id)
        else this.enabled.delete(cheat.id)
        return { ok: true }
      }
      return { ok: false, error: result.error ?? 'Script failed.' }
    } finally {
      this.inFlight.delete(cheat.id)
      this.limiter.release()
    }
  }
}

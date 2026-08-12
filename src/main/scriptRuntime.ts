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

  constructor(runScript: RunScriptFn) {
    this.runScript = runScript
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
    }
  }
}

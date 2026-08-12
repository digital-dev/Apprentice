import { describe, it, expect, vi } from 'vitest'
import {
  ScriptRuntime,
  ScriptRunLimiter,
  SCRIPT_RUN_CAP_ERROR
} from '../../src/main/scriptRuntime'
import type { ScriptCheat } from '../../src/main/store'

const cheat: ScriptCheat = {
  kind: 'script',
  id: 'double-health',
  name: 'Double Health',
  enableScript: 'writeInt32(0x1000, readInt32(0x1000) * 2)',
  disableScript: ''
}

describe('ScriptRuntime', () => {
  it('runs enableScript and marks the cheat enabled on success', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    expect(runtime.isEnabled(cheat.id)).toBe(false)

    const result = await runtime.enable(cheat)

    expect(result.ok).toBe(true)
    expect(runtime.isEnabled(cheat.id)).toBe(true)
    expect(runScript).toHaveBeenCalledWith(cheat.enableScript, {})
  })

  it('does not mark the cheat enabled when the script fails', async () => {
    const runScript = vi.fn().mockResolvedValue({
      success: false,
      output: [],
      error: 'boom',
      stateOut: {}
    })
    const runtime = new ScriptRuntime(runScript)

    const result = await runtime.enable(cheat)

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    expect(runtime.isEnabled(cheat.id)).toBe(false)
  })

  it('disable runs disableScript and clears the enabled flag on success', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    await runtime.enable(cheat)

    const result = await runtime.disable(cheat)

    expect(result.ok).toBe(true)
    expect(runtime.isEnabled(cheat.id)).toBe(false)
    expect(runScript).toHaveBeenLastCalledWith(cheat.disableScript, {})
  })

  it('a failed disable leaves the cheat enabled, not optimistically cleared', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    await runtime.enable(cheat)

    runScript.mockResolvedValueOnce({ success: false, output: [], error: 'disable failed', stateOut: {} })
    const result = await runtime.disable(cheat)

    expect(result.ok).toBe(false)
    expect(runtime.isEnabled(cheat.id)).toBe(true)
  })

  it('ignores a second concurrent toggle while one is still in flight', async () => {
    let resolveFirst: (v: {
      success: boolean
      output: string[]
      error: string | null
      stateOut: Record<string, string | number | boolean>
    }) => void
    const runScript = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )
    const runtime = new ScriptRuntime(runScript)

    const first = runtime.enable(cheat)
    const second = runtime.enable(cheat) // should be a no-op, not a second run

    resolveFirst!({ success: true, output: [], error: null, stateOut: {} })
    await Promise.all([first, second])

    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('clear() resets the enabled flag without running disableScript', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)
    await runtime.enable(cheat)

    runtime.clear(cheat.id)

    expect(runtime.isEnabled(cheat.id)).toBe(false)
    expect(runScript).toHaveBeenCalledTimes(1) // only the original enable call
  })

  it('passes enableScript\'s stateOut as disableScript\'s stateIn', async () => {
    const runScript = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: { original: 42 } })
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)

    await runtime.enable(cheat)
    await runtime.disable(cheat)

    expect(runScript).toHaveBeenNthCalledWith(1, cheat.enableScript, {})
    expect(runScript).toHaveBeenNthCalledWith(2, cheat.disableScript, { original: 42 })
  })

  // The per-cheat guard above only stops the SAME cheat double-running. This
  // global cap is what stops several DIFFERENT stuck scripts from eating the
  // whole libuv threadpool — see ScriptRunLimiter's note.
  describe('global concurrency cap', () => {
    const other = (id: string): ScriptCheat => ({ ...cheat, id })

    it('rejects a third concurrent run across different cheats', async () => {
      const runScript = vi.fn().mockReturnValue(new Promise(() => {})) // never resolves
      const runtime = new ScriptRuntime(runScript)

      void runtime.enable(other('a'))
      void runtime.enable(other('b'))
      const third = await runtime.enable(other('c'))

      expect(third.ok).toBe(false)
      expect(third.error).toBe(SCRIPT_RUN_CAP_ERROR)
      // The rejected run must never reach the native layer at all.
      expect(runScript).toHaveBeenCalledTimes(2)
    })

    it('frees a slot again once a run finishes', async () => {
      const resolvers: ((v: unknown) => void)[] = []
      const runScript = vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
      const runtime = new ScriptRuntime(runScript)

      const first = runtime.enable(other('a'))
      void runtime.enable(other('b'))
      expect((await runtime.enable(other('c'))).ok).toBe(false)

      resolvers[0]({ success: true, output: [], error: null, stateOut: {} })
      await first

      // Deliberately not awaited: this run is allowed to start but its fake
      // never resolves. That it reached runScript at all is the point.
      void runtime.enable(other('c'))
      expect(runScript).toHaveBeenCalledTimes(3)
    })

    it('shares one budget across ScriptRuntime instances given the same limiter', async () => {
      const runScript = vi.fn().mockReturnValue(new Promise(() => {}))
      const limiter = new ScriptRunLimiter()
      const a = new ScriptRuntime(runScript, limiter)
      const b = new ScriptRuntime(runScript, limiter)

      void a.enable(other('a'))
      void a.enable(other('b'))
      const blocked = await b.enable(other('c'))

      expect(blocked.ok).toBe(false)
      expect(blocked.error).toBe(SCRIPT_RUN_CAP_ERROR)
    })
  })

  it('clear() also discards the cheat\'s stored state', async () => {
    const runScript = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: { original: 42 } })
      .mockResolvedValueOnce({ success: true, output: [], error: null, stateOut: {} })
    const runtime = new ScriptRuntime(runScript)

    await runtime.enable(cheat)
    runtime.clear(cheat.id)
    await runtime.disable(cheat)

    expect(runScript).toHaveBeenNthCalledWith(2, cheat.disableScript, {})
  })
})

import { describe, it, expect, vi } from 'vitest'
import { ScriptRuntime } from '../../src/main/scriptRuntime'
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

// One harness process for the whole file (matching memory_ops.test.ts's
// single top-level beforeAll): runScript now always takes a real handle,
// since the memory/resolvePointer bindings read it from the Lua registry.
describe('runScript', () => {
  let harness: ChildProcessWithoutNullStreams
  let handle: number

  function send(cmd: string): Promise<string> {
    return new Promise((resolve) => {
      harness.stdout.once('data', (d) => resolve(d.toString().trim()))
      harness.stdin.write(cmd + '\n')
    })
  }

  beforeAll(async () => {
    harness = spawn(path.resolve('test-harness/harness.exe'))
    await new Promise((r) => harness.stdout.once('data', r))
    handle = (addon as any).attach(harness.pid).handle
  })

  afterAll(() => {
    harness.stdin.write('q\n')
    harness.kill()
  })

  it('runs a trivial script and captures print output', async () => {
    const result = await (addon as any).runScript(handle, 'print("hello", 1, 2)', {})
    expect(result.success).toBe(true)
    expect(result.output).toEqual(['hello\t1\t2'])
  })

  it('reports a syntax error without throwing', async () => {
    const result = await (addon as any).runScript(handle, 'this is not lua', {})
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('reports a runtime error without throwing', async () => {
    const result = await (addon as any).runScript(handle, 'error("boom")', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('does not expose os.execute, os.exit, io, package, or debug', async () => {
    const result = await (addon as any).runScript(
      handle,
      `print(os.execute == nil, os.exit == nil, io == nil, package == nil, debug == nil)`,
      {}
    )
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('true\ttrue\ttrue\ttrue\ttrue')
  })

  it('does not expose dofile, loadfile, load, or collectgarbage', async () => {
    const result = await (addon as any).runScript(
      handle,
      'print(dofile == nil, loadfile == nil, load == nil, collectgarbage == nil)',
      {}
    )
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('true\ttrue\ttrue\ttrue')
  })

  it('times out an infinite loop within roughly the 5-second cap', async () => {
    const start = Date.now()
    const result = await (addon as any).runScript(handle, 'while true do end', {})
    const elapsed = Date.now() - start
    expect(result.success).toBe(false)
    expect(result.error).toContain('execution limit')
    expect(elapsed).toBeLessThan(7000)
  }, 10000)

  // The timeout is delivered as an ordinary Lua error, which a script can
  // catch with pcall. It must still be reported as a failed run: a script
  // that swallows the timeout and returns normally must not come back as
  // `success: true`.
  it('still reports failure when the script swallows the timeout with pcall', async () => {
    const result = await (addon as any).runScript(
      handle,
      `
      local ok, err = pcall(function() while true do end end)
      -- swallowed on purpose: ok is false, err is the timeout message,
      -- and this chunk goes on to finish "successfully".
      swallowed = not ok
    `,
      {}
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('execution limit')
  }, 10000)

  it('caps captured output at 1000 lines and marks it truncated', async () => {
    const result = await (addon as any).runScript(
      handle,
      'for i = 1, 1500 do print(i) end',
      {}
    )
    expect(result.success).toBe(true)
    // 1000 real lines plus the truncation marker.
    expect(result.output.length).toBe(1001)
    expect(result.output[0]).toBe('1')
    expect(result.output[999]).toBe('1000')
    expect(result.output[1000]).toBe('... output truncated at 1000 lines ...')
  })

  it('raises a clean error instead of exhausting memory on an allocation loop', async () => {
    const result = await (addon as any).runScript(
      handle,
      'local s = "" while true do s = s .. string.rep("x", 1024) end',
      {}
    )
    expect(result.success).toBe(false)
  }, 10000)

  it('writes an int32 via Lua and the harness confirms it', async () => {
    let candidates = await (addon as any).scanFirst(handle, 'int32', 100)
    await send('set 55')
    candidates = (addon as any).scanNext(handle, candidates, 'int32', { mode: 'exact', value: 55 })
    expect(candidates.length).toBe(1)
    const address = parseInt(candidates[0].address, 16)

    const result = await (addon as any).runScript(handle, `writeInt32(${address}, 999)`, {})
    expect(result.success).toBe(true)

    const reply = await send('get')
    expect(reply).toBe('OK 999')
  })

  it('reads a value via Lua matching a direct native readValue', async () => {
    const candidates = await (addon as any).scanFirst(handle, 'int16', 12345)
    expect(candidates.length).toBeGreaterThan(0)
    const address = parseInt(candidates[0].address, 16)

    const result = await (addon as any).runScript(handle, `print(readInt16(${address}))`, {})
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('12345')
  })

  it('resolvePointer matches getModuleBase + arithmetic for a zero-offset chain', async () => {
    const moduleName = 'harness.exe'
    const base = (addon as any).getModuleBase(handle, moduleName)
    const result = await (addon as any).runScript(
      handle,
      `print(resolvePointer("${moduleName}", {0x10}))`,
      {}
    )
    expect(result.success).toBe(true)
    // getModuleBase returns a "0x…" string; resolvePointer prints a decimal
    // Lua integer.
    expect(BigInt(result.output[0])).toBe(BigInt(base) + 0x10n)
  })

  it('round-trips a value through state between two separate runScript calls', async () => {
    const first = await (addon as any).runScript(handle, 'state.original = 42', {})
    expect(first.stateOut.original).toBe(42)

    const second = await (addon as any).runScript(
      handle,
      'print(state.original)',
      first.stateOut
    )
    expect(second.output[0]).toBe('42')
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

describe('runScript — sandbox', () => {
  it('runs a trivial script and captures print output', () => {
    const result = (addon as any).runScript(0, 'print("hello", 1, 2)')
    expect(result.success).toBe(true)
    expect(result.output).toEqual(['hello\t1\t2'])
  })

  it('reports a syntax error without throwing', () => {
    const result = (addon as any).runScript(0, 'this is not lua')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('reports a runtime error without throwing', () => {
    const result = (addon as any).runScript(0, 'error("boom")')
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('does not expose os.execute, os.exit, io, package, or debug', () => {
    const result = (addon as any).runScript(0, `
      local blocked = {
        pcall(function() return os.execute end),
        pcall(function() return os.exit end),
        pcall(function() return io end),
        pcall(function() return package end),
        pcall(function() return debug end),
      }
      for _, ok in ipairs(blocked) do
        -- each entry is (ok, value) from pcall; a nil global is not an
        -- error in Lua (indexing a nonexistent global just yields nil),
        -- so check the VALUE is nil, not that pcall failed.
      end
      print(os.execute == nil, os.exit == nil, io == nil, package == nil, debug == nil)
    `)
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('true\ttrue\ttrue\ttrue\ttrue')
  })

  it('does not expose dofile, loadfile, load, or collectgarbage', () => {
    const result = (addon as any).runScript(
      0,
      'print(dofile == nil, loadfile == nil, load == nil, collectgarbage == nil)'
    )
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('true\ttrue\ttrue\ttrue')
  })

  it('times out an infinite loop within roughly the 5-second cap', () => {
    const start = Date.now()
    const result = (addon as any).runScript(0, 'while true do end')
    const elapsed = Date.now() - start
    expect(result.success).toBe(false)
    expect(result.error).toContain('execution limit')
    expect(elapsed).toBeLessThan(7000)
  }, 10000)

  // The timeout is delivered as an ordinary Lua error, which a script can
  // catch with pcall. It must still be reported as a failed run: a script
  // that swallows the timeout and returns normally must not come back as
  // `success: true`. (This does not stop the script spinning — a
  // pcall-wrapped infinite loop still blocks until the worker-thread abort
  // arrives in Task 4 — it only guarantees the reported outcome is honest.)
  it('still reports failure when the script swallows the timeout with pcall', () => {
    const result = (addon as any).runScript(0, `
      local ok, err = pcall(function() while true do end end)
      -- swallowed on purpose: ok is false, err is the timeout message,
      -- and this chunk goes on to finish "successfully".
      swallowed = not ok
    `)
    expect(result.success).toBe(false)
    expect(result.error).toContain('execution limit')
  }, 10000)

  it('caps captured output at 1000 lines and marks it truncated', () => {
    const result = (addon as any).runScript(0, 'for i = 1, 1500 do print(i) end')
    expect(result.success).toBe(true)
    // 1000 real lines plus the truncation marker.
    expect(result.output.length).toBe(1001)
    expect(result.output[0]).toBe('1')
    expect(result.output[999]).toBe('1000')
    expect(result.output[1000]).toBe('... output truncated at 1000 lines ...')
  })

  it('raises a clean error instead of exhausting memory on an allocation loop', () => {
    const result = (addon as any).runScript(
      0,
      'local s = "" while true do s = s .. string.rep("x", 1024) end'
    )
    expect(result.success).toBe(false)
  }, 10000)
})

describe('runScript — memory bindings', () => {
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

  it('writes an int32 via Lua and the harness confirms it', async () => {
    let candidates = await (addon as any).scanFirst(handle, 'int32', 100)
    await send('set 55')
    candidates = (addon as any).scanNext(handle, candidates, 'int32', { mode: 'exact', value: 55 })
    expect(candidates.length).toBe(1)
    const address = parseInt(candidates[0].address, 16)

    const result = (addon as any).runScript(handle, `writeInt32(${address}, 999)`)
    expect(result.success).toBe(true)

    const reply = await send('get')
    expect(reply).toBe('OK 999')
  })

  it('reads a value via Lua matching a direct native readValue', async () => {
    let candidates = await (addon as any).scanFirst(handle, 'int16', 12345)
    expect(candidates.length).toBeGreaterThan(0)
    const address = parseInt(candidates[0].address, 16)

    const result = (addon as any).runScript(handle, `print(readInt16(${address}))`)
    expect(result.success).toBe(true)
    expect(result.output[0]).toBe('12345')
  })
})

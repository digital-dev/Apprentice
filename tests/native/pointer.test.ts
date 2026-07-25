import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number
let baseAddress: string

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  const attached = (addon as any).attach(harness.pid)
  handle = attached.handle
  baseAddress = attached.baseAddress
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('resolvePointerChain', () => {
  it('finds a static chain from module base to the harness health value', () => {
    const candidates: string[] = (addon as any).scanFirst(handle, 'int32', 100)
    expect(candidates.length).toBeGreaterThan(0)

    let chain = null
    for (const target of candidates) {
      chain = (addon as any).resolvePointerChain(handle, baseAddress, target, 2)
      if (chain) break
    }
    expect(chain).not.toBeNull()
    expect(Array.isArray(chain.offsets)).toBe(true)
    expect(chain.offsets.length).toBeGreaterThan(0)
  })
})

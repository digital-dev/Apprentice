import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  const attached = (addon as any).attach(harness.pid)
  handle = attached.handle
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('resolvePointerChain', () => {
  it('finds a static chain anchored in any loaded module, and it round-trips through readValue', () => {
    const candidates: string[] = (addon as any).scanFirst(handle, 'int32', 100)
    expect(candidates.length).toBeGreaterThan(0)

    let chain = null
    for (const target of candidates) {
      chain = (addon as any).resolvePointerChain(handle, target, 2)
      if (chain) break
    }
    expect(chain).not.toBeNull()
    expect(typeof chain.moduleName).toBe('string')
    expect(chain.moduleName.length).toBeGreaterThan(0)
    expect(Array.isArray(chain.offsets)).toBe(true)
    expect(chain.offsets.length).toBeGreaterThan(0)

    const moduleBase = (addon as any).getModuleBase(handle, chain.moduleName)
    expect(moduleBase).not.toBeNull()

    const value = (addon as any).readValue(handle, moduleBase, chain.offsets, 'int32')
    expect(value).toBe(100)
  })
})

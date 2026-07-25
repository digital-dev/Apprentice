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
  it('finds a static chain anchored in any loaded module, and it round-trips through readValue', async () => {
    const candidates: { address: string; value: number }[] = await (addon as any).scanFirst(
      handle,
      'int32',
      100
    )
    expect(candidates.length).toBeGreaterThan(0)

    let chain = null
    for (const candidate of candidates) {
      chain = await (addon as any).resolvePointerChain(handle, candidate.address, 2)
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

  it('finds a chain through a field at a nonzero offset inside a struct (real-world object shape)', async () => {
    // g_player_ptr points at PlayerComponent's base; g_player.stamina sits
    // 16 bytes in (four leading int padding fields). An exact-value-only
    // pointer match would never find this — only a pointer whose value is
    // AT the struct base, with the field offset applied afterward, works.
    const candidates: { address: string; value: number }[] = await (addon as any).scanFirst(
      handle,
      'float',
      77.0
    )
    expect(candidates.length).toBeGreaterThan(0)

    let chain = null
    for (const candidate of candidates) {
      chain = await (addon as any).resolvePointerChain(handle, candidate.address, 2)
      if (chain) break
    }
    expect(chain).not.toBeNull()
    expect(chain.offsets.length).toBeGreaterThan(0)
    // The last offset is the in-struct field offset; it must be nonzero
    // here, proving the offset-tolerant match (not just exact-value 0) did
    // the work.
    const lastOffset = parseInt(chain.offsets[chain.offsets.length - 1], 16)
    expect(lastOffset).toBeGreaterThan(0)

    const moduleBase = (addon as any).getModuleBase(handle, chain.moduleName)
    const value = (addon as any).readValue(handle, moduleBase, chain.offsets, 'float')
    expect(value).toBeCloseTo(77.0, 4)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

interface Candidate {
  address: string
  value: number
}

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

// Narrow a value scan down to the single address that changes when we drive
// the harness — the real known variable — instead of grabbing an arbitrary
// address that happens to hold the same value (many exist in a real
// process, and one of them can resolve a coincidental chain).
async function narrowToOne(
  dataType: 'int32' | 'float',
  from: number,
  setCmd: string,
  to: number
): Promise<string> {
  let candidates: Candidate[] = await (addon as any).scanFirst(handle, dataType, from)
  await send(`${setCmd} ${to}`)
  candidates = await (addon as any).scanNext(handle, candidates, dataType, { mode: 'exact', value: to })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

describe('resolvePointerChain', () => {
  it('finds the shallowest, exact static chain to g_health and round-trips through readValue', async () => {
    const target = await narrowToOne('int32', 100, 'set', 424242)

    const chain = await (addon as any).resolvePointerChain(handle, target, 2)
    expect(chain).not.toBeNull()
    expect(typeof chain.moduleName).toBe('string')
    expect(chain.moduleName.length).toBeGreaterThan(0)

    // g_health_ptr holds &g_health exactly, so the best-ranked chain is the
    // shallowest possible (single dereference → offsets.length 2) with an
    // exact final field offset of 0. Ranking must prefer this over any
    // coincidental static pointer landing a few bytes before g_health
    // (which would give a nonzero final offset).
    expect(chain.offsets.length).toBe(2)
    expect(parseInt(chain.offsets[chain.offsets.length - 1], 16)).toBe(0)

    const moduleBase = (addon as any).getModuleBase(handle, chain.moduleName)
    expect(moduleBase).not.toBeNull()
    const value = (addon as any).readValue(handle, moduleBase, chain.offsets, 'int32')
    expect(value).toBe(424242)
  })

  it('finds a chain through a field at a nonzero offset inside a struct (real-world object shape)', async () => {
    // g_player_ptr points at PlayerComponent's base; g_player.stamina sits
    // 16 bytes in (four leading int padding fields). An exact-value-only
    // pointer match would never find this — only a pointer whose value is
    // AT the struct base, with the field offset applied afterward, works.
    const target = await narrowToOne('float', 77.0, 'setp', 33.0)

    const chain = await (addon as any).resolvePointerChain(handle, target, 2)
    expect(chain).not.toBeNull()
    // Single dereference through g_player_ptr to the struct base, then the
    // in-struct field offset — shallowest possible (offsets.length 2). The
    // last offset is the nonzero, 4-aligned field offset (16 bytes in),
    // proving the offset-tolerant match did the work and ranking still
    // picked the shallow, aligned path.
    expect(chain.offsets.length).toBe(2)
    const lastOffset = parseInt(chain.offsets[chain.offsets.length - 1], 16)
    expect(lastOffset).toBeGreaterThan(0)
    expect(lastOffset % 4).toBe(0)

    const moduleBase = (addon as any).getModuleBase(handle, chain.moduleName)
    const value = (addon as any).readValue(handle, moduleBase, chain.offsets, 'float')
    expect(value).toBeCloseTo(33.0, 4)
  })
})

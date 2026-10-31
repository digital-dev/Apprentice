import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness } from '../helpers/spawnHarness'
import addon from '../../native/build/Release/memory_addon.node'

describe('platform seam', () => {
  it('reports which backend was compiled in', () => {
    const platform = (addon as any).platformName()
    expect(['windows', 'linux']).toContain(platform.name)
  })

  it('reports Windows as supported', () => {
    // The suite runs on Windows. A Linux build compiles and loads, but every
    // operation refuses — the point of the stub is that it fails honestly
    // rather than appearing to work.
    const platform = (addon as any).platformName()
    if (process.platform === 'win32') {
      expect(platform.name).toBe('windows')
      expect(platform.supported).toBe(true)
    } else {
      expect(platform.supported).toBe(false)
    }
  })
})

// The harness is an ELF on Linux (no .exe suffix); Windows assertions are unchanged.
const HARNESS_NAME = process.platform === 'win32' ? 'harness.exe' : 'harness'

describe('process and region primitives', () => {
  let harness: ChildProcessWithoutNullStreams
  const a = addon as any

  beforeAll(async () => {
    harness = spawnHarness()
    await new Promise((r) => harness.stdout.once('data', r))
  })

  afterAll(() => {
    harness.stdin.write('q\n')
    harness.kill()
  })

  it('lists the harness process by name', () => {
    const procs = a.platformListProcesses() as { pid: number; name: string }[]
    expect(procs).toContainEqual({ pid: harness.pid, name: HARNESS_NAME })
  })

  it('attach returns handle and baseAddress for the harness', () => {
    const { handle, baseAddress } = a.attach(harness.pid)
    expect(handle).toBeGreaterThan(0)
    expect(BigInt(baseAddress)).toBeGreaterThan(0n)
    const probe = a.platformProbe(harness.pid)
    expect(probe.error).toBeUndefined()
    expect(probe.alive).toBe(true)
    expect(probe.mainModuleBase).toBe(baseAddress)
    a.detach(handle)
  })

  it('platformProbe reports an error for a pid that does not exist', () => {
    expect(a.platformProbe(999999).error).toMatch(
      process.platform === 'win32' ? /OpenProcess failed/ : /process not found/,
    )
  })

  it.runIf(process.platform === 'win32')('reports writable regions', async () => {
    const { handle } = a.attach(harness.pid)
    const candidates = await a.scanFirst(handle, 'int32', 100)
    expect(candidates.length).toBeGreaterThan(0)
    const region = a.platformQueryRegion(handle, candidates[0].address)
    expect(region.readable).toBe(true)
    expect(region.writable).toBe(true)
    a.detach(handle)
  })

  it.runIf(process.platform === 'win32')('exposes the Windows ABI as ms64', () => {
    expect(a.platformProbe(harness.pid).abi).toBe('ms64')
  })
})

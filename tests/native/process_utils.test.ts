import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness } from '../helpers/spawnHarness'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams

beforeAll(() => {
  harness = spawnHarness()
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('listProcesses', () => {
  it('includes the running test harness by pid and name', () => {
    const procs = (addon as any).listProcesses() as { pid: number; name: string }[]
    const match = procs.find((p) => p.pid === harness.pid)
    expect(match).toBeDefined()
    expect(match!.name.toLowerCase()).toBe('harness.exe')
  })
})

describe('attach', () => {
  it('returns a handle and a non-zero base address for the harness', () => {
    const { handle, baseAddress } = (addon as any).attach(harness.pid)
    expect(handle).toBeGreaterThan(0)
    expect(baseAddress).toMatch(/^0x[0-9a-f]+$/)
    expect(BigInt(baseAddress)).toBeGreaterThan(0n)
  })

  it('throws for a pid that does not exist', () => {
    expect(() => (addon as any).attach(999999)).toThrow()
  })

  it('detach closes the handle attach() returned', () => {
    const { handle } = (addon as any).attach(harness.pid)
    const ok = (addon as any).detach(handle)
    expect(ok).toBe(true)
  })
})

describe('getModuleBase (lightweight module lookup)', () => {
  it('matches attach baseAddress for the main module and listModules for kernel32.dll', () => {
    const { handle, baseAddress } = (addon as any).attach(harness.pid)
    try {
      expect((addon as any).getModuleBase(handle, 'harness.exe')).toBe(baseAddress)
      // case-insensitive name match, as before
      expect((addon as any).getModuleBase(handle, 'HARNESS.EXE')).toBe(baseAddress)
      const k32 = ((addon as any).listModules(handle) as { name: string; base: string }[]).find(
        (m) => m.name.toLowerCase() === 'kernel32.dll',
      )
      expect(k32).toBeDefined()
      expect((addon as any).getModuleBase(handle, 'kernel32.dll')).toBe(k32!.base)
      expect((addon as any).getModuleBase(handle, 'no-such-module.dll')).toBeNull()
    } finally {
      ;(addon as any).detach(handle)
    }
  })
})

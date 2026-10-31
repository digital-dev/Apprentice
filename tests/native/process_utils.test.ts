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
    expect(match!.name.toLowerCase()).toBe(process.platform === 'win32' ? 'harness.exe' : 'harness')
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

// A system library every harness has loaded: kernel32.dll on Windows, glibc on Linux.
const MAIN_NAME = process.platform === 'win32' ? 'harness.exe' : 'harness'
const SYSTEM_LIB = process.platform === 'win32' ? 'kernel32.dll' : 'libc.so.6'

describe('getModuleBase (lightweight module lookup)', () => {
  it('matches attach baseAddress for the main module and listModules for a system library', () => {
    const { handle, baseAddress } = (addon as any).attach(harness.pid)
    try {
      expect((addon as any).getModuleBase(handle, MAIN_NAME)).toBe(baseAddress)
      // case-insensitive name match, as before
      expect((addon as any).getModuleBase(handle, MAIN_NAME.toUpperCase())).toBe(baseAddress)
      const k32 = ((addon as any).listModules(handle) as { name: string; base: string }[]).find(
        (m) => m.name.toLowerCase() === SYSTEM_LIB,
      )
      expect(k32).toBeDefined()
      expect((addon as any).getModuleBase(handle, SYSTEM_LIB)).toBe(k32!.base)
      expect((addon as any).getModuleBase(handle, 'no-such-module.dll')).toBeNull()
    } finally {
      ;(addon as any).detach(handle)
    }
  })
})

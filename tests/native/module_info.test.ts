import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('listModules', () => {
  it('reports the target exe itself', () => {
    const mods = (addon as any).listModules(handle)
    const self = mods.find((m: any) => m.name.toLowerCase() === 'harness.exe')
    expect(self).toBeDefined()
    expect(self.base).toMatch(/^0x[0-9a-f]+$/)
  })

  it('reports a plausible SizeOfImage and TimeDateStamp', () => {
    const mods = (addon as any).listModules(handle)
    const self = mods.find((m: any) => m.name.toLowerCase() === 'harness.exe')
    // SizeOfImage is page-granular and never zero for a loaded image.
    expect(self.size).toBeGreaterThan(0)
    expect(self.size % 4096).toBe(0)
    // TimeDateStamp is seconds since 1970 for a normally-linked image.
    expect(self.timestamp).toBeGreaterThan(0)
  })

  it('reports system modules too, and every entry is well-formed', () => {
    const mods = (addon as any).listModules(handle)
    expect(mods.length).toBeGreaterThan(1)
    for (const m of mods) {
      expect(typeof m.name).toBe('string')
      expect(m.name.length).toBeGreaterThan(0)
      expect(m.base).toMatch(/^0x[0-9a-f]+$/)
      expect(typeof m.size).toBe('number')
      expect(typeof m.timestamp).toBe('number')
      expect(m.version === null || typeof m.version === 'string').toBe(true)
    }
  })

  it('throws on a handle that is not a number', () => {
    expect(() => (addon as any).listModules('nope')).toThrow()
  })
})

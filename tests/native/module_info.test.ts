import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness, HARNESS_NAME, HARNESS_IS_PE, HARNESS_WINE } from '../helpers/spawnHarness'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

// A PE target (Windows, or the mingw harness under Wine) names its modules .exe/.dll and its
// images carry a TimeDateStamp; the Linux ELF harness's probes are .so files and have none.
const IS_PE = HARNESS_IS_PE
const PROBE_NAME = IS_PE ? 'probe.dll' : 'probe.so'
const PROBE2_NAME = IS_PE ? 'probe2.dll' : 'probe2.so'

let harness: ChildProcessWithoutNullStreams
let handle: number

beforeAll(async () => {
  harness = spawnHarness()
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
    const self = mods.find((m: any) => m.name.toLowerCase() === HARNESS_NAME)
    expect(self).toBeDefined()
    expect(self.base).toMatch(/^0x[0-9a-f]+$/)
  })

  it('reports a plausible SizeOfImage and TimeDateStamp', () => {
    const mods = (addon as any).listModules(handle)
    const self = mods.find((m: any) => m.name.toLowerCase() === HARNESS_NAME)
    // SizeOfImage is page-granular and never zero for a loaded image.
    expect(self.size).toBeGreaterThan(0)
    expect(self.size % 4096).toBe(0)
    // TimeDateStamp is seconds since 1970 for a normally-linked PE image. An ELF has
    // none, and the Linux backend reports 0 for it.
    if (IS_PE) expect(self.timestamp).toBeGreaterThan(0)
    else expect(self.timestamp).toBe(0)
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

  // The Proton path: a PE exe and Wine's PE builtin DLLs, found through /proc/<pid>/maps and read
  // through their own PE headers. There is no version-resource lookup on Linux, so `version` is
  // always null there (it is checked here only to pin that down).
  it.runIf(HARNESS_WINE)('lists a PE module with version info under Wine', () => {
    const a = addon as any
    const mods = a.listModules(handle)
    for (const name of ['harness-wine.exe', 'kernel32.dll']) {
      const m = mods.find((x: any) => x.name.toLowerCase() === name)
      expect(m, name).toBeDefined()
      expect(m.base).toMatch(/^0x[0-9a-f]+$/)
      expect(BigInt(m.base) % 0x1000n).toBe(0n)
      expect(m.size).toBeGreaterThan(0)
      expect(m.size % 4096).toBe(0)
      expect(m.timestamp).toBeGreaterThan(0)
      expect(m.version).toBeNull()
      expect(a.readBytes(handle, m.base, 2)).toBe('4d5a') // MZ: the base really is the image start
    }

    const k32 = mods.find((x: any) => x.name.toLowerCase() === 'kernel32.dll')
    const gpa = a.resolveExport(handle, k32.base, 'GetProcAddress')
    expect(gpa).not.toBeNull()
    const addr = BigInt(gpa)
    expect(addr).toBeGreaterThan(BigInt(k32.base))
    expect(addr).toBeLessThan(BigInt(k32.base) + BigInt(k32.size))
    expect(a.platformQueryRegion(handle, gpa).executable).toBe(true)
  })

  it('throws on a handle that is not a number', () => {
    expect(() => (addon as any).listModules('nope')).toThrow()
  })
})

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

describe('probe dll', () => {
  it('appears in listModules once loaded and disappears when unloaded', async () => {
    const before = (addon as any).listModules(handle)
    expect(before.find((m: any) => m.name.toLowerCase() === PROBE_NAME)).toBeUndefined()

    const reply = await send('loaddll')
    expect(reply.startsWith('OK')).toBe(true)
    const reportedBase = reply.split(' ')[1]

    const during = (addon as any).listModules(handle)
    const probe = during.find((m: any) => m.name.toLowerCase() === PROBE_NAME)
    expect(probe).toBeDefined()
    expect(probe.base).toBe(reportedBase)
    expect(probe.size).toBeGreaterThan(0)
    if (IS_PE) expect(probe.timestamp).toBeGreaterThan(0)

    await send('unloaddll')
    const after = (addon as any).listModules(handle)
    expect(after.find((m: any) => m.name.toLowerCase() === PROBE_NAME)).toBeUndefined()
  })

  it('the variant dll has a different fingerprint from the original', async () => {
    await send('loaddll')
    const one = (addon as any).listModules(handle)
      .find((m: any) => m.name.toLowerCase() === PROBE_NAME)
    const original = { size: one.size, timestamp: one.timestamp }
    await send('unloaddll')

    await send('loaddll2')
    const two = (addon as any).listModules(handle)
      .find((m: any) => m.name.toLowerCase() === PROBE2_NAME)
    expect(two).toBeDefined()
    // A game update changes at least one of these; the fingerprint test in
    // profile.ts compares exactly this pair.
    expect(two.size !== original.size || two.timestamp !== original.timestamp).toBe(true)
    await send('unloaddll')
  })
})

describe('a module anchor survives a reload', () => {
  it('finds the same instruction at a new base by RVA', async (ctx) => {
    const first = await send('loaddll')
    const firstBase = first.split(' ')[1]
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === PROBE_NAME)

    // Take a byte run from a fixed RVA inside the probe and remember both
    // the RVA and the bytes — this is exactly what a saved patch holds.
    const rva = 0x1000
    const captured = (addon as any).readBytes(handle, '0x' + (BigInt(firstBase) + BigInt(rva)).toString(16), 8)
    expect(captured).toMatch(/^[0-9a-f]{16}$/)

    await send('unloaddll')
    // Load something else first so the probe is unlikely to land back at
    // the same base — this makes the test actually prove RVA-anchored
    // relocation across a real base change, rather than just proving
    // readBytes is deterministic.
    await send('loaddll2')
    await send('unloaddll')
    const second = await send('loaddll')
    const secondBase = second.split(' ')[1]

    // The whole point of this test is a genuine base change — proving an
    // RVA survives relocation, not just that readBytes is deterministic.
    // In practice the OS/loader does sometimes hand the freed slot straight
    // back (observed in this repo's own CI runs), which would make a hard
    // `not.toBe` assertion flaky rather than meaningful. Skip visibly
    // rather than pass vacuously when that happens, so a same-base run is
    // reported, not silently green.
    if (secondBase === firstBase) {
      console.warn(
        '[module_info.test.ts] probe.dll reloaded at the same base twice in a row; skipping the RVA-relocation assertion for this run.'
      )
      ctx.skip()
      return
    }

    const atSameRva = (addon as any).readBytes(handle, '0x' + (BigInt(secondBase) + BigInt(rva)).toString(16), 8)
    expect(atSameRva).toBe(captured)
    expect(probe.size).toBeGreaterThan(rva)

    await send('unloaddll')
  })
})

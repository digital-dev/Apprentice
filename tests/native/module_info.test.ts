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

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

describe('probe dll', () => {
  it('appears in listModules once loaded and disappears when unloaded', async () => {
    const before = (addon as any).listModules(handle)
    expect(before.find((m: any) => m.name.toLowerCase() === 'probe.dll')).toBeUndefined()

    const reply = await send('loaddll')
    expect(reply.startsWith('OK')).toBe(true)
    const reportedBase = reply.split(' ')[1]

    const during = (addon as any).listModules(handle)
    const probe = during.find((m: any) => m.name.toLowerCase() === 'probe.dll')
    expect(probe).toBeDefined()
    expect(probe.base).toBe(reportedBase)
    expect(probe.size).toBeGreaterThan(0)
    expect(probe.timestamp).toBeGreaterThan(0)

    await send('unloaddll')
    const after = (addon as any).listModules(handle)
    expect(after.find((m: any) => m.name.toLowerCase() === 'probe.dll')).toBeUndefined()
  })

  it('the variant dll has a different fingerprint from the original', async () => {
    await send('loaddll')
    const one = (addon as any).listModules(handle)
      .find((m: any) => m.name.toLowerCase() === 'probe.dll')
    const original = { size: one.size, timestamp: one.timestamp }
    await send('unloaddll')

    await send('loaddll2')
    const two = (addon as any).listModules(handle)
      .find((m: any) => m.name.toLowerCase() === 'probe2.dll')
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
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')

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

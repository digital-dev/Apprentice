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

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('resolveExport', () => {
  it('finds a real exported function inside a loaded DLL', async () => {
    const reply = await send('loaddll')
    const probeBase = reply.split(' ')[1]

    const addr = (addon as any).resolveExport(handle, probeBase, 'probe_write')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)

    await send('unloaddll')
  })

  it('finds an exported data symbol too', async () => {
    await send('loaddll')
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')

    const addr = (addon as any).resolveExport(handle, probe.base, 'g_probe_field')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)

    await send('unloaddll')
  })

  it('returns null for a name that is not exported', async () => {
    await send('loaddll')
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')

    const addr = (addon as any).resolveExport(handle, probe.base, 'not_a_real_export')
    expect(addr).toBeNull()

    await send('unloaddll')
  })

  it('returns null against a bad module base', () => {
    const addr = (addon as any).resolveExport(handle, '0x1', 'anything')
    expect(addr).toBeNull()
  })
})

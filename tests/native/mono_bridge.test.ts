import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number
let monoBase: string

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
  const reply = await send('loadmono')
  monoBase = reply.split(' ')[1]
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('monoResolveClass', () => {
  it('resolves a real class by namespace and name', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    expect(klass).toMatch(/^0x[0-9a-f]+$/)
  })

  it('resolves a different class to a different handle', async () => {
    const player = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const character = await (addon as any).monoResolveClass(handle, monoBase, '', 'Character')
    expect(character).not.toBe(player)
  })

  it('returns null for a class that does not exist', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'NoSuchClass')
    expect(klass).toBeNull()
  })
})

describe('monoResolveField', () => {
  it('finds a known field and its offset', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const field = await (addon as any).monoResolveField(handle, monoBase, klass, 'm_godMode')
    expect(field.offset).toBe(0x691)
  })

  it('returns null for a field that does not exist on that class', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const field = await (addon as any).monoResolveField(handle, monoBase, klass, 'not_a_field')
    expect(field).toBeNull()
  })
})

describe('monoStaticFieldAddress', () => {
  it('finds the storage address of a field, distinct from its offset', async () => {
    const klass = await (addon as any).monoResolveClass(handle, monoBase, '', 'Player')
    const addr = await (addon as any).monoStaticFieldAddress(handle, monoBase, klass, 'm_localPlayer')
    expect(addr).toMatch(/^0x[0-9a-f]+$/)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams
let handle: number
let baseAddress: string

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  const attached = (addon as any).attach(harness.pid)
  handle = attached.handle
  baseAddress = attached.baseAddress
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('readValue / writeValue', () => {
  it('reads current value and writes a new one via a resolved chain', async () => {
    const candidates: string[] = (addon as any).scanFirst(handle, 'int32', 100)
    let offsets: string[] | null = null
    for (const target of candidates) {
      const chain = (addon as any).resolvePointerChain(handle, baseAddress, target, 2)
      if (chain) { offsets = chain.offsets; break }
    }
    expect(offsets).not.toBeNull()

    const before = (addon as any).readValue(handle, baseAddress, offsets, 'int32')
    expect(before).toBe(100)

    const ok = (addon as any).writeValue(handle, baseAddress, offsets, 'int32', 777)
    expect(ok).toBe(true)

    const reply = await send('get')
    expect(reply).toBe('OK 777')
  })
})

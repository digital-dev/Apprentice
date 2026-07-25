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

describe('readValue / writeValue', () => {
  it('reads current value and writes a new one via a resolved chain', async () => {
    // Narrow to a single confirmed candidate first (as a real user would
    // via the Scanner screen) before resolving a chain. Resolving against
    // an un-narrowed candidate list and taking the first address with ANY
    // resolvable chain is unreliable: many addresses across a real process
    // can share the same scanned value, and the offset-tolerant chain
    // search can find *some* static path to more than one of them.
    let candidates: { address: string; value: number }[] = await (addon as any).scanFirst(
      handle,
      'int32',
      100
    )
    await send('set 55')
    candidates = (addon as any).scanNext(handle, candidates, 'int32', {
      mode: 'exact',
      value: 55
    })
    expect(candidates.length).toBe(1)
    const target = candidates[0].address

    const chain = await (addon as any).resolvePointerChain(handle, target, 2)
    expect(chain).not.toBeNull()
    const offsets: string[] = chain.offsets
    const moduleName: string = chain.moduleName

    // The chain can be anchored in any loaded module, not necessarily the
    // one attach() reported first, so its base must be looked up by name.
    const baseAddress = (addon as any).getModuleBase(handle, moduleName)
    expect(baseAddress).not.toBeNull()

    const before = (addon as any).readValue(handle, baseAddress, offsets, 'int32')
    expect(before).toBe(55)

    const ok = (addon as any).writeValue(handle, baseAddress, offsets, 'int32', 777)
    expect(ok).toBe(true)

    const reply = await send('get')
    expect(reply).toBe('OK 777')
  })
})

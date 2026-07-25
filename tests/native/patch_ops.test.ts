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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  try { (addon as any).stopWriteWatch() } catch { /* ignore */ }
  harness.stdin.write('q\n')
  harness.kill()
})

async function count(): Promise<number> {
  const reply = await send('getcount')
  return Number(reply.split(' ')[1])
}

// Find the drain counter's address by scanning for its initial value and
// narrowing to exactly one via setcount, then catch the instruction that
// writes it with the #5 write-watch — that is where a real patch cheat's
// bytes/length/signature come from, so the test starts from the same input.
async function catchDrainInstruction(): Promise<{
  instructionAddress: string
  bytes: string
  length: number
  signature: string
}> {
  let candidates = await (addon as any).scanFirst(handle, 'int32', 1000000)
  await send('setcount 424242')
  candidates = (addon as any).scanNext(handle, candidates, 'int32', {
    mode: 'exact',
    value: 424242
  })
  expect(candidates.length).toBe(1)
  const address = candidates[0].address

  ;(addon as any).startWriteWatch(harness.pid, address)
  await send('drainloop')
  let list: any[] = []
  for (let i = 0; i < 40 && list.length === 0; i++) {
    await sleep(50)
    list = (addon as any).pollWriteWatch()
  }
  await send('stopdrain')
  const final = (addon as any).stopWriteWatch()
  expect(final.length).toBeGreaterThan(0)
  return final[0]
}

describe('readBytes / writeBytes', () => {
  it('NOPs a live drain instruction and restores it', async () => {
    const insn = await catchDrainInstruction()

    // readBytes agrees with what the capture recorded.
    const original = (addon as any).readBytes(handle, insn.instructionAddress, insn.length)
    expect(original).toBe(insn.bytes)

    // NOP it while the drain runs: the counter must stop moving.
    const nops = '90'.repeat(insn.length)
    expect((addon as any).writeBytes(handle, insn.instructionAddress, nops)).toBe(true)
    expect((addon as any).readBytes(handle, insn.instructionAddress, insn.length)).toBe(nops)

    await send('drainloop')
    await sleep(150)
    const a = await count()
    await sleep(300)
    const b = await count()
    expect(b).toBe(a) // patched: the write never executes

    // Restore: the drain must resume.
    expect((addon as any).writeBytes(handle, insn.instructionAddress, original)).toBe(true)
    await sleep(300)
    const c = await count()
    expect(c).toBeLessThan(b)

    await send('stopdrain')
  }, 30000)
})

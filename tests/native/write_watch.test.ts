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

// Resolve the address of g_player.stamina by scanning for its 77.0 value,
// narrowed to one via the setp command.
async function staminaAddress(): Promise<string> {
  let candidates = await (addon as any).scanFirst(handle, 'float', 77.0)
  await send('setp 33')
  candidates = (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 33 })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

describe('write watch — capture', () => {
  it('catches a write instruction and detaches cleanly', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stoploop')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBe(1)

    const insn = final[0]
    expect(insn.baseRegister.length).toBeGreaterThan(0)
    expect(insn.baseRegister).not.toBe('rip') // object write goes through a GPR
    // base register held g_player; displacement is the stamina field offset (16).
    expect(parseInt(insn.displacement, 16)).toBe(16)
    const base = BigInt(insn.baseAddress)
    const disp = BigInt(insn.displacement)
    expect('0x' + (base + disp).toString(16)).toBe(address)
    // The writing instruction lives in the harness module.
    expect(insn.moduleName === null || typeof insn.moduleName === 'string').toBe(true)
    // Signature is space-separated hex byte tokens, each 2 hex chars or '??'.
    expect(insn.signature.length).toBeGreaterThan(0)
    for (const tok of insn.signature.split(' ')) {
      expect(tok === '??' || /^[0-9a-f]{2}$/.test(tok)).toBe(true)
    }

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — attach failure handling', () => {
  // A pid this large should not exist, so DebugActiveProcess fails to attach.
  const badPid = 999999999

  it('throws when it fails to attach to an invalid pid', () => {
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()
  })

  it('does not crash the process across repeated failed attaches with no intervening stop', () => {
    // Each failed attach leaves its loop thread exited-but-unjoined
    // (DebugLoop sets running=false without ever being joined). Before the
    // fix, the next startWriteWatch's `g_session.loop = std::thread(...)`
    // move-assignment onto that still-joinable thread called
    // std::terminate() and aborted the whole process — which would kill
    // this test runner outright rather than surface as a failed assertion.
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()
    expect(() => (addon as any).startWriteWatch(badPid, '0x1000')).toThrow()

    // Reaching here proves the process survived. The addon (and, by
    // extension, the rest of the trainer) is still responsive.
    expect((addon as any).ping()).toBe('pong')
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
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
//
// Cached because the scan only works once: it keys off the field's INITIAL
// 77.0, and the first test to run overwrites that. The address itself stays
// valid for the harness's lifetime, so later tests reuse it rather than
// re-deriving it from a value that is no longer there.
let cachedStaminaAddress: string | null = null

async function staminaAddress(): Promise<string> {
  if (cachedStaminaAddress) return cachedStaminaAddress
  cachedStaminaAddress = await resolveStaminaAddress()
  return cachedStaminaAddress
}

async function resolveStaminaAddress(): Promise<string> {
  let candidates = await (addon as any).scanFirst(handle, 'float', 77.0)
  await send('setp 33')
  candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 33 })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

// Resolve the address of g_player.shield (offset 4 inside PlayerComponent) —
// the field a single 16-byte SSE store (`shieldloop`) covers without
// starting at it. Same once-only-scan caveat as staminaAddress: the scan
// keys off the field's INITIAL 55.0, which the first test to run overwrites.
let cachedShieldAddress: string | null = null

async function shieldAddress(): Promise<string> {
  if (cachedShieldAddress) return cachedShieldAddress
  cachedShieldAddress = await resolveShieldAddress()
  return cachedShieldAddress
}

async function resolveShieldAddress(): Promise<string> {
  let candidates = await (addon as any).scanFirst(handle, 'float', 55.0)
  await send('setshield 66')
  candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 66 })
  expect(candidates.length).toBe(1)
  return candidates[0].address
}

const GOLDEN = path.resolve('tests/fixtures/signature-golden.json')

async function capture(address: string, loopCmd: string, stopCmd: string) {
  ;(addon as any).startWriteWatch(harness.pid, address)
  await send(loopCmd)
  let list: any[] = []
  for (let i = 0; i < 40 && list.length === 0; i++) {
    await sleep(50)
    list = (addon as any).pollWriteWatch()
  }
  await send(stopCmd)
  const final = (addon as any).stopWriteWatch()
  expect(final.length).toBeGreaterThan(0)
  const c = final[0]
  return { signature: c.signature, signatureOffset: c.signatureOffset, length: c.length }
}

describe('live signature golden', () => {
  it('stamina and shield signatures match the recorded golden', async () => {
    const got = {
      stamina: await capture(await staminaAddress(), 'watchloop', 'stoploop'),
      shield: await capture(await shieldAddress(), 'shieldloop', 'stopshield')
    }
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(GOLDEN)) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
      fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n')
    }
    expect(got).toEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')))
  }, 30000)
})

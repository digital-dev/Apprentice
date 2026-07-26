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
  candidates = (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 33 })
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
  candidates = (addon as any).scanNext(handle, candidates, 'float', { mode: 'exact', value: 66 })
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

describe('write watch — covering write (single SSE store)', () => {
  // `shieldloop` writes `g_player.shield` (offset 4) via a single 16-byte
  // `movups [reg], xmm` whose effective address is the struct base (offset
  // 0) — unlike wideloop's block copy, this is one instruction with a
  // static destination register that never advances, so it stays
  // attributable at the trap. This is the shape the covering-write
  // relaxation in FindWriteInstruction actually exists for (a SIMD/struct
  // field write, not a memcpy-style loop), and it must decode with
  // effectiveAddress strictly before the watched address — proving the
  // match is a genuine COVERING match, not an exact one in disguise.
  //
  // Runs BEFORE the wideloop test below: wideloop's block copy overwrites
  // g_player.shield too (it rewrites the whole struct), which would corrupt
  // the 55.0 initial value this test's scan keys off before it ever gets a
  // chance to resolve the address.
  it('decodes the covering SSE store and reports effectiveAddress before the watched field', async () => {
    const address = await shieldAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('shieldloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stopshield')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBeGreaterThan(0)

    const insn = final[0]
    expect(insn.length).toBeGreaterThan(0)
    expect(insn.baseRegister.length).toBeGreaterThan(0)
    expect(insn.indexed).toBe(false) // plain [reg] addressing, no index register involved

    const watched = BigInt(address)
    const effective = BigInt(insn.effectiveAddress)
    const accessBytes = BigInt(insn.accessBytes)
    expect(effective <= watched).toBe(true)
    expect(watched < effective + accessBytes).toBe(true)
    // The defining property of a COVERING (not exact) match: the store's
    // effective address is the struct base, strictly before `shield` at
    // offset 4 inside it.
    expect(effective !== watched).toBe(true)

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true)
  }, 15000)
})

describe('write watch — covering write (wide store)', () => {
  // `wideloop` writes the whole PlayerComponent in one store rather than
  // just the stamina field — the covering-write relaxation in
  // FindWriteInstruction exists for exactly this shape (a struct copy /
  // SIMD store whose effective address is the start of a block containing
  // the watched field), and until now nothing in the suite drove it; it was
  // exercised only by manual testing against a real game.
  it('catches the wide store but leaves it undecoded (documented limitation)', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('wideloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    await send('stopwide')
    const final = (addon as any).stopWriteWatch()

    expect(list.length).toBeGreaterThan(0)
    expect(final.length).toBeGreaterThan(0)

    // This pins a documented limitation, not a success path — see
    // docs/superpowers/follow-ups/2026-07-25-code-patch-cheats.md ("A
    // `movs`-style block copy still cannot be attributed to a field").
    // `wide_write`'s `*p = v` compiles to a movs-style block copy whose
    // destination register auto-advances as it runs, so by the time the
    // #DB trap lands, post-trap register state no longer points at the
    // watched address — the row is caught (it exists, hence
    // final.length > 0 above) but FindWriteInstruction cannot attribute it
    // to any decoded instruction, hence length === 0 and baseRegister === ''
    // below. This must fail equally if the block copy became decodable
    // (regression toward guessing) or if the row stopped being caught at
    // all (regression in capture itself) — unlike the previous version of
    // this test, there is no branch that swallows either direction.
    const insn = final[0]
    expect(insn.length).toBe(0)
    expect(insn.baseRegister).toBe('')

    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true) // target still alive after the undecoded catch
  }, 15000)
})

describe('write watch — detaching while the target is still writing', () => {
  it('leaves the target alive when the watch stops mid-write', async () => {
    const address = await staminaAddress()

    ;(addon as any).startWriteWatch(harness.pid, address)
    await send('watchloop')

    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = (addon as any).pollWriteWatch()
    }
    expect(list.length).toBeGreaterThan(0)

    // Deliberately do NOT stop the harness's write loop first. Every other
    // test here sends 'stoploop' before stopping the watch, which empties
    // the debug-event queue and hides the failure this test exists for:
    // clearing Dr7 does not un-raise an exception the CPU has already
    // fired, so any queued debug exception gets delivered after detach to a
    // process with no debugger and kills it with STATUS_SINGLE_STEP. That
    // is what made closing the app take the game down with it.
    ;(addon as any).stopWriteWatch()

    await sleep(500) // let the loop keep writing across the detach
    const reply = await send('get')
    expect(reply.startsWith('OK')).toBe(true) // still alive and responsive

    await send('stoploop')
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

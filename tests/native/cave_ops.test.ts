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

// The forced field's address, cached the same way write_watch.test.ts caches
// its stamina address: the scan keys off the field's initial value, which
// the first test to run overwrites, so it must be resolved once up front.
//
// This resolution runs inside the SAME beforeAll as the harness spawn/attach
// above, rather than as a second, separately-registered beforeAll — a second
// top-level beforeAll that awaits scanFirst's AsyncWorker promise reliably
// segfaults the worker process under this project's vitest setup (reproduced
// in isolation; the crash disappears the moment the awaited scanFirst call
// moves into the first beforeAll, with no other change). Keeping the scan in
// the first hook preserves the brief's caching logic verbatim while avoiding
// that crash.
let forceAddress: string

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = (addon as any).attach(harness.pid).handle

  let candidates = await (addon as any).scanFirst(handle, 'float', 10.0)
  await send('setforce 4242')
  candidates = (addon as any).scanNext(handle, candidates, 'float', {
    mode: 'exact',
    value: 4242
  })
  expect(candidates.length).toBe(1)
  forceAddress = candidates[0].address
})

afterAll(() => {
  try { (addon as any).stopWriteWatch() } catch { /* ignore */ }
  harness.stdin.write('q\n')
  harness.kill()
})

// The address of a real instruction in the harness, used as the "near"
// reference for cave allocation and as decode input.
async function anInstructionAddress(): Promise<string> {
  const base = (addon as any).attach(harness.pid).baseAddress
  return base
}

describe('allocateCave', () => {
  it('allocates a page within reach of a 32-bit relative jump', async () => {
    const near = await anInstructionAddress()
    const cave: string | null = (addon as any).allocateCave(handle, near)
    expect(cave).not.toBeNull()

    const distance =
      BigInt(cave as string) > BigInt(near)
        ? BigInt(cave as string) - BigInt(near)
        : BigInt(near) - BigInt(cave as string)
    // rel32 reaches ±2GB; anything further cannot be jumped to.
    expect(distance < 2n ** 31n).toBe(true)
  })

  it('returns a writable, readable page', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    expect((addon as any).writeBytes(handle, cave, '9090909090')).toBe(true)
    expect((addon as any).readBytes(handle, cave, 5)).toBe('9090909090')
  })
})

describe('decodeRun', () => {
  it('covers whole instructions totalling at least the requested bytes', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // Three 2-byte instructions (89 01 = mov [rcx],eax). Asking for 5 bytes
    // must round UP to 6 — a whole number of instructions — because
    // displacing half an instruction is what corrupts a game. Written into
    // scratch memory rather than decoded at some address we hope is code, so
    // the expectation is exact rather than conditional.
    ;(addon as any).writeBytes(handle, scratch, '890189018901')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.length).toBe(6)
  })

  it('reports a relative branch as not relocatable', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    // E9 00 00 00 00 = jmp +0, a relative branch; moving it changes where
    // it goes, so a run containing it must never be displaced.
    const scratch: string = (addon as any).allocateCave(handle, near)
    ;(addon as any).writeBytes(handle, scratch, 'e900000000')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.relocatable).toBe(false)
  })

  it('reports a plain register store as relocatable', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // f3 0f 11 47 10 = movss [rdi+0x10], xmm0 — no RIP, no branch.
    ;(addon as any).writeBytes(handle, scratch, 'f30f114710')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.relocatable).toBe(true)
    expect(result.length).toBe(5)
  })

  it('reports RIP-relative code as not relocatable', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // 48 8b 05 00 00 00 00 = mov rax, [rip+0]
    ;(addon as any).writeBytes(handle, scratch, '488b0500000000')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.relocatable).toBe(false)
  })

  it('refuses a run that must fold in the function\'s own ret', async () => {
    // harness.c's tight_write (`*p = v;`, deliberately unpadded — unlike
    // force_write above) compiles under /Od to a 4-byte `movss [reg], xmm`
    // sitting immediately against its `ret`, with no other code between
    // them. Asking decodeRun for 5 bytes (a jmp rel32's footprint) forces it
    // to fold that `ret` into the run — and a cave built from `displaced +
    // effect + jumpBack` would then hit the `ret` and return before the
    // effect or jump-back ever runs, installing a cheat that silently does
    // nothing. decodeRun must refuse this outright rather than report it
    // installable; a NOP-style patch or a force injection built from it
    // would otherwise report success while doing nothing (or, for a NOP,
    // corrupt the tail byte of whatever follows).
    let candidates = await (addon as any).scanFirst(handle, 'float', 20.0)
    await send('settight 4141')
    candidates = (addon as any).scanNext(handle, candidates, 'float', {
      mode: 'exact',
      value: 4141
    })
    expect(candidates.length).toBe(1)
    const tightAddress = candidates[0].address

    ;(addon as any).startWriteWatch(harness.pid, tightAddress)
    await send('tightloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    await send('stoptight')
    expect(insn.length).toBeGreaterThan(0)

    const result = (addon as any).decodeRun(handle, insn.instructionAddress, 5)
    expect(result.decodable).toBe(true)
    expect(result.relocatable).toBe(false)
  }, 15000)
})

describe('encodeJump', () => {
  it('encodes a 5-byte relative jump', () => {
    // From 0x1000 to 0x1010: rel32 = to - (from + 5) = 0x0b.
    const hex: string = (addon as any).encodeJump('0x1000', '0x1010')
    expect(hex).toBe('e90b000000')
  })

  it('encodes a backward jump', () => {
    // From 0x1010 to 0x1000: rel32 = -0x15 = 0xffffffeb.
    const hex: string = (addon as any).encodeJump('0x1010', '0x1000')
    expect(hex).toBe('e9ebffffff')
  })
})

describe('encodeStore', () => {
  it('encodes mov dword ptr [rdi+offset], imm32', () => {
    // C7 87 <disp32> <imm32> — the canonical encoding for this form.
    const hex: string = (addon as any).encodeStore('rdi', 0x818, 0x43af0000)
    expect(hex).toBe('c78718080000' + '0000af43')
  })

  it('round-trips through the decoder as the instruction we meant', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    const hex: string = (addon as any).encodeStore('rcx', 0x10, 1234)
    ;(addon as any).writeBytes(handle, scratch, hex)
    // It must decode as one whole, relocatable instruction of exactly the
    // length we produced — proof we emitted a real instruction, not bytes
    // that merely look plausible.
    const run = (addon as any).decodeRun(handle, scratch, 1)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown register instead of encoding nonsense', () => {
    expect(() => (addon as any).encodeStore('notareg', 0, 0)).toThrow()
  })
})

describe('encodeCapture', () => {
  it('writes the register into the slot when executed', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    const slot = cave
    const code = '0x' + (BigInt(cave) + 8n).toString(16)
    const hex: string = (addon as any).encodeCapture('rcx', code, slot)

    // It must decode as one instruction of exactly the length produced —
    // proof the RIP displacement was folded into a real encoding.
    ;(addon as any).writeBytes(handle, code, hex)
    const run = (addon as any).decodeRun(handle, code, 1)
    expect(run.decodable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown register', () => {
    expect(() => (addon as any).encodeCapture('nope', '0x1000', '0x2000')).toThrow()
  })
})

describe('suspendThreads / resumeThreads', () => {
  it('freezes the target and lets it run again', async () => {
    await send('forceloop')
    await sleep(100)

    expect((addon as any).suspendThreads(handle, harness.pid)).toBe(true)
    let during: string
    try {
      // Frozen: the writer thread cannot advance the value.
      const before = (addon as any).readBytes(handle, forceAddress, 4)
      await sleep(200)
      during = (addon as any).readBytes(handle, forceAddress, 4)
      expect(during).toBe(before)
    } finally {
      (addon as any).resumeThreads()
    }

    await sleep(200)
    const after = (addon as any).readBytes(handle, forceAddress, 4)
    expect(after).not.toBe(during)

    await send('stopforce')
  }, 15000)

  it('refuses a second suspension while the first still holds', async () => {
    await send('forceloop')
    await sleep(100)

    expect((addon as any).suspendThreads(handle, harness.pid)).toBe(true)
    try {
      expect(() => (addon as any).suspendThreads(handle, harness.pid)).toThrow()

      // The failed second call must not have disturbed the first
      // suspension: the target should still be frozen.
      const before = (addon as any).readBytes(handle, forceAddress, 4)
      await sleep(200)
      const during = (addon as any).readBytes(handle, forceAddress, 4)
      expect(during).toBe(before)
    } finally {
      (addon as any).resumeThreads()
    }

    await sleep(200)
    await send('stopforce')
  }, 15000)
})

describe('force injection — end to end', () => {
  it('pins the value to a constant and releases it on restore', async () => {
    // Catch the instruction that writes the forced field, exactly as the
    // app does — this is the same provenance a real cheat has.
    ;(addon as any).startWriteWatch(harness.pid, forceAddress)
    await send('forceloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    expect(insn.length).toBeGreaterThan(0)
    expect(insn.baseRegister.length).toBeGreaterThan(0)

    const site = insn.instructionAddress
    const run = (addon as any).decodeRun(handle, site, 5)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)

    const displaced = (addon as any).readBytes(handle, site, run.length)
    const cave = (addon as any).allocateCave(handle, site)
    expect(cave).not.toBeNull()

    // 777.0f as raw bits — the same conversion valueBits does in the engine.
    const bits = new DataView(new ArrayBuffer(4))
    bits.setFloat32(0, 777, true)
    const imm = bits.getUint32(0, true)

    const codeAddress = '0x' + (BigInt(cave) + 8n).toString(16)
    const effect = (addon as any).encodeStore(
      insn.baseRegister,
      Number(BigInt(insn.displacement)),
      imm
    )
    const returnTo = '0x' + (BigInt(site) + BigInt(run.length)).toString(16)
    const jumpBackFrom =
      '0x' + (BigInt(codeAddress) + BigInt(displaced.length / 2 + effect.length / 2)).toString(16)
    const body = displaced + effect + (addon as any).encodeJump(jumpBackFrom, returnTo)
    expect((addon as any).writeBytes(handle, codeAddress, body)).toBe(true)

    const jump = (addon as any).encodeJump(site, codeAddress)
    const padded = jump + '90'.repeat(run.length - 5)
    ;(addon as any).suspendThreads(handle, harness.pid)
    try {
      expect((addon as any).writeBytes(handle, site, padded)).toBe(true)
    } finally {
      (addon as any).resumeThreads()
    }

    // The harness keeps writing an increasing value; the injection must win
    // every time, so every sample reads exactly 777.
    await sleep(200)
    for (let i = 0; i < 3; i++) {
      const reply = await send('getforce')
      expect(parseFloat(reply.split(' ')[1])).toBeCloseTo(777, 3)
      await sleep(100)
    }

    // Restore: the field must start moving again. Asserting the value
    // CHANGED between two samples (rather than "not close to 777") is
    // strictly stronger and flake-free: force_thread increments by 1.0
    // every 10ms from 0, so it passes through exactly 777.0 once per
    // `forceloop` run — a single sample landing on that tick would fail
    // "not close to 777" spuriously even though the release genuinely
    // worked.
    ;(addon as any).suspendThreads(handle, harness.pid)
    try {
      expect((addon as any).writeBytes(handle, site, displaced)).toBe(true)
    } finally {
      (addon as any).resumeThreads()
    }
    await sleep(300)
    const first = parseFloat((await send('getforce')).split(' ')[1])
    await sleep(200)
    const second = parseFloat((await send('getforce')).split(' ')[1])
    expect(second).not.toBe(first)

    await send('stopforce')
  }, 30000)
})

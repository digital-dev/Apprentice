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
  candidates = await (addon as any).scanNext(handle, candidates, 'float', {
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

  // These pin the real Valheim crash: a captured `movss [rax], xmm5` is only
  // 4 bytes, so reaching the 5 a jmp rel32 needs drags in the following
  // `mov eax, 1`. Writing eax zero-extends across all of rax, so the
  // injected `mov dword [rax], imm32` that runs after the displaced bytes
  // dereferenced 0x1 and faulted. decodeRun has to report that the run
  // clobbers rax so the engine can refuse before writing anything.
  it('reports the 64-bit register a 32-bit write clobbers', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // f3 0f 11 28 = movss [rax], xmm5 ; b8 01 00 00 00 = mov eax, 1
    ;(addon as any).writeBytes(handle, scratch, 'f30f1128' + 'b801000000')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.relocatable).toBe(true)
    expect(result.length).toBe(9)
    // Named as rax, not eax — the whole point. An `eax` here would let the
    // crashing case through any base-register comparison the engine makes.
    expect(result.clobbers).toContain('rax')
  })

  it('reports no clobbered register for a store that only writes memory', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    // f3 0f 11 ae 18 08 00 00 = movss [rsi+0x818], xmm5 — 8 bytes, so
    // nothing extra is displaced. This is the shape that worked in Valheim.
    ;(addon as any).writeBytes(handle, scratch, 'f30f11ae18080000')
    const result = (addon as any).decodeRun(handle, scratch, 5)
    expect(result.decodable).toBe(true)
    expect(result.length).toBe(8)
    expect(result.clobbers).not.toContain('rsi')
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
    candidates = await (addon as any).scanNext(handle, candidates, 'float', {
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

describe('encodeStoreRegister', () => {
  it('encodes mov dword ptr [rdi+offset], eax', () => {
    // REX.W is not needed for a 32-bit destination write; the ModRM byte
    // for [rdi+disp32] with source EAX is 0x87 (mod=10, reg=000, rm=111).
    const hex: string = (addon as any).encodeStoreRegister('rdi', 0x818, 'rax')
    expect(hex).toBe('8987' + '18080000')
  })

  it('encodes an extended source register (r8d) with the right REX prefix', () => {
    const hex: string = (addon as any).encodeStoreRegister('rcx', 0x10, 'r8')
    // REX.R must be set (source is r8-r15): 44 89 41 10 (disp8, not disp32)
    expect(hex).toBe('44894110')
  })

  it('round-trips through the decoder as one whole, relocatable instruction', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    const hex: string = (addon as any).encodeStoreRegister('rcx', 0x10, 'rdx')
    ;(addon as any).writeBytes(handle, scratch, hex)
    const run = (addon as any).decodeRun(handle, scratch, 1)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown destination register', () => {
    expect(() => (addon as any).encodeStoreRegister('notareg', 0, 'rax')).toThrow()
  })

  it('rejects an unknown source register', () => {
    expect(() => (addon as any).encodeStoreRegister('rdi', 0, 'notareg')).toThrow()
  })
})

describe('encodeScale', () => {
  it('encodes mov eax,imm32 / movd xmm0,eax / mulss xmm5,xmm0 for a non-xmm0 source', () => {
    // factorBits for 2.0f = 0x40000000
    const hex: string = (addon as any).encodeScale('xmm5', 0x40000000)
    // b8 00000040          mov eax, 0x40000000
    // 66 0f 6e c0          movd xmm0, eax      (scratch = xmm0, source is xmm5)
    // f3 0f 59 e8          mulss xmm5, xmm0
    expect(hex).toBe('b800000040' + '660f6ec0' + 'f30f59e8')
  })

  it('picks xmm1 as scratch when the source itself is xmm0', () => {
    // factorBits for 1.5f = 0x3fc00000
    const hex: string = (addon as any).encodeScale('xmm0', 0x3fc00000)
    // b8 0000c03f          mov eax, 0x3fc00000
    // 66 0f 6e c8          movd xmm1, eax      (scratch = xmm1, source is xmm0)
    // f3 0f 59 c1          mulss xmm0, xmm1
    expect(hex).toBe('b80000c03f' + '660f6ec8' + 'f30f59c1')
  })

  it('round-trips through the decoder as three whole, relocatable instructions', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const scratch: string = (addon as any).allocateCave(handle, near)
    const hex: string = (addon as any).encodeScale('xmm3', 0x40000000)
    ;(addon as any).writeBytes(handle, scratch, hex)
    const run = (addon as any).decodeRun(handle, scratch, hex.length / 2)
    expect(run.decodable).toBe(true)
    expect(run.relocatable).toBe(true)
    expect(run.length).toBe(hex.length / 2)
  })

  it('rejects an unknown source register instead of encoding nonsense', () => {
    expect(() => (addon as any).encodeScale('notareg', 0)).toThrow()
  })

  it('rejects a GPR name — only xmm registers hold a float mid-computation', () => {
    expect(() => (addon as any).encodeScale('rax', 0)).toThrow()
  })
})

describe('encodeCaptureOnce', () => {
  it('emits a decodable blob whose RIP displacements both resolve to the slot', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    const slot = cave
    const code = '0x' + (BigInt(cave) + 8n).toString(16)
    const hex: string = (addon as any).encodeCaptureOnce('rcx', code, slot)

    // pushfq | cmp qword [rip+d1],0 | jne +7 | mov [rip+d2],rcx | popfq
    expect(hex.length / 2).toBe(19)

    // Every byte must decode as real instructions covering the whole blob —
    // asking for the full length forces decodeRun to walk all five rather
    // than stopping at the first.
    ;(addon as any).writeBytes(handle, code, hex)
    const run = (addon as any).decodeRun(handle, code, 19)
    expect(run.decodable).toBe(true)
    expect(run.length).toBe(19)

    // Both displacements are RIP-relative and measured from the END of
    // their own instruction, so they carry different values that must
    // nonetheless name the same slot. Getting either wrong writes the
    // captured pointer somewhere arbitrary, which no decode check catches.
    const bytes = hex.match(/../g) as string[]
    const readDisp32 = (at: number): bigint => {
      const le = bytes.slice(at, at + 4).reverse().join('')
      const raw = BigInt('0x' + le)
      return raw >= 0x80000000n ? raw - 0x100000000n : raw // sign-extend
    }
    const cmpEnd = BigInt(code) + 9n // pushfq(1) + cmp(8)
    const movEnd = BigInt(code) + 18n // ... + jne(2) + mov(7)
    expect(cmpEnd + readDisp32(4)).toBe(BigInt(slot))
    expect(movEnd + readDisp32(14)).toBe(BigInt(slot))

    // The jne must clear exactly the 7-byte mov, landing on the popfq —
    // one byte out and the blob returns with the flags still pushed.
    expect(bytes[9]).toBe('75')
    expect(bytes[10]).toBe('07')
  })

  it('leaves an already-populated slot alone', async () => {
    // The point of capture-once. The instruction a capture rides on is
    // usually shared — Valheim's health setter runs for every entity — so a
    // slot rewritten on each execution ends up holding whatever was touched
    // last rather than the object the user armed it on.
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    const code = '0x' + (BigInt(cave) + 8n).toString(16)
    const hex: string = (addon as any).encodeCaptureOnce('rcx', code, cave)

    // A non-zero slot means the compare fails and the jne skips the store.
    // Verified structurally here; the live proof is the end-to-end test.
    const bytes = hex.match(/../g) as string[]
    expect(bytes.slice(1, 3).join('')).toBe('4883') // cmp qword ptr ...
    expect(bytes[8]).toBe('00') // ... , 0
  })

  it('rejects an unknown register', () => {
    expect(() => (addon as any).encodeCaptureOnce('nope', '0x1000', '0x2000')).toThrow()
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

describe('capture injection — end to end', () => {
  it('records the object pointer where a value cheat can read it', async () => {
    ;(addon as any).startWriteWatch(harness.pid, forceAddress)
    await send('forceloop')
    let caught: any[] = []
    for (let i = 0; i < 40 && caught.length === 0; i++) {
      await sleep(50)
      caught = (addon as any).pollWriteWatch()
    }
    const insn = (addon as any).stopWriteWatch()[0]
    const site = insn.instructionAddress
    const run = (addon as any).decodeRun(handle, site, 5)
    const displaced = (addon as any).readBytes(handle, site, run.length)
    const cave: string = (addon as any).allocateCave(handle, site)

    const codeAddress = '0x' + (BigInt(cave) + 8n).toString(16)
    const captureAt = '0x' + (BigInt(codeAddress) + BigInt(displaced.length / 2)).toString(16)
    const effect = (addon as any).encodeCaptureOnce(insn.baseRegister, captureAt, cave)
    const returnTo = '0x' + (BigInt(site) + BigInt(run.length)).toString(16)
    const jumpBackFrom =
      '0x' + (BigInt(captureAt) + BigInt(effect.length / 2)).toString(16)
    const body = displaced + effect + (addon as any).encodeJump(jumpBackFrom, returnTo)
    ;(addon as any).writeBytes(handle, codeAddress, body)

    const padded =
      (addon as any).encodeJump(site, codeAddress) + '90'.repeat(run.length - 5)
    ;(addon as any).suspendThreads(handle, harness.pid)
    try {
      ;(addon as any).writeBytes(handle, site, padded)
    } finally {
      (addon as any).resumeThreads()
    }

    try {
      await sleep(300)
      const slotHex: string = (addon as any).readBytes(handle, cave, 8)
      // Little-endian: reverse the byte pairs to read the pointer.
      const pointer = BigInt(
        '0x' + (slotHex.match(/../g) as string[]).reverse().join('')
      )
      expect(pointer).not.toBe(0n)

      // The captured pointer must actually address the field the harness writes.
      expect('0x' + pointer.toString(16)).toBe(forceAddress)
    } finally {
      ;(addon as any).suspendThreads(handle, harness.pid)
      try {
        ;(addon as any).writeBytes(handle, site, displaced)
      } finally {
        (addon as any).resumeThreads()
      }
      await send('stopforce')
    }
  }, 30000)
})

describe('encodeGuardedSkip', () => {
  // The guard makes a SHARED write apply to one object only. NOPing Valheim's
  // damage write gave every enemy and destructible god mode along with the
  // player, because that instruction runs for all of them; this compares the
  // object register against a self-arming slot and skips the write for that
  // object alone.
  it('emits a fully decodable 41-byte guard', async () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave: string = (addon as any).allocateCave(handle, near)
    const code = '0x' + (BigInt(cave) + 8n).toString(16)
    const returnTo = '0x' + (BigInt(near) + 0x40n).toString(16)
    const hex: string = (addon as any).encodeGuardedSkip('rsi', code, cave, returnTo)

    expect(hex.length / 2).toBe(41)

    // Every byte must decode as real instructions. A hand-encoded blob with
    // two exit paths is exactly where a wrong ModRM hides — it would still
    // "work" until the game ran it.
    ;(addon as any).writeBytes(handle, code, hex)
    const run = (addon as any).decodeRun(handle, code, 41)
    expect(run.decodable).toBe(true)
    expect(run.length).toBe(41)
  })

  it('preserves flags and the scratch register on both paths', () => {
    const hex: string = (addon as any).encodeGuardedSkip('rsi', '0x1000', '0x2000', '0x3000')
    const bytes = hex.match(/../g) as string[]

    // pushfq / push r11 on entry — the compare below clobbers flags the
    // game's next instruction may depend on, and r11 may be live here.
    expect(bytes[0]).toBe('9c')
    expect(bytes.slice(1, 3).join('')).toBe('4153')

    // Both exits must pop what the entry pushed, in the right order, or the
    // stack is left skewed and the game dies somewhere unrelated.
    expect(bytes.slice(30, 33).join('')).toBe('415b9d') // skip path
    expect(bytes.slice(38, 41).join('')).toBe('415b9d') // run-original path
  })

  it('jumps to the return address on the skip path', () => {
    const at = 0x1000n
    const returnTo = 0x3000n
    const hex: string = (addon as any).encodeGuardedSkip('rsi', '0x1000', '0x2000', '0x3000')
    const bytes = hex.match(/../g) as string[]

    // The skip path's `jmp rel32` sits at offset 33 and is measured from the
    // end of its own 5 bytes. Wrong here and the guard returns into the
    // middle of an instruction rather than past the write it skipped.
    expect(bytes[33]).toBe('e9')
    const le = bytes.slice(34, 38).reverse().join('')
    const raw = BigInt('0x' + le)
    const rel = raw >= 0x80000000n ? raw - 0x100000000n : raw
    expect(at + 33n + 5n + rel).toBe(returnTo)
  })

  it('refuses to guard on the scratch register itself', () => {
    // r11 holds the remembered pointer, so guarding an instruction whose own
    // object register is r11 would have the push/pop fight the comparison.
    expect(() => (addon as any).encodeGuardedSkip('r11', '0x1000', '0x2000', '0x3000')).toThrow()
  })
})

describe('encodeImmuneGuard', () => {
  it('produces bytes that compare the arg register, skip on match, and fall through otherwise', () => {
    // playerPointerAddress: a memory location holding the address to
    // compare against. argRegister: which register holds "this" at the
    // hooked method's entry. caveCodeAddress: where this blob will be
    // written (needed to compute the internal jne's relative
    // displacement). returnAddress: where a non-matching call falls
    // through to, skipping straight past the (displaced) method body only
    // when the compare matches.
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave = (addon as any).allocateCave(handle, near)
    expect(cave).not.toBeNull()
    // Cave-relative, not a fixed literal: a real caller (patchEngine.apply)
    // always computes returnAddress from the cave it just allocated, which
    // is guaranteed to be within rel32 range of itself. A fixed literal like
    // 0x140000200 only works when the target happens to load near that
    // address (no ASLR) — this harness does not, so a literal here fails the
    // encoder's own (correct) out-of-range check for reasons that have
    // nothing to do with the encoding itself.
    const returnAddress = '0x' + (BigInt(cave) + 0x200n).toString(16)
    const bytes = (addon as any).encodeImmuneGuard('0x50000000', 'rcx', cave, returnAddress)
    expect(typeof bytes).toBe('string')
    expect(bytes.length).toBeGreaterThan(0)
    // Decodable by the existing decodeRun machinery — same safety bar
    // every other cave body meets. Write it into the cave at the SAME
    // address encodeImmuneGuard was told it would live at, so the
    // internal jne's relative displacement is actually correct here.
    expect((addon as any).writeBytes(handle, cave, bytes)).toBe(true)
    const decoded = (addon as any).decodeRun(handle, cave, bytes.length / 2)
    expect(decoded.decodable).toBe(true)
  })

  // The forced-return variants exist for a method like Character:GetHealth,
  // where the real CT table doesn't skip the method (there's no "0 damage
  // applied" equivalent for a getter) — it forces the VALUE the getter
  // returns instead. Same guard-and-return shape, only the tail differs.
  it('ends in mov eax,imm32 / ret for returnKind int32, instead of xor eax,eax', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave = (addon as any).allocateCave(handle, near)
    const returnAddress = '0x' + (BigInt(cave) + 0x200n).toString(16)
    const zeroBytes = (addon as any).encodeImmuneGuard('0x50000000', 'rcx', cave, returnAddress)
    const intBytes = (addon as any).encodeImmuneGuard(
      '0x50000000',
      'rcx',
      cave,
      returnAddress,
      'int32',
      9999
    )
    // Same guard prefix (mov rax,[..]; cmp; jne) — 'zero's tail is 3 bytes
    // (xor eax,eax; ret), so everything before that is the shared prefix.
    const guardPrefix = zeroBytes.slice(0, zeroBytes.length - 6)
    expect(intBytes.startsWith(guardPrefix)).toBe(true)
    // mov eax, 9999 (0x0000270f, little-endian) -> b8 0f 27 00 00 ; ret -> c3
    expect(intBytes.slice(guardPrefix.length)).toBe('b80f270000c3')
    expect((addon as any).writeBytes(handle, cave, intBytes)).toBe(true)
    const decoded = (addon as any).decodeRun(handle, cave, intBytes.length / 2)
    expect(decoded.decodable).toBe(true)
  })

  it('ends in mov eax,imm32 / movd xmm0,eax / ret for returnKind float', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave = (addon as any).allocateCave(handle, near)
    const returnAddress = '0x' + (BigInt(cave) + 0x200n).toString(16)
    // 9999.0's IEEE-754 bits — verified independently via
    // `new DataView(...).setFloat32(0, 9999.0, true)` rather than trusting
    // valueBits() to produce the same number this test asserts against.
    const floatBits = 0x461c3c00 // 9999.0f
    const bytes = (addon as any).encodeImmuneGuard(
      '0x50000000',
      'rcx',
      cave,
      returnAddress,
      'float',
      floatBits
    )
    // mov eax, 0x461c3c00 -> b8 003c1c46 (little-endian) ; movd xmm0,eax -> 660f6ec0 ; ret -> c3
    expect(bytes.slice(-20)).toBe('b8003c1c46660f6ec0c3')
    expect((addon as any).writeBytes(handle, cave, bytes)).toBe(true)
    const decoded = (addon as any).decodeRun(handle, cave, bytes.length / 2)
    expect(decoded.decodable).toBe(true)
  })

  it('rejects an unknown returnKind', () => {
    const near = (addon as any).attach(harness.pid).baseAddress
    const cave = (addon as any).allocateCave(handle, near)
    const returnAddress = '0x' + (BigInt(cave) + 0x200n).toString(16)
    expect(() =>
      (addon as any).encodeImmuneGuard('0x50000000', 'rcx', cave, returnAddress, 'bogus', 0)
    ).toThrow()
  })
})

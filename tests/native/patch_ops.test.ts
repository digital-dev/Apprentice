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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  const attached = (addon as any).attach(harness.pid)
  handle = attached.handle
  baseAddress = attached.baseAddress
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
  // Scan for whatever the counter currently holds rather than the hardcoded
  // initial 1000000: this helper may run more than once per harness process
  // (each caller drains the counter further, so by a later call it is some
  // smaller remainder, never back to 1000000). Sending a `setcount 1000000`
  // reset here would be wrong for a different reason — harness.c's command
  // loop reuses one `int val` local for every `set*` command, so a
  // `setcount N` call leaves N sitting at that fixed stack address too;
  // scanning for a value we are about to (re)send would pick up that decoy
  // address as a false candidate.
  const current = await count()
  let candidates = await (addon as any).scanFirst(handle, 'int32', current)
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

  it('reads up to 4096 bytes now, not just 64', () => {
    const bytes: string = (addon as any).readBytes(handle, baseAddress, 4096)
    expect(bytes.length).toBe(4096 * 2) // hex-encoded, 2 chars/byte
  })

  it('still rejects a request over the new cap', () => {
    expect(() => (addon as any).readBytes(handle, baseAddress, 4097)).toThrow()
  })

  it('raw mode returns a Buffer of the requested length, matching the hex mode byte-for-byte', () => {
    const hex: string = (addon as any).readBytes(handle, baseAddress, 16)
    const raw: Buffer = (addon as any).readBytes(handle, baseAddress, 16, true)
    expect(Buffer.isBuffer(raw)).toBe(true)
    expect(raw.length).toBe(16)
    expect(raw.toString('hex')).toBe(hex)
  })
})

describe('writeBytes rejects malformed hex', () => {
  // Each of these previously slipped past HexToBytes's strtoul-based check:
  // 'zz' (not hex digits at all), '-1-1' (strtoul honors the sign),
  // '+1' (strtoul honors the sign), ' a' (strtoul skips leading
  // whitespace), '123' (odd length), and '' (empty). None of them may
  // reach WriteProcessMemory — writeBytes must return false, and the
  // bytes at the target address must be byte-for-byte unchanged.
  //
  // Target address: the harness module's own base address (from attach()),
  // not a scanned counter address. It is always mapped and readable (it's
  // the PE header) and never mutated by anything else in this suite, so
  // these checks stay fast and deterministic without needing a fresh scan
  // or the write-watch capture.
  const malformed = ['zz', '-1-1', '+1', ' a', '123', '']

  it.each(malformed)('returns false and leaves memory untouched for %j', (bad) => {
    const before = (addon as any).readBytes(handle, baseAddress, 4)

    expect((addon as any).writeBytes(handle, baseAddress, bad)).toBe(false)

    const after = (addon as any).readBytes(handle, baseAddress, 4)
    expect(after).toBe(before)
  })
})

describe('readBytes on an unreadable address', () => {
  it('throws instead of returning garbage', () => {
    // Low, unmapped addresses in the target's address space are never
    // backed by a committed page, so ReadProcessMemory fails reliably.
    expect(() => (addon as any).readBytes(handle, '0x1', 4)).toThrow()
  })
})

describe('scanAob', () => {
  it('relocates the drain instruction by signature and patches it there', async () => {
    const insn = await catchDrainInstruction()
    const original = (addon as any).readBytes(handle, insn.instructionAddress, insn.length)

    const matches: string[] = await (addon as any).scanAob(handle, insn.signature)
    // Uniqueness is the whole contract, not a nicety: PatchEngine refuses to
    // patch anything that doesn't resolve to exactly one address, so a
    // signature matching twice is as useless as one matching zero times.
    // This assertion used to be a bare toContain, which passed happily while
    // the generator emitted 2-byte signatures matching 992 places — the bug
    // only surfaced against a real game.
    expect(matches).toHaveLength(1)

    // A signature covers the method AROUND the instruction, not just the
    // bytes from it forward, so a match is the start of that context and
    // the instruction sits signatureOffset bytes into it. Extending forward
    // instead used to work here only because this harness is a static
    // binary, where the padding and neighbouring code past a `ret` never
    // move; in JIT'd code they do, and a signature built on them stopped
    // matching after a game restart.
    expect(insn.signatureOffset).toBeGreaterThan(0)
    const expected =
      '0x' + (BigInt(insn.instructionAddress) - BigInt(insn.signatureOffset)).toString(16)
    expect(matches[0]).toBe(expected)

    // Patching at the SCANNED address stepped forward by the offset (not at
    // the captured address) must have the same effect — this is exactly the
    // path a patch takes after a game restart.
    const found =
      '0x' + (BigInt(matches[0]) + BigInt(insn.signatureOffset)).toString(16)
    expect(found).toBe(insn.instructionAddress)
    const nops = '90'.repeat(insn.length)
    expect((addon as any).writeBytes(handle, found, nops)).toBe(true)

    await send('drainloop')
    await sleep(150)
    const a = await count()
    await sleep(300)
    const b = await count()
    expect(b).toBe(a)

    expect((addon as any).writeBytes(handle, found, original)).toBe(true)
    await sleep(300)
    expect(await count()).toBeLessThan(b)
    await send('stopdrain')
  }, 30000)

  it('returns an empty list for a signature that matches nothing', async () => {
    const matches: string[] = await (addon as any).scanAob(
      handle,
      'de ad be ef de ad be ef de ad be ef'
    )
    expect(matches).toEqual([])
  })

  it('rejects a malformed signature', () => {
    // scanAob throws synchronously for a malformed signature (the parse
    // happens before the AsyncWorker is queued), so `rejects.toThrow()`
    // proved brittle here; this form matches the actual throw site.
    expect(() => (addon as any).scanAob(handle, 'zz 11')).toThrow()
  })
})

describe('scanAob bounds', () => {
  it('finds a pattern inside the given range and not outside it', async () => {
    const reply = await send('loaddll')
    const base = reply.split(' ')[1]
    const mods = (addon as any).listModules(handle)
    const probe = mods.find((m: any) => m.name.toLowerCase() === 'probe.dll')
    const end = '0x' + (BigInt(probe.base) + BigInt(probe.size)).toString(16)

    // Take a real byte run out of the probe's code and scan for it. Not
    // probe.base itself — that's the PE header (DOS/NT headers), which sits
    // on a non-executable page, and scanAob only ever walks executable
    // regions (by design — see RunScanAob's comment). 0x1000 is past the
    // headers and into .text (confirmed against probe.c's actual layout);
    // PAD_SIZE only grows g_pad at the end of the image, so this offset is
    // stable across both probe.dll build variants.
    const codeAddress = '0x' + (BigInt(probe.base) + 0x1000n).toString(16)
    const someCode = (addon as any).readBytes(handle, codeAddress, 16)
    const sig = (someCode.match(/../g) as string[]).join(' ')

    const inRange = await (addon as any).scanAob(handle, sig, base, end)
    expect(inRange.length).toBeGreaterThan(0)

    // A range that ends before the module starts cannot contain it.
    const belowEnd = '0x' + (BigInt(probe.base) - 1n).toString(16)
    const outOfRange = await (addon as any).scanAob(handle, sig, '0x1000', belowEnd)
    expect(outOfRange).not.toContain(codeAddress)

    await send('unloaddll')
  })

  it('with no bounds behaves as before', async () => {
    // The existing unbounded call must keep working unchanged — this is the
    // back-compat guarantee every existing caller relies on.
    const matches = await (addon as any).scanAob(handle, '90 90 90 90')
    expect(Array.isArray(matches)).toBe(true)
  })
})

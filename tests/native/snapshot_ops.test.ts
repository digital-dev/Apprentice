import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

const a = addon as any

// mov [rcx+0x10], eax ; ret   -> 89 41 10 c3
const CODE = Buffer.from([0x89, 0x41, 0x10, 0xc3])
const regions = [{ base: '0x1000', bytes: CODE }]

describe('snapshot exports', () => {
  it('snapshotScanAob finds an exact and a wildcarded pattern', () => {
    expect(a.snapshotScanAob(regions, '89 41 10 c3')).toEqual(['0x1000'])
    expect(a.snapshotScanAob(regions, '89 ?? 10')).toEqual(['0x1000'])
    expect(a.snapshotScanAob(regions, 'de ad')).toEqual([])
  })

  it('does not match across a region boundary', () => {
    const split = [
      { base: '0x1000', bytes: Buffer.from([0x89, 0x41]) },
      { base: '0x1002', bytes: Buffer.from([0x10, 0xc3]) }
    ]
    expect(a.snapshotScanAob(split, '89 41 10')).toEqual([])
  })

  it('finds every match, in address order', () => {
    const two = [
      { base: '0x2000', bytes: Buffer.from([0x90, 0xc3]) },
      { base: '0x1000', bytes: Buffer.from([0xc3, 0x90]) }
    ]
    expect(a.snapshotScanAob(two, 'c3')).toEqual(['0x1000', '0x2001'])
  })

  it('rejects a malformed signature', () => {
    expect(() => a.snapshotScanAob(regions, 'zz')).toThrow()
    expect(() => a.snapshotScanAob(regions, '')).toThrow()
  })

  it('snapshotDecodeRun reports length and relocatability', () => {
    const r = a.snapshotDecodeRun(regions, '0x1000', 3)
    expect(r.decodable).toBe(true)
    expect(r.length).toBe(3)
    expect(r.relocatable).toBe(true)
  })

  it('snapshotDecodeRun is not decodable when the run leaves the region', () => {
    const r = a.snapshotDecodeRun(regions, '0x1000', 16)
    expect(r.decodable).toBe(false)
  })

  it('snapshotBuildSignature returns null outside every region', () => {
    expect(a.snapshotBuildSignature(regions, '0x9000', 3)).toBeNull()
  })

  it('a read that touches an unrecorded byte is unreadable (all-or-nothing, like live)', () => {
    // 20 bytes of code; the builder wants 64 before and 128 after the site.
    const code = Buffer.alloc(20, 0x90)
    code[16] = 0x89; code[17] = 0x41; code[18] = 0x10; code[19] = 0xc3
    const bare = [{ base: '0x1000', bytes: code }]
    const bareSig = a.snapshotBuildSignature(bare, '0x1010', 3)
    // No margins: the 192-byte window cannot be read, so it falls back to a
    // forward-only window, which is too short (<48) here and yields just the
    // instruction's own bytes.
    expect(bareSig.signatureOffset).toBe(0)
    expect(bareSig.signature).toBe('89 41 10')

    // With a recorded post margin the forward window is readable, but with no
    // pre margin the initial (lookBack) read is still refused, so the
    // builder takes the forward-only path and sees the whole method tail.
    const post = Buffer.alloc(128, 0xcc)
    const withPost = a.snapshotBuildSignature([{ ...bare[0], post }], '0x1010', 3)
    expect(withPost.signatureOffset).toBe(0)
    expect(withPost.signature.startsWith('89 41 10 c3')).toBe(true)
  })

  it('pre and post margins let the builder use its lead-in, clamped to the region', () => {
    const code = Buffer.alloc(20, 0x90)
    code[16] = 0x89; code[17] = 0x41; code[18] = 0x10; code[19] = 0xc3
    const pre = Buffer.alloc(64, 0xcc)
    const post = Buffer.alloc(128, 0xcc)
    const sig = a.snapshotBuildSignature([{ base: '0x1000', bytes: code, pre, post }], '0x1010', 3)
    // Lead-in (the nops before the store) is used, never reaching before base.
    expect(sig.signatureOffset).toBeGreaterThan(0)
    expect(sig.signatureOffset).toBeLessThanOrEqual(0x10)
  })

  it('snapshotBuildSignature covers the instruction, clamped to its region', () => {
    const sig = a.snapshotBuildSignature(regions, '0x1000', 3)
    expect(sig.signature.startsWith('89 41 10')).toBe(true)
    expect(sig.signatureOffset).toBe(0)
  })
})

// The real proof: on a live process, a snapshot of its executable memory must
// give the same signature and the same scan results as the live code paths.
describe('snapshot equals live (harness differential)', () => {
  let harness: ChildProcessWithoutNullStreams
  let handle: number

  const send = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      harness.stdout.once('data', (d) => resolve(d.toString().trim()))
      harness.stdin.write(cmd + '\n')
    })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  beforeAll(async () => {
    harness = spawn(path.resolve('test-harness/harness.exe'))
    await new Promise((r) => harness.stdout.once('data', r))
    handle = a.attach(harness.pid).handle
  })

  afterAll(() => {
    try { a.stopWriteWatch() } catch { /* ignore */ }
    harness.stdin.write('q\n')
    harness.kill()
  })

  it('rebuilds the captured signature and finds it where the live scan does', async () => {
    let candidates = await a.scanFirst(handle, 'float', 77.0)
    await send('setp 33')
    candidates = await a.scanNext(handle, candidates, 'float', { mode: 'exact', value: 33 })
    expect(candidates.length).toBe(1)

    a.startWriteWatch(harness.pid, candidates[0].address)
    await send('watchloop')
    let list: any[] = []
    for (let i = 0; i < 40 && list.length === 0; i++) {
      await sleep(50)
      list = a.pollWriteWatch()
    }
    await send('stoploop')
    const insn = a.stopWriteWatch()[0]
    expect(insn).toBeDefined()

    // Margins: the builder reads a window starting 64 bytes before the
    // instruction and running 128 past it, and a live read crosses region
    // edges. Record what is readable there or a site near an edge diverges.
    const regions = a.listExecRegions(handle).map((r: any) => {
      const base = BigInt(r.base)
      return {
        base: r.base,
        bytes: a.readRegionBuffer(handle, r.base, r.size),
        pre: a.readRegionBuffer(handle, '0x' + (base - 64n).toString(16), 64),
        post: a.readRegionBuffer(handle, '0x' + (base + BigInt(r.size)).toString(16), 128)
      }
    })
    expect(regions.length).toBeGreaterThan(0)
    for (const r of regions) expect(r.bytes).not.toBeNull()

    const snap = a.snapshotBuildSignature(regions, insn.instructionAddress, insn.length)
    expect(snap.signature).toBe(insn.signature)
    expect(snap.signatureOffset).toBe(insn.signatureOffset)

    const live: string[] = await a.scanAob(handle, insn.signature)
    expect(a.snapshotScanAob(regions, insn.signature)).toEqual([...live].sort())
    expect(live.length).toBe(1)
  }, 30000)
})

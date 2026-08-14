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
  await new Promise((r) => harness.stdout.once('data', r)) // consume "PID n" line
  handle = (addon as any).attach(harness.pid).handle
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

interface Candidate {
  address: string
  value: number
}

describe('scanFirst / scanNext', () => {
  it('finds the harness health value and narrows it after a change', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'int32', 100)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 100)).toBe(true)

    await send('set 55')
    candidates = await (addon as any).scanNext(handle, candidates, 'int32', {
      mode: 'exact',
      value: 55
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 55)).toBe(true)

    await send('set 999')
    // Each candidate's own recorded value (55, from the previous step) is
    // what "increased" compares against now — no separately-supplied
    // previous array, proving the per-candidate tracking works across two
    // chained relative-filter steps, not just the first one.
    candidates = await (addon as any).scanNext(handle, candidates, 'int32', {
      mode: 'increased'
    })
    expect(candidates.length).toBe(1)
    expect(candidates[0].value).toBe(999)
  })

  it('scanNext returns a Promise and resolves with the filtered candidates', async () => {
    await send('set 100')
    const candidates = await (addon as any).scanFirst(handle, 'int32', 100)
    await send('set 55')
    const result = (addon as any).scanNext(handle, candidates, 'int32', {
      mode: 'exact',
      value: 55
    })
    expect(result).toBeInstanceOf(Promise)
    const filtered = await result
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.every((c: Candidate) => c.value === 55)).toBe(true)
  })

  it('finds the harness stamina value as a float and narrows it after a change', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'float', 100.0)
    expect(candidates.length).toBeGreaterThan(0)

    await send('setf 42.5')
    candidates = await (addon as any).scanNext(handle, candidates, 'float', {
      mode: 'exact',
      value: 42.5
    })
    expect(candidates.length).toBe(1)

    // readValue's chain walk with an empty offsets array is just "read at
    // base" (no add, no deref), so this directly verifies the scanned
    // address really holds 42.5 as a float, not just that it was reported.
    const value = (addon as any).readValue(handle, candidates[0].address, [], 'float')
    expect(value).toBeCloseTo(42.5, 4)
  })

  it('chains decreased then increased using each candidate\'s own tracked value', async () => {
    await send('setf 100.0')
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'float', 100.0)
    expect(candidates.length).toBeGreaterThan(0)

    await send('setf 50.0')
    candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'decreased' })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 50)).toBe(true)

    await send('setf 80.0')
    candidates = await (addon as any).scanNext(handle, candidates, 'float', { mode: 'increased' })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 80)).toBe(true)
  })

  it('finds and narrows an int16 value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'int16', 12345)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 12345)).toBe(true)

    await send('seti16 -500')
    candidates = await (addon as any).scanNext(handle, candidates, 'int16', {
      mode: 'exact',
      value: -500
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === -500)).toBe(true)
  })

  it('finds and narrows an int8 value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'int8', 42)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 42)).toBe(true)

    await send('seti8 200')
    candidates = await (addon as any).scanNext(handle, candidates, 'int8', {
      mode: 'exact',
      value: 200
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 200)).toBe(true)
  })

  it('finds and narrows an int64 value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'int64', 123456789012345)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 123456789012345)).toBe(true)

    await send('seti64 987654321098765')
    candidates = await (addon as any).scanNext(handle, candidates, 'int64', {
      mode: 'exact',
      value: 987654321098765
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 987654321098765)).toBe(true)
  })

  // RunScanFirst reads each committed region in 4 MiB chunks instead of
  // allocating the whole region. The one thing chunking can silently break
  // is a value that STRADDLES a chunk boundary — and it is reachable for
  // real, not hypothetically: int64/double are 8 bytes but scan on a 4-byte
  // stride, so a value starting 4 bytes before a chunk boundary is a
  // genuine scan position whose last 4 bytes fall in the next chunk. Without
  // the (size - 1) read overlap, chunk 0 stops at boundary-8 and chunk 1
  // starts at boundary, so this address is visited by neither.
  it('finds an int64 straddling a 4 MiB region-read chunk boundary, and re-bases later chunks correctly', async () => {
    const reply = await send('bigalloc')
    const base = reply.split(' ')[1]
    expect(base).toMatch(/^0x/)
    const CHUNK = 4 * 1024 * 1024

    const straddling: Candidate[] = await (addon as any).scanFirst(handle, 'int64', 1122334455667788)
    const straddleAddress = '0x' + (BigInt(base) + BigInt(CHUNK - 4)).toString(16)
    expect(straddling.map((c) => c.address)).toContain(straddleAddress)

    // A marker deep inside the SECOND chunk: a match here is only reported
    // at the right address if each hit is re-based onto its own chunk's
    // base rather than the region base.
    const secondChunk: Candidate[] = await (addon as any).scanFirst(handle, 'int32', 24681357)
    const secondChunkAddress = '0x' + (BigInt(base) + BigInt(CHUNK + 0x1000)).toString(16)
    expect(secondChunk.map((c) => c.address)).toContain(secondChunkAddress)

    await send('bigallocfree')
  }, 30000)

  it('finds and narrows a double value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'double', 123.456)
    expect(candidates.length).toBeGreaterThan(0)

    await send('setd 9.5')
    candidates = await (addon as any).scanNext(handle, candidates, 'double', {
      mode: 'exact',
      value: 9.5
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 9.5)).toBe(true)
  })
})

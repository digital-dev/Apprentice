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

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  const attached = (addon as any).attach(harness.pid)
  handle = attached.handle
  baseAddress = attached.baseAddress
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
    candidates = await (addon as any).scanNext(handle, candidates, 'int32', {
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

  it('reads and writes an int16 value directly', async () => {
    let candidates: { address: string; value: number }[] = await (addon as any).scanFirst(
      handle,
      'int16',
      12345
    )
    expect(candidates.length).toBeGreaterThan(0)
    const target = candidates[0].address

    const before = (addon as any).readValue(handle, target, [], 'int16')
    expect(before).toBe(12345)

    const ok = (addon as any).writeValue(handle, target, [], 'int16', -1000)
    expect(ok).toBe(true)

    const reply = await send('geti16')
    expect(reply).toBe('OK -1000')
  })

  it('reads and writes an int8 value directly', async () => {
    // A raw byte value like 42 is common enough elsewhere in the process
    // that scanFirst alone doesn't reliably land on g_int8 (unlike the
    // wider int16 case above), so narrow with scanNext against a distinct
    // value first, the same way scanner.test.ts's own int8 test does.
    let candidates: { address: string; value: number }[] = await (addon as any).scanFirst(
      handle,
      'int8',
      42
    )
    expect(candidates.length).toBeGreaterThan(0)

    await send('seti8 200')
    candidates = await (addon as any).scanNext(handle, candidates, 'int8', {
      mode: 'exact',
      value: 200
    })
    expect(candidates.length).toBeGreaterThan(0)
    const target = candidates[0].address

    const before = (addon as any).readValue(handle, target, [], 'int8')
    expect(before).toBe(200)

    const ok = (addon as any).writeValue(handle, target, [], 'int8', 77)
    expect(ok).toBe(true)

    const reply = await send('geti8')
    expect(reply).toBe('OK 77')
  })

  // Regression: WriteValue used to call WriteProcessMemory directly with no
  // protect/restore dance, unlike patch_ops.cc's WriteBytes — a write to a
  // non-writable page (the harness's own .text section here, matching
  // patch_ops.test.ts's `probe.base + 0x1000` past-the-headers convention)
  // silently failed. 0x1000 is past the PE headers (which sit on a
  // non-executable page) and into the harness's own .text, which is
  // PAGE_EXECUTE_READ, not writable.
  it('writeValue succeeds against a page that is not already writable', () => {
    const codeAddr = '0x' + (BigInt(baseAddress) + 0x1000n).toString(16)
    const ok = (addon as any).writeValue(handle, codeAddr, [], 'int8', 0x90)
    expect(ok).toBe(true)
  })

  // Regression: the shared protect/restore helper originally refused ANY
  // write straddling a page boundary — a rule that is load-bearing for
  // patch_ops.cc's code patching but wrong for ordinary data writes, which
  // spanned pages happily through a bare WriteProcessMemory before that
  // helper existed. An 8-byte value landing in the last few bytes of a page
  // is rare but perfectly legal, and silently failing it would break a value
  // cheat permanently with no explanation. The straddle is now handled per
  // page instead of refused.
  //
  // The module base is page-aligned, so base + 0x1000 - 4 puts 4 bytes on the
  // PE-header page and 4 on the first .text page — two different, both
  // non-writable, protections: exactly the case that used to fail.
  function straddlingWriteRoundTrip(dataType: string, value: number): void {
    const straddle = '0x' + (BigInt(baseAddress) + 0x1000n - 4n).toString(16)
    const original: string = (addon as any).readBytes(handle, straddle, 8)

    expect((addon as any).writeValue(handle, straddle, [], dataType, value)).toBe(true)
    expect((addon as any).readValue(handle, straddle, [], dataType)).toBe(value)

    // Put the harness's own bytes back, one byte at a time so each write
    // stays within a single page, so later tests in this file (and the
    // harness process itself) see the binary they expect.
    for (let i = 0; i < 8; i++) {
      const byteAddr = '0x' + (BigInt(straddle) + BigInt(i)).toString(16)
      const byte = parseInt(original.slice(i * 2, i * 2 + 2), 16)
      expect((addon as any).writeValue(handle, byteAddr, [], 'int8', byte)).toBe(true)
    }
    expect((addon as any).readBytes(handle, straddle, 8)).toBe(original)
  }

  it('writeValue of an int64 straddling a page boundary succeeds', () => {
    straddlingWriteRoundTrip('int64', 1234567)
  })

  it('writeValue of a double straddling a page boundary succeeds', () => {
    straddlingWriteRoundTrip('double', 2.5)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness } from '../helpers/spawnHarness'
import addon from '../../native/build/Release/memory_addon.node'

// The Linux read side (maps-backed regions, process_vm_readv reads) against
// real mappings the harness creates and destroys on command. Windows has its
// own VirtualQueryEx/ReadProcessMemory behaviour covered by the other files.
const a = addon as any

function send(harness: ChildProcessWithoutNullStreams, cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

describe.skipIf(process.platform === 'win32')('linux regions and reads', () => {
  let harness: ChildProcessWithoutNullStreams
  let handle: number

  beforeAll(async () => {
    harness = spawnHarness()
    await new Promise((r) => harness.stdout.once('data', r))
    handle = a.attach(harness.pid).handle
  })

  afterAll(() => {
    harness.stdin.write('q\n')
    harness.kill()
  })

  const hex = (n: bigint) => '0x' + n.toString(16)

  it('reports a read-write mapping as readable and writable, not executable', async () => {
    const reply = await send(harness, 'bigalloc')
    expect(reply).toMatch(/^OK 0x[0-9a-f]+$/)
    const base = BigInt(reply.split(' ')[1])
    const r = a.platformQueryRegion(handle, hex(base + 0x1234n))
    expect(r.free).toBe(false)
    expect(r.readable).toBe(true)
    expect(r.writable).toBe(true)
    expect(r.executable).toBe(false)
    expect(r.size).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    // The 8 MiB marker the harness wrote reads back through a chunk boundary.
    expect(a.readBytes(handle, hex(base + 4n * 1024n * 1024n - 4n), 8)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reports a read-execute mapping as readable and executable, not writable', async () => {
    const reply = await send(harness, 'bigcode')
    const base = BigInt(reply.split(' ')[1])
    const r = a.platformQueryRegion(handle, hex(base))
    expect(r.free).toBe(false)
    expect(r.readable).toBe(true)
    expect(r.executable).toBe(true)
    expect(r.writable).toBe(false)
    await send(harness, 'bigcodefree')
  })

  it('reports an unmapped address as free and refuses to read it, with no stale answer', async () => {
    const reply = await send(harness, 'bigalloc')
    const base = BigInt(reply.split(' ')[1])
    expect(a.platformQueryRegion(handle, hex(base)).free).toBe(false)
    await send(harness, 'bigallocfree')
    // A single lookup right after the unmap must see the unmap.
    const r = a.platformQueryRegion(handle, hex(base + 0x1000n))
    expect(r).not.toBeNull()
    expect(r.free).toBe(true)
    expect(r.readable).toBe(false)
    expect(r.writable).toBe(false)
    expect(r.executable).toBe(false)
    expect(() => a.readBytes(handle, hex(base), 16)).toThrow()
  })

  it('reports the null page as free', () => {
    const r = a.platformQueryRegion(handle, '0x0')
    expect(r.free).toBe(true)
  })

  it('walking regions upward from 0 terminates; a read straddling mapped into free memory fails whole', () => {
    let addr = 0n
    let steps = 0
    let sawMapped = false
    let sawFree = false
    let straddleAt: bigint | null = null
    let prevReadableEnd: bigint | null = null
    for (;;) {
      const r = a.platformQueryRegion(handle, hex(addr))
      if (r === null) break
      if (r.free) {
        sawFree = true
        if (prevReadableEnd !== null && straddleAt === null) straddleAt = prevReadableEnd
      } else {
        sawMapped = true
      }
      prevReadableEnd = !r.free && r.readable ? addr + BigInt(r.size) : null
      expect(r.size).toBeGreaterThan(0)
      addr += BigInt(r.size)
      if (++steps > 100000) throw new Error('region walk did not terminate')
    }
    expect(sawMapped && sawFree).toBe(true)
    // A readable mapping directly followed by a free gap: the last 8 bytes read,
    // 8 bytes more (into the gap) is refused rather than returned short.
    expect(straddleAt).not.toBeNull()
    expect(a.readBytes(handle, hex(straddleAt! - 8n), 8)).toMatch(/^[0-9a-f]{16}$/)
    expect(() => a.readBytes(handle, hex(straddleAt! - 8n), 16)).toThrow()
  })

  it('returns false/null instead of hanging or throwing once the target has exited', async () => {
    const victim = spawnHarness()
    await new Promise((r) => victim.stdout.once('data', r))
    const h = a.attach(victim.pid).handle
    expect(a.platformQueryRegion(h, '0x1000')).not.toBeNull()
    await new Promise<void>((resolve) => {
      victim.once('exit', () => resolve())
      victim.kill('SIGKILL')
    })
    expect(a.platformQueryRegion(h, '0x1000')).toBeNull()
    expect(() => a.readBytes(h, '0x1000', 8)).toThrow()
    a.detach(h)
  })
})

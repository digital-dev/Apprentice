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
})

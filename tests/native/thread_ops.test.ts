import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('listThreads', () => {
  it('includes at least one thread owned by the harness', () => {
    const threads = (addon as any).listThreads(harness.pid) as { tid: number }[]
    expect(threads.length).toBeGreaterThan(0)
    expect(threads[0]).toHaveProperty('tid')
    expect(typeof threads[0].tid).toBe('number')
  })

  it('returns an empty array for a pid that owns no threads', () => {
    // A pid this large cannot correspond to any real process, so no
    // thread's th32OwnerProcessID will ever match it.
    //
    // (The brief's original version of this test used pid 0 — the System
    // Idle Process — on the assumption that it "never owns threads".
    // Verified false on this machine: CreateToolhelp32Snapshot legitimately
    // reports pid 0 as owning one Toolhelp-visible thread entry per
    // logical processor (96 here, confirmed independently via
    // `Get-CimInstance Win32_Thread | where ProcessHandle -eq 0`), so
    // asserting an empty array for pid 0 fails against real Windows
    // behavior, not against this addon.)
    const threads = (addon as any).listThreads(999999999) as { tid: number }[]
    expect(threads).toEqual([])
  })
})

describe('getThreadRegisters', () => {
  it('returns a full register snapshot for a live harness thread', () => {
    const threads = (addon as any).listThreads(harness.pid) as { tid: number }[]
    const regs = (addon as any).getThreadRegisters(threads[0].tid) as Record<string, string>
    expect(regs).not.toBeNull()
    for (const key of ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'rip',
      'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rflags']) {
      expect(regs[key]).toMatch(/^0x[0-9a-f]+$/)
    }
    // rip must be non-zero — the thread is genuinely executing somewhere.
    expect(BigInt(regs.rip)).toBeGreaterThan(0n)
  })

  it('returns null for a tid that does not exist', () => {
    const regs = (addon as any).getThreadRegisters(999999999)
    expect(regs).toBeNull()
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

let harness: ChildProcessWithoutNullStreams

beforeAll(() => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('listProcesses', () => {
  it('includes the running test harness by pid and name', () => {
    const procs = (addon as any).listProcesses() as { pid: number; name: string }[]
    const match = procs.find((p) => p.pid === harness.pid)
    expect(match).toBeDefined()
    expect(match!.name.toLowerCase()).toBe('harness.exe')
  })
})

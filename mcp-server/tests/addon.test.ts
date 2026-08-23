import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import * as addon from '../src/addon'

let harness: ChildProcessWithoutNullStreams

beforeAll(async () => {
  harness = spawn(path.resolve(__dirname, '../../test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('addon wrapper', () => {
  it('lists processes and finds the harness among them', () => {
    const processes = addon.listProcesses()
    expect(processes.some((p) => p.pid === harness.pid)).toBe(true)
  })

  it('attaches and reads a base address', () => {
    const { handle, baseAddress } = addon.attach(harness.pid as number)
    expect(handle).toBeGreaterThan(0)
    expect(baseAddress).toMatch(/^0x[0-9a-f]+$/)
  })

  it('tryReadBytes returns null rather than throwing on an unreadable address', () => {
    const { handle } = addon.attach(harness.pid as number)
    expect(addon.tryReadBytes(handle, '0x1', 4)).toBeNull()
  })

  it('tryReadValue returns null rather than throwing on an unreadable address', () => {
    const { handle } = addon.attach(harness.pid as number)
    expect(addon.tryReadValue(handle, '0x1', [], 'int32')).toBeNull()
  })
})

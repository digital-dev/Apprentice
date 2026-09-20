import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'

// Runs the shipped Double Hovered Stack script against a synthetic copy of the
// game's pointer chain built in the harness process's memory, so the chain
// walk, the guards and the write are proven before it touches a real game.

const a = addon as any
let harness: ChildProcessWithoutNullStreams
let handle: number
let base: bigint

const draft = JSON.parse(fs.readFileSync(path.resolve('games/Schedule I.draft.json'), 'utf8'))
const script: string = draft.cheats.find((c: any) => c.id === 'factory-double-hovered-stack').enableScript

const hex = (n: bigint) => '0x' + n.toString(16)
function put64(off: number, v: bigint) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(v)
  expect(a.writeBytes(handle, hex(base + BigInt(off)), b.toString('hex'))).toBe(true)
}
function putI32(off: number, v: number) {
  const b = Buffer.alloc(4)
  b.writeInt32LE(v)
  expect(a.writeBytes(handle, hex(base + BigInt(off)), b.toString('hex'))).toBe(true)
}
const getI32 = (off: number) =>
  Buffer.from(a.readBytes(handle, hex(base + BigInt(off)), 4), 'hex').readInt32LE(0)

// Layout inside one scratch page: manager, slot UI, slot, instance.
const MGR = 0x000, UI = 0x100, SLOT = 0x200, INST = 0x300

function build(quantity: number) {
  put64(MGR + 0x30, base + BigInt(UI))
  put64(UI + 0x28, base + BigInt(SLOT))
  put64(SLOT + 0x10, base + BigInt(INST))
  putI32(INST + 0x10, quantity)
}
const run = () => a.runScript(handle, script, { mgr: hex(base + BigInt(MGR)) })

beforeAll(async () => {
  harness = spawn(path.resolve('test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
  handle = a.attach(harness.pid).handle
  const cave = a.allocateCave(handle, a.getModuleBase(handle, 'harness.exe') ?? '0x10000')
  expect(cave).not.toBeNull()
  base = BigInt(cave)
})
afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('Double Hovered Stack script', () => {
  it('doubles a full stack past the max: 40 -> 80', async () => {
    build(40)
    const r = await run()
    expect(r.error).toBeNull()
    expect(r.success).toBe(true)
    expect(getI32(INST + 0x10)).toBe(80)
    expect(r.output.join('\n')).toContain('40 -> 80')
  })

  it('doubles again on the next press', async () => {
    build(40)
    await run()
    await run()
    expect(getI32(INST + 0x10)).toBe(160)
  })

  it('refuses, and writes nothing, when no slot is hovered', async () => {
    build(40)
    put64(MGR + 0x30, 0n)
    const r = await run()
    expect(r.success).toBe(false)
    expect(r.error).toContain('Hover an item slot')
    expect(getI32(INST + 0x10)).toBe(40)
  })

  it('refuses an empty slot', async () => {
    build(40)
    put64(SLOT + 0x10, 0n)
    const r = await run()
    expect(r.success).toBe(false)
    expect(r.error).toContain('empty')
  })

  it('refuses when the manager was never captured', async () => {
    const r = await a.runScript(handle, script, {})
    expect(r.success).toBe(false)
    expect(r.error).toContain('not captured')
  })

  it('leaves an implausible quantity alone rather than corrupting it', async () => {
    build(0x7fffffff)
    const r = await run()
    expect(r.success).toBe(false)
    expect(getI32(INST + 0x10)).toBe(0x7fffffff)
  })
})

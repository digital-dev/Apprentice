import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'
import { decodeSnapshot, encodeSnapshot, snapshotSha256, type Snapshot } from '../../src/main/replay/snapshotFile'
import { ReplayOps, type ReplayAddon } from '../../src/main/replay/replayOps'

const native = addon as unknown as ReplayAddon

// mov [rcx+0x10], eax ; ret
const CODE = Buffer.from([0x89, 0x41, 0x10, 0xc3])

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    game: 'test',
    build: 'b1',
    modules: [{ name: 'Game.exe', base: '0x1000', size: 0x1000, timestamp: 7 }],
    regions: [
      { base: '0x1000', bytes: CODE, pre: Buffer.from([0xcc, 0xcc]), post: Buffer.from([0x90, 0x90]) },
      { base: '0x9000', bytes: Buffer.from([0xde, 0xad]) }
    ],
    sites: [{ id: 'drain', address: '0x1000', length: 3 }],
    ...over
  }
}

describe('snapshot file', () => {
  it('round-trips, margins and all', () => {
    const s = snap()
    const back = decodeSnapshot(encodeSnapshot(s))
    expect(back).toEqual(s)
  })

  it('has a stable sha256 for identical content', () => {
    expect(snapshotSha256(encodeSnapshot(snap()))).toBe(snapshotSha256(encodeSnapshot(snap())))
    expect(snapshotSha256(encodeSnapshot(snap()))).not.toBe(
      snapshotSha256(encodeSnapshot(snap({ build: 'b2' })))
    )
  })

  it('rejects a truncated file rather than returning short regions', () => {
    const file = encodeSnapshot(snap())
    expect(() => decodeSnapshot(file.subarray(0, 10))).toThrow()
  })
})

describe('ReplayOps', () => {
  const ops = () => new ReplayOps(snap(), native)

  it('reads inside a region, and across into a recorded margin', () => {
    expect(ops().readBytes('0x1000', 4)).toBe('894110c3')
    expect(ops().readBytes('0x1002', 4)).toBe('10c39090') // body then post margin
    expect(ops().readBytes('0xffe', 4)).toBe('cccc8941') // pre margin then body
  })

  it('reads as unreadable when any byte was not recorded', () => {
    expect(ops().readBytes('0x1000', 7)).toBeNull() // runs past the post margin
    expect(ops().readBytes('0x5000', 1)).toBeNull()
  })

  it('scanAob returns addresses and honours a range like the live scan', async () => {
    expect(await ops().scanAob('89 41 10 c3')).toEqual(['0x1000'])
    expect(await ops().scanAob('89 41 10 c3', '0x1001')).toEqual([])
    expect(await ops().scanAob('89 41 10 c3', '0x1000', '0x1004')).toEqual(['0x1000'])
    expect(await ops().scanAob('89 41 10 c3', '0x1000', '0x1003')).toEqual([]) // does not fit
  })

  it('does not scan margins', async () => {
    expect(await ops().scanAob('cc cc 89')).toEqual([]) // spans pre margin into body
  })

  it('getModuleBase is case-insensitive and null when absent', () => {
    expect(ops().getModuleBase('game.EXE')).toBe('0x1000')
    expect(ops().getModuleBase('other.dll')).toBeNull()
  })

  it('decodeRun delegates to the snapshot decoder', () => {
    const r = ops().decodeRun('0x1000', 3)
    expect(r.decodable).toBe(true)
    expect(r.length).toBe(3)
  })

  it('refuses everything that would write or run code', () => {
    expect(() => ops().writeBytes()).toThrow(/not replayable/)
    expect(() => ops().allocateCave()).toThrow(/not replayable/)
  })
})

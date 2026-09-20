import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness } from '../helpers/spawnHarness'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'
import { decodeSnapshot, snapshotSha256, type Snapshot } from '../../src/main/replay/snapshotFile'
import { ReplayOps, type ReplayAddon } from '../../src/main/replay/replayOps'

// The recorder is plain JS (it runs as a script next to the other analysis
// scripts), so it is loaded through require rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recorder = require('../../mcp-server/scripts/recordSnapshot.js')
const a = addon as any
const native = addon as unknown as ReplayAddon

describe('recorder file format', () => {
  it('the JS writer and the TS reader agree, margins included', () => {
    const s: Snapshot = {
      version: 1,
      game: 'g',
      build: 'b',
      modules: [{ name: 'x.exe', base: '0x1000', size: 16, timestamp: 3 }],
      regions: [
        { base: '0x1000', bytes: Buffer.from([1, 2, 3]), pre: Buffer.from([9]), post: Buffer.from([4, 5]) },
        { base: '0x8000', bytes: Buffer.from([7]) }
      ],
      sites: [{ id: 's', address: '0x1001', length: 2 }]
    }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'a.snap')
    const sha = recorder.writeSnapshotFile(s, file)
    const bytes = fs.readFileSync(file)
    expect(decodeSnapshot(bytes)).toEqual(s)
    expect(snapshotSha256(bytes)).toBe(sha)
  })

  it('refuses to write game code anywhere inside the repo except fixtures/snapshots', () => {
    expect(() => recorder.assertSafeOutput(path.resolve('tests/fixtures/x.snap'))).toThrow(/refusing/)
    expect(() => recorder.assertSafeOutput(path.resolve('x.snap'))).toThrow(/refusing/)
    expect(() => recorder.assertSafeOutput(path.resolve('fixtures/snapshots/x.snap'))).not.toThrow()
    expect(() => recorder.assertSafeOutput(path.join(os.tmpdir(), 'x.snap'))).not.toThrow()
  })
})

describe('recorder against a live process', () => {
  let harness: ChildProcessWithoutNullStreams

  beforeAll(async () => {
    harness = spawnHarness()
    await new Promise((r) => harness.stdout.once('data', r))
  })
  afterAll(() => {
    harness.stdin.write('q\n')
    harness.kill()
  })

  it('records the harness; replaying it reads and scans like the live process', async () => {
    const { snapshot, skipped } = recorder.record(a, harness.pid, 'harness', 'h1', [])
    expect(skipped).toBe(0)
    expect(snapshot.regions.length).toBeGreaterThan(0)
    expect(snapshot.modules.some((m: any) => /harness/i.test(m.name))).toBe(true)

    // Round-trip through the file, as the real tier will.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'h.snap')
    recorder.writeSnapshotFile(snapshot, file)
    const ops = new ReplayOps(decodeSnapshot(fs.readFileSync(file)), native)

    const { handle } = a.attach(harness.pid)
    const region = snapshot.regions[0]
    const at = '0x' + (BigInt(region.base) + 0x10n).toString(16)
    expect(ops.readBytes(at, 32)).toBe(a.readBytes(handle, at, 32))

    // A signature cut from the recorded bytes is found in the same places the
    // live scan finds it.
    const sig = Array.from((region.bytes as Buffer).subarray(0x10, 0x10 + 24))
      .map((b: number) => b.toString(16).padStart(2, '0'))
      .join(' ')
    const live: string[] = await a.scanAob(handle, sig)
    expect(await ops.scanAob(sig)).toEqual([...live].sort())
    expect(live.length).toBeGreaterThan(0)
    a.detach(handle)
  }, 30000)
})

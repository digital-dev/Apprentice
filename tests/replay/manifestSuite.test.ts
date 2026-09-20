import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'
import { snapshotSha256 } from '../../src/main/replay/snapshotFile'
import { ReplayOps, type ReplayAddon } from '../../src/main/replay/replayOps'
import { buildSynthSnapshot, RELOC_STORE_LEN } from '../main/fixtures/synthImage'
import { registerManifestSuite, type Manifest, type ManifestSite } from './manifestSuite'

// Drives the real tier's per-site checks with generated snapshots, so that
// code is exercised on every run even while no game snapshot is checked in:
// three builds of one "game" - the same code at two bases, and a build whose
// code changed (an update).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recorder = require('../../mcp-server/scripts/recordSnapshot.js')
const a = addon as any
const native = addon as unknown as ReplayAddon
const hex = (n: bigint) => '0x' + n.toString(16)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'))

function site(build: string, opts: Parameters<typeof buildSynthSnapshot>[0]): ManifestSite {
  const { snapshot, sites } = buildSynthSnapshot(opts)
  snapshot.build = build
  const address = hex(sites.reloc)
  snapshot.sites = [{ id: 'reloc', address, length: RELOC_STORE_LEN }]
  const file = `synthetic-${build}.snap`
  recorder.writeSnapshotFile(snapshot, path.join(dir, file))
  const sig = a.snapshotBuildSignature(snapshot.regions, address, RELOC_STORE_LEN)
  return {
    game: 'synthetic',
    build,
    snapshot: file,
    snapshotSha256: snapshotSha256(fs.readFileSync(path.join(dir, file))),
    id: 'reloc',
    address,
    length: RELOC_STORE_LEN,
    originalBytes: new ReplayOps(snapshot, native).readBytes(address, RELOC_STORE_LEN)!,
    signature: sig.signature,
    signatureOffset: sig.signatureOffset,
    signatureSource: 'builder',
    matchCount: 1,
    relocatable: a.snapshotDecodeRun(snapshot.regions, address, RELOC_STORE_LEN).relocatable
  }
}

const manifest: Manifest = {
  version: 1,
  sites: [
    site('A', { base: 0x10000000n, imm64: 0x000247ca4f8a1000n }),
    site('B', { base: 0x7ff600000000n, imm64: 0x000001c74de92310n }),
    site('C-updated', { base: 0x20000000n, relocStoreDisp: 0x1c })
  ]
}

describe('the manifest suite runs against generated snapshots', () => {
  it('has the three builds', () => {
    expect(manifest.sites.map((s) => s.build)).toEqual(['A', 'B', 'C-updated'])
  })
  it('the updated build changed the signature (else the refusal path is not exercised)', () => {
    expect(manifest.sites[2].signature).not.toBe(manifest.sites[0].signature)
    expect(manifest.sites[0].signature).toBe(manifest.sites[1].signature)
  })
})

registerManifestSuite(manifest, dir)

describe('the suite skips, rather than fails, a site with no local snapshot', () => {
  registerManifestSuite(
    { version: 1, sites: [{ ...manifest.sites[0], snapshot: 'not-on-this-machine.snap' }] },
    dir
  )
})

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'
import { decodeSnapshot, snapshotSha256, type Snapshot } from '../../src/main/replay/snapshotFile'
import { ReplayOps, type ReplayAddon } from '../../src/main/replay/replayOps'

const a = addon as any
const native = addon as unknown as ReplayAddon

export interface ManifestSite {
  game: string
  build: string
  snapshot: string
  snapshotSha256: string
  id: string
  address: string
  length: number
  originalBytes: string
  signature: string
  signatureOffset: number
  // Expected scan matches for `signature` in this build. Always 1: a site that
  // is ambiguous in its own build is a bug in the recorded signature.
  matchCount: number
  relocatable: boolean
}
export interface Manifest { version: 1; sites: ManifestSite[] }

const hex = (n: bigint) => '0x' + n.toString(16)

// Registers the per-site checks for every manifest entry whose snapshot exists
// in `snapDir`; entries without a local snapshot are skipped, not failed.
export function registerManifestSuite(manifest: Manifest, snapDir: string): void {
  const loaded = new Map<string, { snap: Snapshot; ops: ReplayOps } | null>()
  const have = (file: string) => fs.existsSync(path.join(snapDir, file))
  const load = (file: string): { snap: Snapshot; ops: ReplayOps } | null => {
    if (!loaded.has(file)) {
      if (!have(file)) {
        loaded.set(file, null)
      } else {
        const snap = decodeSnapshot(fs.readFileSync(path.join(snapDir, file)))
        loaded.set(file, { snap, ops: new ReplayOps(snap, native) })
      }
    }
    return loaded.get(file) ?? null
  }

  describe.each(manifest.sites)('$game/$build site $id', (site) => {
    const it_ = it.skipIf(!have(site.snapshot))

    it_('the snapshot is the one the manifest was written against', () => {
      expect(snapshotSha256(fs.readFileSync(path.join(snapDir, site.snapshot)))).toBe(site.snapshotSha256)
    })

    it_('the signature finds exactly the recorded instruction', async () => {
      const { ops } = load(site.snapshot)!
      const hits = await ops.scanAob(site.signature)
      expect(hits).toEqual([hex(BigInt(site.address) - BigInt(site.signatureOffset))])
      expect(ops.readBytes(site.address, site.length)).toBe(site.originalBytes)
    })

    it_('rebuilding the signature from the recorded bytes reproduces the manifest', () => {
      const { snap } = load(site.snapshot)!
      const sig = a.snapshotBuildSignature(snap.regions, site.address, site.length)
      expect(sig).toEqual({ signature: site.signature, signatureOffset: site.signatureOffset })
    })

    it_('relocatability is unchanged', () => {
      const { snap } = load(site.snapshot)!
      expect(a.snapshotDecodeRun(snap.regions, site.address, site.length).relocatable).toBe(site.relocatable)
    })
  })

  // Across two builds of one game: an old signature must either find the new
  // instruction exactly, or refuse (0 or 2+ matches). Never a wrong single match.
  const byGameAndId = new Map<string, ManifestSite[]>()
  for (const s of manifest.sites) {
    const k = `${s.game}/${s.id}`
    byGameAndId.set(k, [...(byGameAndId.get(k) ?? []), s])
  }
  describe.each([...byGameAndId.entries()].filter(([, v]) => v.length > 1))('across builds: %s', (_k, sites) => {
    for (const from of sites) {
      for (const to of sites) {
        if (from === to || from.build === to.build) continue
        it.skipIf(!have(from.snapshot) || !have(to.snapshot))(
          `build ${from.build} signature in build ${to.build}: relocates exactly or refuses`,
          async () => {
            const hits = await load(to.snapshot)!.ops.scanAob(from.signature)
            if (hits.length === 1) {
              expect(hits[0]).toBe(hex(BigInt(to.address) - BigInt(from.signatureOffset)))
            } else {
              expect(hits.length === 0 || hits.length > 1).toBe(true)
            }
          }
        )
      }
    }
  })
}

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { registerManifestSuite, type Manifest } from './manifestSuite'

// Real tier: regression checks against snapshots recorded from actual games
// (mcp-server/scripts/recordSnapshot.js). Snapshots hold game code, so they
// live in fixtures/snapshots/ (gitignored) and any site whose snapshot is not
// on this machine is skipped. Only the manifest is committed.

const manifest: Manifest = JSON.parse(
  fs.readFileSync(path.resolve('tests/fixtures/manifest.json'), 'utf8')
)

describe('manifest', () => {
  it('parses and every entry is well-formed', () => {
    expect(manifest.version).toBe(1)
    for (const s of manifest.sites) {
      expect(s.snapshot).toMatch(/.snap$/)
      expect(s.snapshotSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(s.address).toMatch(/^0x[0-9a-f]+$/)
      expect(s.originalBytes.length).toBe(s.length * 2)
      expect(s.matchCount).toBeGreaterThanOrEqual(1)
      expect(['builder', 'shipped']).toContain(s.signatureSource)
    }
  })
})

registerManifestSuite(manifest, path.resolve('fixtures/snapshots'))

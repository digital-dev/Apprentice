import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Structural checks over every shipped profile and draft in games/. The loader
// is deliberately lenient (a hand-edit must not lose cheats), so this is what
// catches a malformed patch before it reaches a user: a replacement of the
// wrong length, a scale patch with no register, an anchor that points at a
// capture patch that is not there.

const GAMES = path.resolve('games')
const files = fs.readdirSync(GAMES).filter((f) => f.endsWith('.json'))

const HEX = /^([0-9a-f]{2})+$/
const SIG_TOKEN = /^([0-9a-f]{2}|\?\?)$/
const XMM = /^xmm([0-9]|1[0-5])$/i

interface AnyCheat {
  kind?: string
  id: string
  mode?: string
  originalBytes?: string
  length?: number
  replacementBytes?: string
  signature?: string
  signatureOffset?: number
  moduleName?: string | null
  moduleOffset?: string | null
  monoClass?: string
  monoMethod?: string
  monoSearch?: boolean
  sourceRegister?: string
  value?: number
  dataType?: string
  targets?: { kind: string; patchId?: string }[]
  anchors?: { name: string; patchId: string }[]
  enableScript?: string
  disableScript?: string
}

describe.each(files)('games/%s', (file) => {
  const profile = JSON.parse(fs.readFileSync(path.join(GAMES, file), 'utf8')) as { cheats: AnyCheat[] }
  const cheats = profile.cheats
  const patches = cheats.filter((c) => c.kind === 'patch')

  it('has unique cheat ids', () => {
    const ids = cheats.map((c) => c.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })

  it('every anchor target names a patch in the same file', () => {
    const patchIds = new Set(patches.map((p) => p.id))
    for (const c of cheats) {
      for (const t of c.targets ?? []) {
        if (t.kind === 'anchor') expect(patchIds.has(t.patchId!), `${c.id} -> ${t.patchId}`).toBe(true)
      }
    }
  })

  it('every script anchor names a capture patch in the same file, and scripts are non-empty', () => {
    const captures = new Set(patches.filter((p) => p.mode === 'capture').map((p) => p.id))
    for (const c of cheats.filter((x) => x.kind === 'script')) {
      expect(c.enableScript?.trim().length, `${c.id} enableScript`).toBeGreaterThan(0)
      for (const a of c.anchors ?? []) expect(captures.has(a.patchId), `${c.id} -> ${a.patchId}`).toBe(true)
    }
  })

  it.each(patches.map((p) => [p.id, p] as const))('patch %s is well-formed for its mode', (_id, p) => {
    expect(p.originalBytes, 'originalBytes').toMatch(HEX)
    expect(p.originalBytes!.length / 2).toBe(p.length)
    // A class+method-anchored patch resolves by live Mono metadata (anchor.ts's
    // own "Path 0"), not a byte signature — scanAob(patch.signature) is only
    // ever reached when monoSearch is explicitly true (anchor.ts, and see
    // patchEngine.ts's isMonoAnchored comment on why it's untrustworthy
    // cross-session anyway). Requiring a well-formed signature on a plain
    // mono-anchored patch was checking a field the engine never reads.
    const isMonoAnchored = p.monoClass !== undefined && p.monoMethod !== undefined
    const needsSignature = !isMonoAnchored || p.monoSearch === true
    if (needsSignature) {
      const tokens = (p.signature ?? '').split(' ')
      expect(tokens.length).toBeGreaterThan(0)
      for (const t of tokens) expect(t).toMatch(SIG_TOKEN)
      // The signature has to be able to hold the instruction it locates.
      expect(tokens.length).toBeGreaterThanOrEqual((p.signatureOffset ?? 0) + p.length!)
    }
    if (p.moduleName) expect(p.moduleOffset).toMatch(/^0x[0-9a-f]+$/)

    if (p.mode === 'replace') {
      expect(p.replacementBytes, 'replacementBytes').toMatch(HEX)
      expect(p.replacementBytes!.length / 2).toBe(p.length)
    }
    if (p.mode === 'scale') {
      expect(p.sourceRegister).toMatch(XMM)
      expect(typeof p.value).toBe('number')
      expect(Number.isFinite(p.value)).toBe(true)
      expect(p.dataType).toBe('float')
    }
  })
})

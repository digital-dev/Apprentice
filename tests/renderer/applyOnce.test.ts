import { describe, it, expect } from 'vitest'
import { applyOnce, APPLY_ATTEMPTS, type ApplyOnceDeps } from '../../src/renderer/src/applyOnce'
import type { CheatDefinition, PatchCheat } from '../../src/main/store'

function patch(id: string): PatchCheat {
  return { kind: 'patch', mode: 'capture', id } as PatchCheat
}

function cheat(targets: CheatDefinition['targets']): CheatDefinition {
  return { id: 'edit', name: 'Edit', dataType: 'float', mode: 'oneshot', targets, value: 5 }
}

const anchorTo = (patchId: string): CheatDefinition['targets'][number] => ({ kind: 'anchor', patchId, offset: '0x10' })
const chainTarget: CheatDefinition['targets'][number] = { moduleName: 'g.dll', baseOffset: '0x1', offsets: [] }

// A recording fake: every call is logged in order so tests can assert the sequence.
function fakes(opts: {
  patches?: PatchCheat[]
  enabled?: string[]
  oneShotResults?: boolean[]
  applyFails?: string
}): { deps: ApplyOnceDeps; log: string[] } {
  const log: string[] = []
  const enabled = new Set(opts.enabled ?? [])
  let shots = 0
  const deps: ApplyOnceDeps = {
    patches: opts.patches ?? [],
    isPatchEnabled: (id) => enabled.has(id),
    applyPatch: async (p) => {
      log.push(`apply:${p.id}`)
      return opts.applyFails === undefined ? { ok: true, error: null } : { ok: false, error: opts.applyFails }
    },
    restorePatch: async (p) => {
      log.push(`restore:${p.id}`)
      return true
    },
    oneShot: async () => {
      log.push('oneShot')
      const results = opts.oneShotResults ?? [true]
      return results[Math.min(shots++, results.length - 1)]
    },
    markPatch: (id, on) => log.push(`mark:${id}:${on ? 'on' : 'off'}`),
    sleep: async () => {
      log.push('sleep')
    }
  }
  return { deps, log }
}

describe('applyOnce', () => {
  it('writes once and touches no patch for a cheat with no anchor targets', async () => {
    const { deps, log } = fakes({})
    expect(await applyOnce(cheat([chainTarget]), deps)).toEqual({ ok: true })
    expect(log).toEqual(['oneShot'])
  })

  it('installs the capture patch, retries until the game runs the hook, then restores it', async () => {
    const { deps, log } = fakes({ patches: [patch('cap')], oneShotResults: [false, false, true] })
    expect(await applyOnce(cheat([anchorTo('cap')]), deps)).toEqual({ ok: true })
    expect(log).toEqual([
      'apply:cap',
      'mark:cap:on',
      'oneShot',
      'sleep',
      'oneShot',
      'sleep',
      'oneShot',
      'restore:cap',
      'mark:cap:off'
    ])
  })

  it('leaves a patch alone when it was already installed (a freeze cheat shares it)', async () => {
    const { deps, log } = fakes({ patches: [patch('cap')], enabled: ['cap'] })
    expect(await applyOnce(cheat([anchorTo('cap')]), deps)).toEqual({ ok: true })
    expect(log).toEqual(['oneShot'])
  })

  it('installs each distinct patch once for a multi-target cheat', async () => {
    const { deps, log } = fakes({ patches: [patch('cap')] })
    await applyOnce(cheat([anchorTo('cap'), anchorTo('cap'), anchorTo('cap')]), deps)
    expect(log.filter((l) => l === 'apply:cap')).toHaveLength(1)
    expect(log.filter((l) => l === 'restore:cap')).toHaveLength(1)
  })

  it('reports a missing capture patch without writing anything', async () => {
    const { deps, log } = fakes({ patches: [] })
    const r = await applyOnce(cheat([anchorTo('cap')]), deps)
    expect(r).toEqual({ ok: false, error: expect.stringContaining('cap') })
    expect(log).toEqual([])
  })

  it('reports an install failure and restores nothing it did not install', async () => {
    const { deps, log } = fakes({ patches: [patch('cap')], applyFails: 'signature not found' })
    const r = await applyOnce(cheat([anchorTo('cap')]), deps)
    expect(r).toEqual({ ok: false, error: 'signature not found' })
    expect(log).toEqual(['apply:cap'])
  })

  it('gives up after the attempt budget, says why, and still cleans up', async () => {
    const { deps, log } = fakes({ patches: [patch('cap')], oneShotResults: [false] })
    const r = await applyOnce(cheat([anchorTo('cap')]), deps)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/hook|game/i)
    expect(log.filter((l) => l === 'oneShot')).toHaveLength(APPLY_ATTEMPTS)
    expect(log.slice(-2)).toEqual(['restore:cap', 'mark:cap:off'])
  })

  it('does not retry a cheat with no anchors: a failed write is just a failed write', async () => {
    const { deps, log } = fakes({ oneShotResults: [false] })
    const r = await applyOnce(cheat([chainTarget]), deps)
    expect(r.ok).toBe(false)
    expect(log).toEqual(['oneShot'])
  })
})

import { describe, it, expect } from 'vitest'
import { buildFactory, type VerifyFn } from '../src/factory/build'
import type { Enumeration } from '../src/factory/monoEnumerator'
import type { TargetStatus } from '../src/cheatVerify'

const enumeration: Enumeration = {
  fields: [
    { className: 'Player', fieldName: 'm_localPlayer' },
    { className: 'Player', fieldName: 'm_stamina' },
    { className: 'Player', fieldName: 'm_godMode' },
    { className: 'Player', fieldName: 'm_hp' },
    { className: 'Character', fieldName: 'm_health' }
  ],
  roots: [{ className: 'Player', staticFieldName: 'm_localPlayer' }],
  deadRoots: [],
  classesScanned: 2
}

const dead: TargetStatus = { supported: true, alive: false, value: null, expected: null, matches: null }
const live = (value: number): TargetStatus => ({ supported: true, alive: true, value, expected: null, matches: null })

// Table of (instanceFieldName, dataType) -> live value; anything else is dead.
function verifyFrom(table: Record<string, number>): VerifyFn {
  return async (target, dataType) => {
    const key = `${target.instanceFieldName}:${dataType}`
    return key in table ? live(table[key]) : dead
  }
}

describe('buildFactory', () => {
  it('drafts each resolvable category and sets instanceClassName only for base-class fields', async () => {
    const verify = verifyFrom({ 'm_health:float': 25, 'm_stamina:float': 100, 'm_godMode:int8': 0 })
    const r = await buildFactory(['health', 'stamina', 'godmode'], enumeration, verify)
    expect(r.drafts.map((d) => d.id)).toEqual(['factory-health', 'factory-stamina', 'factory-godmode'])
    expect(r.drafts[0].targets[0]).toEqual({
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_health',
      instanceClassName: 'Character'
    })
    expect(r.drafts[1].targets[0]).toEqual({
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_stamina'
    })
    expect(r.drafts[0]).toMatchObject({ dataType: 'float', mode: 'freeze', value: 1000, name: 'Infinite Health' })
    expect(r.checklist).toHaveLength(3)
    expect(r.checklist[0]).toMatchObject({ id: 'factory-health', liveValue: 25 })
  })

  it('falls back to the next data type when the first read is dead', async () => {
    const verify = verifyFrom({ 'm_health:int32': 25 })
    const r = await buildFactory(['health'], enumeration, verify)
    expect(r.drafts[0].dataType).toBe('int32')
  })

  it('rejects an implausible live value and lists the category as unresolved', async () => {
    const verify = verifyFrom({ 'm_health:float': 1e12, 'm_hp:float': 1e12 })
    const r = await buildFactory(['health'], enumeration, verify)
    expect(r.drafts).toEqual([])
    expect(r.unresolved).toEqual(['health'])
  })

  it('tries the next ranked field and reports the other as an alternate', async () => {
    // m_hp ranks first (input order) but is dead; m_health resolves.
    const verify = verifyFrom({ 'm_health:float': 25 })
    const r = await buildFactory(['health'], enumeration, verify)
    expect(r.drafts[0].targets[0]).toMatchObject({ instanceFieldName: 'm_health' })
    expect(r.checklist[0].alternates).toEqual(['Player.m_hp'])
  })

  it('reports landmine categories as manual with no draft', async () => {
    const r = await buildFactory(['hunger', 'speed'], enumeration, verifyFrom({}))
    expect(r.drafts).toEqual([])
    expect(r.manual.map((m) => m.category)).toEqual(['hunger', 'speed'])
    expect(r.manual[0].note).toMatch(/decay/i)
  })

  it('reports no-match and unknown categories as notFound', async () => {
    const r = await buildFactory(['money', 'bogus'], enumeration, verifyFrom({}))
    expect(r.notFound).toEqual(['money', 'bogus'])
  })

  it('marks every ranked category unresolved when there is no live root', async () => {
    const r = await buildFactory(['health'], { ...enumeration, roots: [] }, verifyFrom({ 'm_health:float': 25 }))
    expect(r.unresolved).toEqual(['health'])
    expect(r.drafts).toEqual([])
  })
})

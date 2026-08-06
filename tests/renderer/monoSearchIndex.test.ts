import { describe, it, expect } from 'vitest'
import { filterSearchIndex, SearchIndexEntry } from '../../src/renderer/src/monoSearchIndex'

const fixture: SearchIndexEntry[] = [
  { namespaceName: '', className: 'Player', classHandle: '0x1', kind: 'field', name: 'm_ghostMode' },
  { namespaceName: '', className: 'Player', classHandle: '0x1', kind: 'field', name: 'm_maxCarryWeight' },
  { namespaceName: '', className: 'Character', classHandle: '0x2', kind: 'method', name: 'ApplyDamage' },
  { namespaceName: '', className: 'Skills', classHandle: '0x3', kind: 'method', name: 'Raise' }
]

describe('filterSearchIndex', () => {
  it('matches a substring case-insensitively across every class', () => {
    const result = filterSearchIndex(fixture, 'ghost')
    expect(result).toEqual([fixture[0]])
  })

  it('matches multiple entries across different classes', () => {
    const result = filterSearchIndex(fixture, 'a')
    expect(result.map((e) => e.name)).toEqual([
      'm_maxCarryWeight',
      'ApplyDamage',
      'Raise'
    ])
  })

  it('returns an empty array for an empty query rather than the whole index', () => {
    expect(filterSearchIndex(fixture, '')).toEqual([])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterSearchIndex(fixture, 'zzz')).toEqual([])
  })
})

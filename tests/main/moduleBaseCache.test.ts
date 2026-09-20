import { describe, it, expect } from 'vitest'
import { ModuleBaseCache } from '../../src/main/moduleBaseCache'

function setup(bases: Record<string, string | null>) {
  let clock = 0
  let calls = 0
  const cache = new ModuleBaseCache(
    (_handle, name) => {
      calls++
      return bases[name.toLowerCase()] ?? null
    },
    2000,
    () => clock
  )
  return { cache, calls: () => calls, advance: (ms: number) => (clock += ms), bases }
}

describe('ModuleBaseCache', () => {
  it('looks a module up once for many targets in the same tick', () => {
    const s = setup({ 'game.exe': '0x140000000' })
    for (let i = 0; i < 100; i++) expect(s.cache.get(1, 'game.exe')).toBe('0x140000000')
    expect(s.calls()).toBe(1)
  })
  it('treats the module name case-insensitively', () => {
    const s = setup({ 'game.exe': '0x140000000' })
    s.cache.get(1, 'Game.exe')
    s.cache.get(1, 'GAME.EXE')
    expect(s.calls()).toBe(1)
  })
  it('looks again after the ttl so a reloaded module is picked up', () => {
    const s = setup({ 'game.dll': '0x1000' })
    expect(s.cache.get(1, 'game.dll')).toBe('0x1000')
    s.bases['game.dll'] = '0x9000'
    s.advance(1999)
    expect(s.cache.get(1, 'game.dll')).toBe('0x1000')
    s.advance(2)
    expect(s.cache.get(1, 'game.dll')).toBe('0x9000')
  })
  it('never caches a miss', () => {
    const s = setup({})
    expect(s.cache.get(1, 'late.dll')).toBeNull()
    s.bases['late.dll'] = '0x5000'
    expect(s.cache.get(1, 'late.dll')).toBe('0x5000')
  })
  it('keeps handles apart and forgets a closed one', () => {
    const s = setup({ 'game.exe': '0x140000000' })
    s.cache.get(1, 'game.exe')
    s.cache.get(2, 'game.exe')
    expect(s.calls()).toBe(2)
    s.cache.forget(1)
    s.cache.get(1, 'game.exe')
    s.cache.get(2, 'game.exe')
    expect(s.calls()).toBe(3)
  })
})

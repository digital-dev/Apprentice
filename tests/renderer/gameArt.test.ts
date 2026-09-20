import { describe, it, expect } from 'vitest'
import { placeholder } from '../../src/renderer/src/gameArt'

describe('placeholder', () => {
  it('is stable for a game, and differs between games', () => {
    expect(placeholder('3164500', 'Schedule I')).toEqual(placeholder('3164500', 'Schedule I'))
    expect(placeholder('3164500', 'Schedule I').background).not.toBe(placeholder('892970', 'Valheim').background)
  })

  it('uses the first letters of the first two words', () => {
    expect(placeholder('1', 'Schedule I').initials).toBe('SI')
    expect(placeholder('1', 'Red Dead Redemption 2').initials).toBe('RD')
    expect(placeholder('1', "Assassin's Creed Shadows").initials).toBe('AS')
  })

  it('takes two letters from a single-word name', () => {
    expect(placeholder('1', 'Valheim').initials).toBe('VA')
  })

  it('ignores trademark symbols and other punctuation', () => {
    expect(placeholder('1', 'HELLDIVERS™ 2').initials).toBe('H2')
  })

  it('never returns an empty label', () => {
    expect(placeholder('1', '™™').initials).toBe('?')
    expect(placeholder('1', '').initials).toBe('?')
  })
})

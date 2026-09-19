import { describe, it, expect } from 'vitest'
import { categoryById } from '../src/factory/categories'
import { rankFields, scoreField, type FieldCandidate } from '../src/factory/ranker'

// Field names taken from games/valheim.json's hand-authored cheats.
const valheim: FieldCandidate[] = [
  { className: 'Player', fieldName: 'm_localPlayer' },
  { className: 'Player', fieldName: 'm_godMode' },
  { className: 'Player', fieldName: 'm_stamina' },
  { className: 'Player', fieldName: 'm_staminaRegenTimer' },
  { className: 'Player', fieldName: 'm_eitr' },
  { className: 'Character', fieldName: 'm_health' },
  { className: 'Character', fieldName: 'm_maxHealth' },
  { className: 'Character', fieldName: 'm_healthRegen' },
  { className: 'Character', fieldName: 'm_runSpeed' }
]

function names(id: string): string[] {
  const cat = categoryById(id)!
  return rankFields(cat, valheim).map((s) => `${s.className}.${s.fieldName}`)
}

describe('rankFields', () => {
  it('finds the current-health field and rejects max/regen variants', () => {
    expect(names('health')).toEqual(['Character.m_health'])
  })
  it('finds stamina and rejects the regen timer', () => {
    expect(names('stamina')).toEqual(['Player.m_stamina'])
  })
  it('finds the god-mode flag', () => {
    expect(names('godmode')).toEqual(['Player.m_godMode'])
  })
  it('finds eitr as mana', () => {
    expect(names('mana')).toEqual(['Player.m_eitr'])
  })
  it('returns nothing when no field matches (money in Valheim fields)', () => {
    expect(names('money')).toEqual([])
  })
  it('keeps input order for equal scores and honours topN', () => {
    const cat = categoryById('health')!
    const fields: FieldCandidate[] = [
      { className: 'Character', fieldName: 'm_hp' },
      { className: 'Character', fieldName: 'm_health' },
      { className: 'Character', fieldName: 'm_currentHealth' }
    ]
    expect(rankFields(cat, fields, 2).map((s) => s.fieldName)).toEqual(['m_hp', 'm_health'])
  })
})

describe('a category whose target IS a multiplier', () => {
  const fields: FieldCandidate[] = [
    { className: 'TimeManager', fieldName: '<TimeSpeedMultiplier>k__BackingField' },
    { className: 'TimeManager', fieldName: '<CurrentTime>k__BackingField' },
    { className: 'PlayerMovement', fieldName: '<CurrentSprintMultiplier>k__BackingField' },
    { className: 'PlayerMovement', fieldName: 'StaminaRestoreRate' }
  ]
  it('ranks the time-speed multiplier for freezetime', () => {
    const cat = categoryById('freezetime')!
    expect(rankFields(cat, fields).map((f) => f.fieldName)).toEqual(['<TimeSpeedMultiplier>k__BackingField'])
  })
  it('ranks the sprint multiplier for runspeed', () => {
    const cat = categoryById('runspeed')!
    expect(rankFields(cat, fields).map((f) => f.fieldName)).toEqual(['<CurrentSprintMultiplier>k__BackingField'])
  })
  it('still rejects max/regen variants of the matched word', () => {
    const cat = categoryById('health')!
    const variants: FieldCandidate[] = [
      { className: 'Character', fieldName: 'MaxHealthMultiplier' },
      { className: 'Character', fieldName: 'healthRegenRate' }
    ]
    expect(rankFields(cat, variants)).toEqual([])
  })
})

describe('scoreField', () => {
  it('gives a class-hint bonus', () => {
    const cat = categoryById('health')!
    const inHint = scoreField(cat, { className: 'Character', fieldName: 'm_health' })
    const outOfHint = scoreField(cat, { className: 'Zzz', fieldName: 'm_health' })
    expect(inHint).toBeGreaterThan(outOfHint)
  })
})

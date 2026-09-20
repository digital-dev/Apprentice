import { describe, it, expect } from 'vitest'
import { restoreKind } from '../../src/main/restorePolicy'
import type { CheatDefinition } from '../../src/main/store'

const base = { id: 'c', name: 'C', dataType: 'float', targets: [], value: 1 } as unknown as CheatDefinition

describe('restoreKind', () => {
  it('restores the captured original by default', () => {
    expect(restoreKind({ ...base, mode: 'freeze' })).toBe('capture')
  })
  it('uses a fixed offValue when the cheat names one', () => {
    expect(restoreKind({ ...base, mode: 'freeze', offValue: 0 })).toBe('value')
  })
  it('lets captureOriginal win over offValue, as documented', () => {
    expect(restoreKind({ ...base, mode: 'freeze', offValue: 0, captureOriginal: true })).toBe('capture')
  })
  it('leaves the value alone only when the cheat opts out', () => {
    expect(restoreKind({ ...base, mode: 'freeze', keepOnDisable: true })).toBe('none')
  })
  it('does nothing for a one-shot cheat, which is not held', () => {
    expect(restoreKind({ ...base, mode: 'oneshot' })).toBe('none')
  })
})

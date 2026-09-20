import { describe, it, expect } from 'vitest'
import { changedCapturePointers, cheatsAnchoredTo } from '../../src/renderer/src/anchorStatus'
import type { CheatDefinition } from '../../src/main/store'

const cheat = (id: string, targets: CheatDefinition['targets']): CheatDefinition =>
  ({ id, name: id, dataType: 'float', mode: 'freeze', targets, value: 1 }) as CheatDefinition
const anchor = (patchId: string): CheatDefinition['targets'][number] => ({ kind: 'anchor', patchId, offset: '0x10' })
const chain: CheatDefinition['targets'][number] = { moduleName: 'g.dll', baseOffset: '0x1', offsets: [] }

describe('changedCapturePointers', () => {
  it('reports a patch whose pointer appears for the first time', () => {
    expect(changedCapturePointers(new Map(), new Map([['p', { pointer: '0x10' }]]))).toEqual(['p'])
  })

  it('reports a patch whose pointer changed (the game moved to another object)', () => {
    expect(changedCapturePointers(new Map([['p', '0x10']]), new Map([['p', { pointer: '0x20' }]]))).toEqual(['p'])
  })

  it('does not report an unchanged pointer, so a settled cheat is not re-verified every poll', () => {
    expect(changedCapturePointers(new Map([['p', '0x10']]), new Map([['p', { pointer: '0x10' }]]))).toEqual([])
  })

  it('does not report a patch that has not captured anything yet', () => {
    expect(changedCapturePointers(new Map(), new Map([['p', { pointer: null }]]))).toEqual([])
  })
})

describe('cheatsAnchoredTo', () => {
  const health = cheat('health', [anchor('cap-health')])
  const both = cheat('both', [chain, anchor('cap-a'), anchor('cap-b')])
  const plain = cheat('plain', [chain])

  it('finds cheats with an anchor target on the patch', () => {
    expect(cheatsAnchoredTo([health, both, plain], ['cap-health']).map((c) => c.id)).toEqual(['health'])
    expect(cheatsAnchoredTo([health, both, plain], ['cap-b']).map((c) => c.id)).toEqual(['both'])
  })

  it('ignores cheats with no anchor targets and returns nothing for no patches', () => {
    expect(cheatsAnchoredTo([plain], ['cap-health'])).toEqual([])
    expect(cheatsAnchoredTo([health], [])).toEqual([])
  })
})

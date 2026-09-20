import { describe, it, expect } from 'vitest'
import { CompanionTracker } from '../../src/main/companions'
import type { PatchCheat } from '../../src/main/store'

const patch = (id: string): PatchCheat => ({ kind: 'patch', id, name: id, internal: true }) as unknown as PatchCheat

function setup(known: string[] = ['a', 'b']) {
  const log: string[] = []
  const tracker = new CompanionTracker({
    findPatch: (id) => (known.includes(id) ? patch(id) : undefined),
    arm: (p) => log.push(`arm ${p.id}`),
    disarm: (p) => log.push(`disarm ${p.id}`)
  })
  return { tracker, log }
}

describe('CompanionTracker', () => {
  it('arms companions with the cheat and disarms them when it turns off', () => {
    const { tracker, log } = setup()
    tracker.enable('cheat1', ['a', 'b'])
    tracker.disable('cheat1')
    expect(log).toEqual(['arm a', 'arm b', 'disarm a', 'disarm b'])
  })
  it('keeps a shared companion armed until the last cheat using it turns off', () => {
    const { tracker, log } = setup()
    tracker.enable('c1', ['a'])
    tracker.enable('c2', ['a'])
    tracker.disable('c1')
    expect(log).toEqual(['arm a'])
    tracker.disable('c2')
    expect(log).toEqual(['arm a', 'disarm a'])
  })
  it('ignores a cheat without companions and an unknown patch id', () => {
    const { tracker, log } = setup(['a'])
    tracker.enable('plain', undefined)
    tracker.enable('empty', [])
    tracker.enable('x', ['missing', 'a'])
    tracker.disable('x')
    tracker.disable('never-enabled')
    expect(log).toEqual(['arm a', 'disarm a'])
  })
  it('is idempotent when a cheat is enabled twice', () => {
    const { tracker, log } = setup()
    tracker.enable('c1', ['a'])
    tracker.enable('c1', ['a'])
    tracker.disable('c1')
    expect(log).toEqual(['arm a', 'disarm a'])
  })
  it('never lets a companion failure escape', () => {
    const tracker = new CompanionTracker({
      findPatch: (id) => patch(id),
      arm: () => {
        throw new Error('not attached')
      },
      disarm: () => {
        throw new Error('already restored')
      }
    })
    expect(() => tracker.enable('c1', ['a'])).not.toThrow()
    expect(() => tracker.disable('c1')).not.toThrow()
  })
  it('forgets everything on reset so a new process starts clean', () => {
    const { tracker, log } = setup()
    tracker.enable('c1', ['a'])
    tracker.reset()
    tracker.enable('c1', ['a'])
    expect(log).toEqual(['arm a', 'arm a'])
  })
})

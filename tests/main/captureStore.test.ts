import { describe, it, expect } from 'vitest'
import { CaptureStore } from '../../src/main/captureStore'

// CaptureStore is the runtime record of "what was this cheat's target
// actually reading right before we started freezing it" — see
// CheatDefinition.captureOriginal's doc in store.ts. ipc.ts populates it the
// instant a captureOriginal cheat is enabled, and consumes it the instant
// that cheat is disabled (any path: toggle off, delete, quit, process
// switch), so the restore writes back what the game itself had there, not a
// guessed static number.
describe('CaptureStore', () => {
  it('returns the values captured for a cheat', () => {
    const store = new CaptureStore()
    store.capture('low-plane-mass', [1234.5])

    expect(store.take('low-plane-mass')).toEqual([1234.5])
  })

  it('take() removes the entry so a later disable of the same id finds nothing stale', () => {
    const store = new CaptureStore()
    store.capture('low-plane-mass', [1234.5])
    store.take('low-plane-mass')

    expect(store.take('low-plane-mass')).toBeUndefined()
  })

  it('returns undefined for a cheat that was never captured', () => {
    const store = new CaptureStore()

    expect(store.take('never-enabled')).toBeUndefined()
  })

  it('a later capture overwrites an earlier one for the same id', () => {
    const store = new CaptureStore()
    store.capture('low-plane-mass', [1234.5])
    store.capture('low-plane-mass', [999])

    expect(store.take('low-plane-mass')).toEqual([999])
  })

  it('clear() drops a pending capture without returning it', () => {
    const store = new CaptureStore()
    store.capture('low-plane-mass', [1234.5])
    store.clear('low-plane-mass')

    expect(store.take('low-plane-mass')).toBeUndefined()
  })
})

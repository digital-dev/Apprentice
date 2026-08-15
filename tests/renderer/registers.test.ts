import { describe, it, expect } from 'vitest'
import { pickThread } from '../../src/renderer/src/registers'

describe('pickThread', () => {
  it('keeps the current selection when it is still in the list', () => {
    expect(pickThread(200, [{ tid: 100 }, { tid: 200 }, { tid: 300 }])).toBe(200)
  })

  it('falls back to the first thread when nothing is selected yet', () => {
    expect(pickThread(null, [{ tid: 100 }, { tid: 200 }])).toBe(100)
  })

  it('falls back to the first thread when the current selection exited', () => {
    expect(pickThread(999, [{ tid: 100 }, { tid: 200 }])).toBe(100)
  })

  it('returns null when the thread list is empty', () => {
    expect(pickThread(200, [])).toBeNull()
    expect(pickThread(null, [])).toBeNull()
  })
})

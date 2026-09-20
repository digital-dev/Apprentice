import { describe, it, expect } from 'vitest'
import { spawnHarness, ignoreClosedPipe } from '../helpers/spawnHarness'

describe('spawnHarness', () => {
  it('listens for errors on the child stdin, so a closed pipe cannot become an uncaught exception', () => {
    const harness = spawnHarness()
    try {
      expect(harness.stdin.listenerCount('error')).toBeGreaterThan(0)
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      // With no listener this emit would throw; with the helper it is swallowed.
      expect(() => harness.stdin.emit('error', epipe)).not.toThrow()
    } finally {
      harness.kill()
    }
  })
})

describe('ignoreClosedPipe', () => {
  it('ignores the codes a shutting-down child produces', () => {
    for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
      expect(() => ignoreClosedPipe(Object.assign(new Error(code), { code }))).not.toThrow()
    }
  })
  it('still surfaces anything else', () => {
    expect(() => ignoreClosedPipe(Object.assign(new Error('disk on fire'), { code: 'EIO' }))).toThrow('disk on fire')
    expect(() => ignoreClosedPipe(new Error('no code'))).toThrow('no code')
  })
})

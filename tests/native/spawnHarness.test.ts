import { describe, it, expect } from 'vitest'
import { spawnHarness, ignoreClosedPipe, assertSafeWinePrefix } from '../helpers/spawnHarness'

// Pure string check, so it runs everywhere (no Wine needed).
describe('assertSafeWinePrefix', () => {
  const home = '/home/dev'
  it('refuses the real prefix, the home directory and the root', () => {
    for (const p of ['/home/dev/.wine', '/home/dev/.wine/', '/home/dev/./.wine', '/home/dev', '/home/dev/', '/', '//']) {
      expect(() => assertSafeWinePrefix(p, home), p).toThrow(/refusing/)
    }
    // A home given with a trailing slash is the same home.
    expect(() => assertSafeWinePrefix('/home/dev/.wine', '/home/dev/')).toThrow(/refusing/)
  })
  it('refuses a relative prefix', () => {
    expect(() => assertSafeWinePrefix('.wine-apprentice-test', home)).toThrow(/absolute/)
  })
  it('accepts a throwaway prefix and returns it normalised', () => {
    expect(assertSafeWinePrefix('/home/dev/.wine-apprentice-test', home)).toBe('/home/dev/.wine-apprentice-test')
    expect(assertSafeWinePrefix('/tmp/wine-ci/', home)).toBe('/tmp/wine-ci')
    expect(assertSafeWinePrefix('/home/dev/.wine2', home)).toBe('/home/dev/.wine2')
  })
})

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

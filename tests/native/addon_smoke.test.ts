import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'

describe('native addon smoke test', () => {
  it('loads and responds to ping', () => {
    expect((addon as any).ping()).toBe('pong')
  })
})

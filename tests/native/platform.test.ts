import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'

describe('platform seam', () => {
  it('reports which backend was compiled in', () => {
    const platform = (addon as any).platformName()
    expect(['windows', 'linux']).toContain(platform.name)
  })

  it('reports Windows as supported', () => {
    // The suite runs on Windows. A Linux build compiles and loads, but every
    // operation refuses — the point of the stub is that it fails honestly
    // rather than appearing to work.
    const platform = (addon as any).platformName()
    if (process.platform === 'win32') {
      expect(platform.name).toBe('windows')
      expect(platform.supported).toBe(true)
    } else {
      expect(platform.supported).toBe(false)
    }
  })
})

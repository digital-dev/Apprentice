import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'

describe('zydis integration', () => {
  it('decodes a known instruction (mov eax, [rip+disp] = 8b 05 00 00 00 00)', () => {
    // 0x8B /r = mov r32, r/m32; ModRM 05 = [rip+disp32]; 4-byte disp.
    const result = (addon as any).decodeAt('8b0500000000')
    expect(result.length).toBe(6)
    expect(result.mnemonic.toLowerCase()).toContain('mov')
  })

  it('reports decode-failed on garbage rather than throwing', () => {
    const result = (addon as any).decodeAt('')
    expect(result.length).toBe(0)
  })
})

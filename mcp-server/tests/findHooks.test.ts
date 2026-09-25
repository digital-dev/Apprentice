import { describe, it, expect } from 'vitest'
import { findInjectedHooks, type HookScanOps } from '../src/factory/findHooks'

const MODULE_BASE = '0x7ff800000000'
const MODULE_SIZE = 0x1000000 // 16 MiB

function opsWith(disasm: HookScanOps['disasm'], hex = 'aabbccdd'): HookScanOps {
  return {
    readBytes: (address, length) => (address === '0x7ff800001000' ? hex.repeat(length) : null),
    disasm
  }
}

describe('findInjectedHooks', () => {
  it('flags a jmp whose target lands outside the module range', () => {
    const ops = opsWith(() => [
      { address: '0x7ff800001000', text: 'push rbx', length: 1 },
      { address: '0x7ff800001001', text: 'jmp 0x7ff900001000', length: 5 } // way outside
    ])
    const result = findInjectedHooks(ops, '0x7ff800001000', 16, MODULE_BASE, MODULE_SIZE)
    expect(result).toEqual([{ address: '0x7ff800001001', text: 'jmp 0x7ff900001000', target: '0x7ff900001000' }])
  })

  it('flags a call whose target lands outside the module range', () => {
    const ops = opsWith(() => [{ address: '0x7ff800001000', text: 'call 0x7ff600000000', length: 5 }])
    const result = findInjectedHooks(ops, '0x7ff800001000', 16, MODULE_BASE, MODULE_SIZE)
    expect(result).toEqual([{ address: '0x7ff800001000', text: 'call 0x7ff600000000', target: '0x7ff600000000' }])
  })

  it('does not flag a jmp/call that stays within the module', () => {
    const ops = opsWith(() => [
      { address: '0x7ff800001000', text: 'jmp 0x7ff800002000', length: 5 }, // inside
      { address: '0x7ff800001005', text: 'mov eax, ebx', length: 2 } // not a jmp/call at all
    ])
    const result = findInjectedHooks(ops, '0x7ff800001000', 16, MODULE_BASE, MODULE_SIZE)
    expect(result).toEqual([])
  })

  it('treats the module end as exclusive', () => {
    const exactEnd = '0x' + (BigInt(MODULE_BASE) + BigInt(MODULE_SIZE)).toString(16)
    const ops = opsWith(() => [{ address: '0x7ff800001000', text: `jmp ${exactEnd}`, length: 5 }])
    const result = findInjectedHooks(ops, '0x7ff800001000', 16, MODULE_BASE, MODULE_SIZE)
    expect(result).toEqual([{ address: '0x7ff800001000', text: `jmp ${exactEnd}`, target: exactEnd }])
  })

  it('errors clearly when the target bytes are unreadable', () => {
    const ops = opsWith(() => [])
    const result = findInjectedHooks(ops, '0xdeadbeef', 16, MODULE_BASE, MODULE_SIZE)
    expect(result).toEqual({ error: expect.stringMatching(/could not read/) })
  })
})

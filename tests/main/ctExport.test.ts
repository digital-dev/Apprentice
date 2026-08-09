import { describe, it, expect } from 'vitest'
import { buildCheatTable } from '../../src/main/ctExport'
import { importCheatTable } from '../../src/main/ctImport'
import type { PatchCheat } from '../../src/main/store'

function forcePatch(overrides: Partial<PatchCheat> = {}): PatchCheat {
  return {
    kind: 'patch',
    mode: 'force',
    id: 'test-patch',
    name: 'Infinite Stamina',
    originalBytes: 'f30f11af18080000',
    length: 8,
    signature: 'f3 0f 11 af 18 08 00 00 48 8b 7d',
    signatureOffset: 0,
    moduleName: null,
    moduleOffset: null,
    baseRegister: 'rdi',
    fieldOffset: '0x818',
    value: 350,
    dataType: 'float',
    ...overrides
  }
}

describe('buildCheatTable', () => {
  it('round-trips a force-mode float patch through importCheatTable', () => {
    const patch = forcePatch()
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual(['Infinite Stamina'])
    expect(result.skipped).toEqual([])

    const reimported = importCheatTable(result.xml)
    expect(reimported.skipped).toEqual([])
    expect(reimported.imported).toHaveLength(1)
    const back = reimported.imported[0]
    expect(back.name).toBe(patch.name)
    expect(back.signature).toBe(patch.signature)
    expect(back.originalBytes).toBe(patch.originalBytes)
    expect(back.length).toBe(patch.length)
    expect(back.baseRegister).toBe(patch.baseRegister)
    expect(back.fieldOffset).toBe(patch.fieldOffset)
    expect(back.value).toBe(patch.value)
    expect(back.dataType).toBe(patch.dataType)
  })

  it('round-trips a force-mode int32 patch, including a nonzero signature offset', () => {
    const patch = forcePatch({
      id: 'test-patch-2',
      name: 'Infinite Health',
      originalBytes: 'c7461808000000',
      length: 7,
      signature: 'e8 ?? ?? ?? ?? c7 46 18 08 00 00 00',
      signatureOffset: 5,
      baseRegister: 'rsi',
      fieldOffset: '0x18',
      value: 999,
      dataType: 'int32'
    })
    const result = buildCheatTable([patch])
    const reimported = importCheatTable(result.xml)
    expect(reimported.skipped).toEqual([])
    const back = reimported.imported[0]
    expect(back.signature).toBe(patch.signature)
    expect(back.signatureOffset).toBe(5)
    expect(back.originalBytes).toBe(patch.originalBytes)
    expect(back.fieldOffset).toBe(patch.fieldOffset)
    expect(back.value).toBe(999)
    expect(back.dataType).toBe('int32')
  })

  it('skips a non-force-mode patch with a reason, and does not export it', () => {
    const patch = forcePatch({ mode: 'nop', name: 'A NOP patch' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'A NOP patch',
        reason: "Only 'force'-mode patches can be exported to Cheat Engine's Auto Assembler format."
      }
    ])
  })

  it('skips a force-mode patch missing required fields', () => {
    const patch = forcePatch({ signature: undefined as unknown as string })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Infinite Stamina',
        reason: 'Force-mode patch is missing data needed to reconstruct its Auto Assembler script.'
      }
    ])
  })

  it('skips a force-mode patch with a negative value', () => {
    const patch = forcePatch({ value: -5, dataType: 'int32', name: 'Negative Health' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Negative Health',
        reason: "This value cannot be represented in Cheat Engine's Auto Assembler script format."
      }
    ])
  })

  it('skips a force-mode float patch whose value formats as exponential notation', () => {
    const patch = forcePatch({ value: 1e21, dataType: 'float', name: 'Huge Value' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Huge Value',
        reason: "This value cannot be represented in Cheat Engine's Auto Assembler script format."
      }
    ])
  })
})

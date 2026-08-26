import { describe, it, expect } from 'vitest'
import { buildCheatTable } from '../../src/main/ctExport'
import { importCheatTable } from '../../src/main/ctImport'
import type { CheatDefinition, PatchCheat } from '../../src/main/store'

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

  it('exports a nop-mode patch as nop lines, and round-trips it back as nop-shape', () => {
    const patch = forcePatch({ mode: 'nop', name: 'A NOP patch', length: 5, originalBytes: 'f30f11af18' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual(['A NOP patch'])
    expect(result.skipped).toEqual([])
    expect(result.xml).toContain('  nop\n  nop\n  nop\n  nop\n  nop')

    const reimported = importCheatTable(result.xml)
    expect(reimported.skipped).toEqual([])
    const back = reimported.imported[0]
    expect(back.mode).toBe('nop')
    expect(back.originalBytes).toBe('f30f11af18')
    expect(back.length).toBe(5)
  })

  it('exports a replace-mode patch as a raw db line, but does not round-trip (no recognized import shape)', () => {
    const patch = forcePatch({
      mode: 'replace',
      name: 'A replace patch',
      length: 4,
      originalBytes: '0f84aabbccdd',
      replacementBytes: '9090909090909090'.slice(0, 8)
    })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual(['A replace patch'])
    expect(result.skipped).toEqual([])
    expect(result.xml).toContain('db 90 90 90 90')

    const reimported = importCheatTable(result.xml)
    expect(reimported.imported).toEqual([])
    expect(reimported.skipped).toHaveLength(1)
  })

  it('skips a replace-mode patch whose replacementBytes is missing or the wrong length', () => {
    const patch = forcePatch({ mode: 'replace', name: 'Bad replace', length: 4, replacementBytes: '9090' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      { name: 'Bad replace', reason: "This 'replace'-mode patch's replacementBytes is missing or the wrong length." }
    ])
  })

  it.each(['guard', 'immune', 'scale', 'copy', 'capture'] as const)(
    "skips a '%s'-mode patch with a reason, and does not export it",
    (mode) => {
      const patch = forcePatch({ mode, name: `A ${mode} patch` })
      const result = buildCheatTable([patch])
      expect(result.exported).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].name).toBe(`A ${mode} patch`)
      expect(result.skipped[0].reason).toContain(`'${mode}'-mode`)
    }
  )

  it('skips a Mono-anchored patch with no captured signature (nothing for CE to scan for)', () => {
    const patch = forcePatch({ signature: '', monoClass: 'Player', monoMethod: 'TakeDamage' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Infinite Stamina',
        reason:
          "This patch has no byte signature to scan for (Mono-anchored patches without a captured signature can't be relocated by Cheat Engine, which has no Mono resolver of its own)."
      }
    ])
  })

  it('skips a force-mode patch missing required fields', () => {
    const patch = forcePatch({ baseRegister: undefined as unknown as string })
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

  it('skips a force-mode patch whose dataType is not int32/float', () => {
    const patch = forcePatch({ dataType: 'int8', name: 'Wide Type' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Wide Type',
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

  // fieldOffset can now arrive as write_watch.cc's signed decimal (see
  // write_watch.cc's displacement fix) as well as ctImport's own legacy
  // "0x..."-prefixed hex convention. Both existing round-trip tests above
  // use '0x818'/'0x18', which BigInt parses identically to the OLD
  // .replace(/^0x/i, '') string-stripping — so neither exercises the branch
  // this fix actually changes. These two cases do.
  it('renders a bare-decimal fieldOffset as its hex equivalent, not as literal hex digits', () => {
    // 16 decimal -> 0x10 hex. The old code stripped a (non-existent) "0x"
    // prefix from '16' and emitted '+16' verbatim, which Cheat Engine reads
    // as hex 0x16 (22 decimal) -- silently the wrong offset. +10 (0x10) is
    // the only correct rendering of decimal 16.
    const patch = forcePatch({ fieldOffset: '16' })
    const result = buildCheatTable([patch])
    expect(result.skipped).toEqual([])
    expect(result.xml).toContain('mov [rdi+10],')
    expect(result.xml).not.toContain('mov [rdi+16],')
  })

  it('renders a negative fieldOffset with an explicit minus sign, not a folded +- sign', () => {
    const patch = forcePatch({ fieldOffset: '-4' })
    const result = buildCheatTable([patch])
    expect(result.skipped).toEqual([])
    expect(result.xml).toContain('mov [rdi-4],')
    expect(result.xml).not.toContain('+-4')
  })
})

function chainCheat(overrides: Partial<CheatDefinition> = {}): CheatDefinition {
  return {
    id: 'test-value-cheat',
    name: 'Infinite Health',
    dataType: 'float',
    mode: 'freeze',
    targets: [{ moduleName: 'game.exe', baseOffset: '0x3d65f88', offsets: ['0x10ef8', '0x0', '0x190'] }],
    value: 9999,
    ...overrides
  }
}

describe('buildCheatTable — value cheats', () => {
  it('exports a plain chain-target cheat as an ordinary CE address entry', () => {
    const cheat = chainCheat()
    const result = buildCheatTable([], [cheat])
    expect(result.exported).toEqual(['Infinite Health'])
    expect(result.skipped).toEqual([])
    expect(result.xml).toContain('<VariableType>Float</VariableType>')
    expect(result.xml).toContain('<Address>"game.exe"+3d65f88</Address>')
    expect(result.xml).toContain('<Offset>10ef8</Offset>')
    expect(result.xml).toContain('<Offset>0</Offset>')
    expect(result.xml).toContain('<Offset>190</Offset>')
  })

  it('maps every DataType to its Cheat Engine VariableType', () => {
    const cases: [CheatDefinition['dataType'], string][] = [
      ['int8', 'Byte'],
      ['int16', '2 Bytes'],
      ['int32', '4 Bytes'],
      ['int64', '8 Bytes'],
      ['float', 'Float'],
      ['double', 'Double']
    ]
    for (const [dataType, variableType] of cases) {
      const result = buildCheatTable([], [chainCheat({ dataType })])
      expect(result.xml).toContain(`<VariableType>${variableType}</VariableType>`)
    }
  })

  it('emits one CheatEntry per redundant chain target, labeled by index', () => {
    const cheat = chainCheat({
      targets: [
        { moduleName: 'game.exe', baseOffset: '0x100', offsets: [] },
        { moduleName: 'game.exe', baseOffset: '0x200', offsets: [] }
      ]
    })
    const result = buildCheatTable([], [cheat])
    expect(result.exported).toEqual(['Infinite Health'])
    expect(result.xml).toContain('"Infinite Health [1/2]"')
    expect(result.xml).toContain('"Infinite Health [2/2]"')
  })

  it("skips a Mono-resolved cheat — no fixed address for Cheat Engine", () => {
    const cheat = chainCheat({
      targets: [{ kind: 'mono', className: 'Player', staticFieldName: 'm_localPlayer' }]
    })
    const result = buildCheatTable([], [cheat])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Infinite Health',
        reason:
          "This cheat's target is resolved live (via Mono metadata or a capture patch's tracked pointer), not a fixed address — Cheat Engine has no equivalent resolver of its own."
      }
    ])
  })

  it('skips an anchor-resolved cheat the same way', () => {
    const cheat = chainCheat({
      targets: [{ kind: 'anchor', patchId: 'some-capture-patch', offset: '0x18' }]
    })
    const result = buildCheatTable([], [cheat])
    expect(result.exported).toEqual([])
    expect(result.skipped[0].name).toBe('Infinite Health')
  })

  it('skips a bitIndex target — freezing the whole byte would clobber unrelated flags', () => {
    const cheat = chainCheat({
      dataType: 'int8',
      targets: [{ moduleName: 'game.exe', baseOffset: '0x19b', offsets: [], bitIndex: 0 }]
    })
    const result = buildCheatTable([], [cheat])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Infinite Health',
        reason:
          "This cheat writes a single bit inside a byte that packs other, unrelated flags — freezing the whole byte in Cheat Engine would clobber bits this app deliberately leaves alone."
      }
    ])
  })

  it('exports the plain targets of a mixed bitIndex/plain cheat, skipping only the bit one', () => {
    const cheat = chainCheat({
      targets: [
        { moduleName: 'game.exe', baseOffset: '0x100', offsets: [] },
        { moduleName: 'game.exe', baseOffset: '0x19b', offsets: [], bitIndex: 0 }
      ]
    })
    const result = buildCheatTable([], [cheat])
    expect(result.exported).toEqual(['Infinite Health'])
    expect(result.skipped).toEqual([])
    // Only one entry — the bit target silently contributes nothing, not a
    // separate skip, since the cheat as a whole still counts as exported.
    expect(result.xml.match(/<CheatEntry>/g)).toHaveLength(1)
  })

  it('respects a per-target dataType/value override over the cheat-level one', () => {
    const cheat = chainCheat({
      dataType: 'float',
      value: 9999,
      targets: [{ moduleName: 'game.exe', baseOffset: '0x100', offsets: [], dataType: 'int32', value: 1 }]
    })
    const result = buildCheatTable([], [cheat])
    expect(result.xml).toContain('<VariableType>4 Bytes</VariableType>')
    expect(result.xml).not.toContain('<VariableType>Float</VariableType>')
  })

  it('combines patches and value cheats into one table', () => {
    const patch = forcePatch()
    const cheat = chainCheat({ name: 'Infinite Runes' })
    const result = buildCheatTable([patch], [cheat])
    expect(result.exported).toEqual(['Infinite Runes', 'Infinite Stamina'])
    expect(result.xml).toContain('"Infinite Runes"')
    expect(result.xml).toContain('"Infinite Stamina"')
  })
})

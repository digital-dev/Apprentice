import { describe, it, expect } from 'vitest'
import { importCheatTable } from '../../src/main/ctImport'

// Fixtures below are trimmed excerpts of a real, user-supplied Valheim .CT
// file's actual structure and byte patterns — not hand-invented shapes.

function wrapTable(entriesXml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45">
  <CheatEntries>
${entriesXml}
  </CheatEntries>
</CheatTable>`
}

const staminaEntry = `
    <CheatEntry>
      <ID>74</ID>
      <Description>"&lt;= Infinite Stamina v2"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(aobStamina,F3 0F 11 AF 18 08 00 00 48 8B 7D)
alloc(newmem,$1000,aobStamina)

label(code)
label(return)

newmem:

code:
  movss [rdi+00000818],xmm5
  mov [rdi+00000818],(float)350
  jmp return

aobStamina:
  jmp newmem
  nop 3
return:
registersymbol(aobStamina)

[DISABLE]

aobStamina:
  db F3 0F 11 AF 18 08 00 00

unregistersymbol(aobStamina)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

// The "INJECT+09" shape: the actual instruction being replaced sits 9
// bytes into the aobscan pattern, not at its start.
const durabilityEntry = `
    <CheatEntry>
      <ID>75</ID>
      <Description>"&lt;= infinite Weapons Durability v2"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(INJECT,CA F2 0F 5C C1 F2 0F 5A E8 F3 0F 11 6E 3C)
alloc(newmem,$1000,INJECT)

label(code)
label(return)

newmem:

code:
  movss [rsi+3C],xmm5
  mov [rsi+3C],(float)4000
  jmp return

INJECT+09:
  jmp newmem
return:
registersymbol(INJECT)

[DISABLE]

INJECT+09:
  db F3 0F 11 6E 3C

unregistersymbol(INJECT)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

// Bare hex integer value, no (float) cast, plus a swallowed trailing
// instruction (test eax,eax) replayed in the code block — the extra line
// should not confuse the parser, and does not need to be reproduced (see
// ctImport.ts's module comment).
const buyingItemsEntry = `
    <CheatEntry>
      <ID>56</ID>
      <Description>"&lt;= infinite coins &amp; items when buying"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(buyingItems,48 63 46 38 85 C0 40)
alloc(newmem,$1000,buyingItems)

label(code)
label(return)

newmem:

code:
  movsxd  rax,dword ptr [rsi+38]
  mov dword ptr [rsi+38],270F
  test eax,eax
  jmp return

buyingItems:
  jmp newmem
  nop
return:
registersymbol(buyingItems)

[DISABLE]

buyingItems:
  db 48 63 46 38 85 C0

unregistersymbol(buyingItems)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

const readmeHeaderEntry = `
    <CheatEntry>
      <ID>67</ID>
      <Description>"//ReadMe.&gt; tick the box to activate"</Description>
      <Color>FF8000</Color>
      <GroupHeader>1</GroupHeader>
    </CheatEntry>`

// A genuinely more complex injection this importer is not meant to
// handle: multiple distinct effects, no single "mov [reg+off], constant"
// line to anchor on.
const unsupportedEntry = `
    <CheatEntry>
      <ID>99</ID>
      <Description>"Complex multi-write injection"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(complexThing,48 8B 46 10 48 8B 50 10)
alloc(newmem,$1000,complexThing)

label(code)
label(return)

newmem:

code:
  mov rax,[rsi+10]
  mov rdx,[rax+10]
  call rdx
  jmp return

complexThing:
  jmp newmem
return:
registersymbol(complexThing)

[DISABLE]

complexThing:
  db 48 8B 46 10 48 8B 50 10

unregistersymbol(complexThing)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

describe('importCheatTable', () => {
  it('converts a plain aobscan + constant-write script into a force-mode patch', () => {
    const result = importCheatTable(wrapTable(staminaEntry))
    expect(result.skipped).toEqual([])
    expect(result.imported).toHaveLength(1)
    const patch = result.imported[0]
    expect(patch.mode).toBe('force')
    expect(patch.name).toBe('<= Infinite Stamina v2')
    expect(patch.signature).toBe('f3 0f 11 af 18 08 00 00 48 8b 7d')
    expect(patch.signatureOffset).toBe(0)
    expect(patch.originalBytes).toBe('f30f11af18080000')
    expect(patch.length).toBe(8)
    expect(patch.baseRegister).toBe('rdi')
    expect(patch.fieldOffset).toBe('0x818')
    expect(patch.value).toBe(350)
    expect(patch.dataType).toBe('float')
    expect(patch.moduleName).toBeNull()
  })

  it('recovers a non-zero signatureOffset from an INJECT+HEX: label', () => {
    const result = importCheatTable(wrapTable(durabilityEntry))
    expect(result.imported).toHaveLength(1)
    const patch = result.imported[0]
    expect(patch.signatureOffset).toBe(9)
    expect(patch.originalBytes).toBe('f30f116e3c')
    expect(patch.length).toBe(5)
    expect(patch.baseRegister).toBe('rsi')
    expect(patch.fieldOffset).toBe('0x3c')
    expect(patch.value).toBe(4000)
    expect(patch.dataType).toBe('float')
  })

  it('treats a bare numeric literal as hex, distinct from a (float)-cast decimal value', () => {
    const result = importCheatTable(wrapTable(buyingItemsEntry))
    expect(result.imported).toHaveLength(1)
    const patch = result.imported[0]
    expect(patch.value).toBe(0x270f)
    expect(patch.dataType).toBe('int32')
    expect(patch.baseRegister).toBe('rsi')
    expect(patch.fieldOffset).toBe('0x38')
  })

  it('skips a GroupHeader/folder entry silently (not an error, not importable)', () => {
    const result = importCheatTable(wrapTable(readmeHeaderEntry))
    expect(result.imported).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('reports an unsupported multi-effect script with a reason, rather than guessing', () => {
    const result = importCheatTable(wrapTable(unsupportedEntry))
    expect(result.imported).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].description).toBe('Complex multi-write injection')
    expect(result.skipped[0].reason).toContain('mov [register+offset], constant')
  })

  it('finds entries nested inside a folder GroupHeader, not just top-level ones', () => {
    const nested = `
    <CheatEntry>
      <ID>1</ID>
      <Description>"Folder"</Description>
      <GroupHeader>1</GroupHeader>
      <CheatEntries>
${staminaEntry}
      </CheatEntries>
    </CheatEntry>`
    const result = importCheatTable(wrapTable(nested))
    expect(result.imported).toHaveLength(1)
    expect(result.imported[0].name).toBe('<= Infinite Stamina v2')
  })

  it('imports every recognizable entry in a table with a mix of importable and unsupported ones', () => {
    const result = importCheatTable(
      wrapTable([staminaEntry, durabilityEntry, buyingItemsEntry, readmeHeaderEntry, unsupportedEntry].join('\n'))
    )
    expect(result.imported).toHaveLength(3)
    expect(result.skipped).toHaveLength(1)
    expect(result.imported.map((p) => p.name)).toEqual([
      '<= Infinite Stamina v2',
      '<= infinite Weapons Durability v2',
      '<= infinite coins & items when buying'
    ])
  })
})

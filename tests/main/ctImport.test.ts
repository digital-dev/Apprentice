import { describe, it, expect } from 'vitest'
import { importCheatTable, parsePlainValueEntry } from '../../src/main/ctImport'
import type { CheatDefinition, PatchCheat } from '../../src/main/store'

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

const bareAddressEntry = `
    <CheatEntry>
      <ID>10</ID>
      <Description>"Score"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>004A2B3C</Address>
    </CheatEntry>`

const pointerChainEntry = `
    <CheatEntry>
      <ID>11</ID>
      <Description>"Health"</Description>
      <VariableType>Float</VariableType>
      <Address>"game.exe"+001A2B3C</Address>
      <Offsets>
        <Offset>18</Offset>
        <Offset>20</Offset>
      </Offsets>
    </CheatEntry>`

// Real CT files serialize the current/frozen value as a Value="..."
// ATTRIBUTE on <LastState>, alongside other attributes whose presence/order
// isn't fixed — not as a fabricated <Value> element (which CE never emits).
const plainValueWithLiteral = `
    <CheatEntry>
      <ID>12</ID>
      <Description>"Always Max Ammo"</Description>
      <LastState Value="999" RealAddress="00334455" Activated="1"/>
      <VariableType>2 Bytes</VariableType>
      <Address>"game.exe"+00334455</Address>
    </CheatEntry>`

const nopShapeEntry = `
    <CheatEntry>
      <ID>76</ID>
      <Description>"No Fall Damage"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(aobFallDamage,F3 0F 11 AF 18 08 00 00 48 8B 7D)
alloc(newmem,$1000,aobFallDamage)

label(code)
label(return)

newmem:

code:
  jmp return

aobFallDamage:
  jmp newmem
  nop 3
return:
registersymbol(aobFallDamage)

[DISABLE]

aobFallDamage:
  db F3 0F 11 AF 18 08 00 00

unregistersymbol(aobFallDamage)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

const copyShapeEntry = `
    <CheatEntry>
      <ID>77</ID>
      <Description>"Sync Shield to Health"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(aobShield,F3 0F 11 AF 18 08 00 00 48 8B 7D)
alloc(newmem,$1000,aobShield)

label(code)
label(return)

newmem:

code:
  mov [rdi+00000818],eax
  jmp return

aobShield:
  jmp newmem
  nop 3
return:
registersymbol(aobShield)

[DISABLE]

aobShield:
  db F3 0F 11 AF 18 08 00 00

unregistersymbol(aobShield)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

// A "jmp <label>" whose target is a sym+hex label (not a bare cave-internal
// label like "return"/"code") is a jump INTO a specific byte offset of the
// original captured bytes — a real "skip N bytes of code" effect, distinct
// from nop's "disable everything" semantics — and must NOT be stripped as
// filler the way "jmp return" is.
const jumpOverBytesEntry = `
    <CheatEntry>
      <ID>78</ID>
      <Description>"Skip Damage Application"</Description>
      <VariableType>Auto Assembler Script</VariableType>
      <AssemblerScript>
[ENABLE]

aobscan(aobDamage,F3 0F 11 AF 18 08 00 00 48 8B 7D)
alloc(newmem,$1000,aobDamage)

label(code)
label(return)

newmem:

code:
  jmp aobDamage+20

aobDamage:
  jmp newmem
  nop 3
aobDamage+20:
return:
registersymbol(aobDamage)

[DISABLE]

aobDamage:
  db F3 0F 11 AF 18 08 00 00

unregistersymbol(aobDamage)
dealloc(newmem)
</AssemblerScript>
    </CheatEntry>`

describe('nop-shape and copy-shape Auto Assembler entries', () => {
  it('imports a provably-empty effect as a nop-mode patch', () => {
    const { imported, skipped } = importCheatTable(wrapTable(nopShapeEntry))
    expect(skipped).toEqual([])
    expect(imported).toHaveLength(1)
    const patch = imported[0] as PatchCheat
    expect(patch.mode).toBe('nop')
    expect(patch.originalBytes).toBe('f30f11af18080000')
    expect(patch.length).toBe(8)
    expect(patch.baseRegister).toBeUndefined()
    expect(patch.value).toBeUndefined()
  })

  it('imports a register-source mov as a copy-mode patch', () => {
    const { imported, skipped } = importCheatTable(wrapTable(copyShapeEntry))
    expect(skipped).toEqual([])
    expect(imported).toHaveLength(1)
    const patch = imported[0] as PatchCheat
    expect(patch.mode).toBe('copy')
    expect(patch.baseRegister).toBe('rdi')
    expect(patch.fieldOffset).toBe('0x818')
    expect(patch.sourceRegister).toBe('eax')
    expect(patch.value).toBeUndefined()
  })

  it('does not misparse a register-source mov as a truncated hex literal', () => {
    // Regression guard for the specific latent bug this task fixes: before
    // the value-group lookahead, "eax" partially matched [0-9A-Fa-f.]+ as
    // "ea", silently importing this as force-mode value 0xea.
    const { imported } = importCheatTable(wrapTable(copyShapeEntry))
    const patch = imported[0] as PatchCheat
    expect(patch.mode).not.toBe('force')
  })

  it('still imports the existing force-mode fixtures unchanged', () => {
    const { imported: staminaImported } = importCheatTable(wrapTable(staminaEntry))
    expect((staminaImported[0] as PatchCheat).mode).toBe('force')
    const { imported: durabilityImported } = importCheatTable(wrapTable(durabilityEntry))
    expect((durabilityImported[0] as PatchCheat).mode).toBe('force')
  })

  it('skips a script whose effect body has unrecognized content, not guessing at any shape', () => {
    const computed = copyShapeEntry.replace(
      'mov [rdi+00000818],eax',
      'imul eax, 2\n  mov [rdi+00000818],eax'
    )
    const { imported, skipped } = importCheatTable(wrapTable(computed))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
  })

  it('reads a bare hex-letter constant as a force-mode value, not a copy-shape register name', () => {
    // Regression guard: "deadbeef" matches the same [a-z][a-z0-9]* shape as
    // a register name, but per CE's Auto Assembler convention (bare literal
    // = hex, no 0x prefix) this is a force-mode constant, not a register.
    const computed = copyShapeEntry.replace('mov [rdi+00000818],eax', 'mov [rdi+00000818],deadbeef')
    const { imported, skipped } = importCheatTable(wrapTable(computed))
    expect(skipped).toEqual([])
    expect(imported).toHaveLength(1)
    const patch = imported[0] as PatchCheat
    expect(patch.mode).toBe('force')
    expect(patch.value).toBe(0xdeadbeef)
    expect(patch.dataType).toBe('int32')
  })

  it('does not classify a jump-into-the-middle-of-the-original-bytes script as nop', () => {
    // "jmp aobDamage+20" targets a specific byte offset of the original
    // captured bytes (a real "skip N bytes of code" effect), not a
    // cave-internal "jmp return" — stripping it as filler would misclassify
    // this as nop, which NOPs the wrong number of bytes with the wrong
    // semantics.
    const { imported, skipped } = importCheatTable(wrapTable(jumpOverBytesEntry))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].description).toBe('Skip Damage Application')
  })

  it('skips a copy-shape mov with an invalid destination register instead of importing it', () => {
    // "xmm0" is not a general-purpose register this codebase's native
    // encoder can target as a destination — importing it as copy-mode would
    // reach installInjection's encoder call and leak a cave when it throws.
    const computed = copyShapeEntry.replace('mov [rdi+00000818],eax', 'mov [xmm0+10],eax')
    const { imported, skipped } = importCheatTable(wrapTable(computed))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
  })
})

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

  it('gives two entries with the same description distinct ids instead of colliding', () => {
    // saveCheat upserts by id — a repeated slug would silently drop the
    // first import even though the caller is told both succeeded.
    const first = staminaEntry.replace('&lt;= Infinite Stamina v2', 'Health')
    const second = durabilityEntry.replace('&lt;= infinite Weapons Durability v2', 'Health')
    const result = importCheatTable(wrapTable([first, second].join('\n')))
    expect(result.skipped).toEqual([])
    expect(result.imported).toHaveLength(2)
    const ids = result.imported.map((p) => p.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain('ct-import-health')
    expect(ids).toContain('ct-import-health-2')
    expect(result.imported.map((p) => p.name)).toEqual(['Health', 'Health'])
  })

  it('skips a [DISABLE] db line with an odd number of hex digits instead of a fractional length', () => {
    const computed = nopShapeEntry.replace('db F3 0F 11 AF 18 08 00 00', 'db F3 0F 1')
    const { imported, skipped } = importCheatTable(wrapTable(computed))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toContain('odd number of hex digits')
  })
})

describe('plain value entries', () => {
  it('skips a bare-address entry instead of importing an unresolvable target', () => {
    // No resolver in this codebase (ipc.ts, chain_walk.h) treats an empty
    // moduleName as "absolute address, no module" — importing this would
    // silently produce a dead cheat that saves cleanly but never reads or
    // writes anything.
    const { imported, skipped } = importCheatTable(wrapTable(bareAddressEntry))
    expect(imported).toEqual([])
    expect(skipped).toEqual([
      { description: 'Score', reason: expect.stringContaining("can't be relocated across game runs") }
    ])
  })

  it('imports a module+offset pointer-chain entry with its offsets in document order', () => {
    const { imported, skipped } = importCheatTable(wrapTable(pointerChainEntry))
    expect(skipped).toEqual([])
    const cheat = imported[0] as CheatDefinition
    expect(cheat.dataType).toBe('float')
    expect(cheat.targets).toEqual([
      { moduleName: 'game.exe', baseOffset: '0x1a2b3c', offsets: ['0x18', '0x20'] }
    ])
  })

  it('reads a <LastState Value="..."> attribute as the imported value when present', () => {
    const { imported } = importCheatTable(wrapTable(plainValueWithLiteral))
    const cheat = imported[0] as CheatDefinition
    expect(cheat.dataType).toBe('int16')
    expect(cheat.value).toBe(999)
  })

  it('skips an entry with an unparsable address instead of guessing', () => {
    const bad = pointerChainEntry.replace('"game.exe"+001A2B3C', 'not-an-address')
    const { imported, skipped } = importCheatTable(wrapTable(bad))
    expect(imported).toHaveLength(0)
    expect(skipped).toEqual([{ description: 'Health', reason: expect.stringContaining('Could not parse address') }])
  })

  it('normalizes a module+offset address and offsets via BigInt, without precision loss', () => {
    // parseInt(x, 16) silently loses precision above 2^53 and can even
    // produce the literal string "Infinity" for a long enough hex run,
    // which would later throw inside BigInt() in ipc.ts with a confusing
    // error. This address/offset are well within safe-integer range, but
    // BigInt-based normalization must still produce the same result.
    const entry = `<Description>"Big"</Description><VariableType>4 Bytes</VariableType><Address>"game.exe"+00FFFFFFFF</Address><Offsets><Offset>00FFFFFFFF</Offset></Offsets>`
    const result = parsePlainValueEntry(entry, '4 Bytes')
    expect('error' in result).toBe(false)
    const parsed = result as Omit<CheatDefinition, 'id' | 'name'>
    expect(parsed.targets).toEqual([{ moduleName: 'game.exe', baseOffset: '0xffffffff', offsets: ['0xffffffff'] }])
  })

  it('parsePlainValueEntry maps every recognized VariableType to the right DataType', () => {
    const cases: [string, string][] = [
      ['Byte', 'int8'],
      ['2 Bytes', 'int16'],
      ['4 Bytes', 'int32'],
      ['Float', 'float'],
      ['Double', 'double']
    ]
    for (const [variableType, dataType] of cases) {
      const entry = `<Description>"x"</Description><VariableType>${variableType}</VariableType><Address>"game.exe"+1000</Address>`
      const result = parsePlainValueEntry(entry, variableType)
      expect('error' in result).toBe(false)
      expect((result as Omit<CheatDefinition, 'id' | 'name'>).dataType).toBe(dataType)
    }
  })

  it("parsePlainValueEntry's success return has no id/name fields — the caller supplies those", () => {
    const entry = `<Description>"x"</Description><VariableType>4 Bytes</VariableType><Address>"game.exe"+1000</Address>`
    const result = parsePlainValueEntry(entry, '4 Bytes')
    expect('error' in result).toBe(false)
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('name')
  })

  it('skips an entry with a malformed offset (non-hex text) instead of throwing', () => {
    // A malformed <Offset> should not crash the entire import, but gracefully
    // skip this one entry with a descriptive error message.
    const badOffset = pointerChainEntry.replace('<Offset>18</Offset>', '<Offset>not-hex</Offset>')
    const { imported, skipped } = importCheatTable(wrapTable(badOffset))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].description).toBe('Health')
    expect(skipped[0].reason).toContain('not-hex')
    expect(skipped[0].reason).toContain('hexadecimal')
  })

  it('skips an entry with an empty offset tag instead of throwing', () => {
    // An empty <Offset></Offset> tag (whitespace-only content) is also invalid.
    const emptyOffset = pointerChainEntry.replace('<Offset>20</Offset>', '<Offset>   </Offset>')
    const { imported, skipped } = importCheatTable(wrapTable(emptyOffset))
    expect(imported).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toContain('hexadecimal')
  })

  it('still imports a valid entry when another entry in the same table has a malformed offset', () => {
    // Proves that a malformed offset in one entry does not crash the entire
    // import and take down other valid entries.
    const validEntry = pointerChainEntry
    const invalidEntry = `
    <CheatEntry>
      <ID>99</ID>
      <Description>"Broken Offsets"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"game.exe"+001A2B3C</Address>
      <Offsets>
        <Offset>zzz</Offset>
        <Offset>20</Offset>
      </Offsets>
    </CheatEntry>`
    const { imported, skipped } = importCheatTable(wrapTable([validEntry, invalidEntry].join('\n')))
    expect(imported).toHaveLength(1)
    expect(imported[0].name).toBe('Health')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].description).toBe('Broken Offsets')
  })
})

describe('importCheatTable performance', () => {
  // Regression test for a measured DoS: the old collectAllCheatEntries
  // recursed into freshly-sliced substring copies of every ancestor block
  // at every nesting level, re-scanning already-scanned content each time
  // — roughly cubic in nesting depth. ~4000 levels of nesting took over a
  // minute (and froze the whole single-threaded Electron main process, no
  // timeout) under that implementation. This builds a deeply nested (but
  // otherwise tiny) table and asserts import stays fast — generous
  // (well under the old implementation's real-world blow-up) but tight
  // enough to fail against the old cubic behavior.
  it('imports a deeply-nested table (2000+ levels) quickly, not cubically', () => {
    const depth = 2000
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries>' +
      '<CheatEntry>'.repeat(depth) +
      '</CheatEntry>'.repeat(depth) +
      '</CheatEntries></CheatTable>'

    const started = Date.now()
    const result = importCheatTable(xml)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(2000)
    // Depth cap (64) means only entries at depth <= 64 are collected; none
    // of them have a VariableType, so all are silently skipped (folders),
    // not reported as errors — just proving the call returns promptly and
    // without throwing is the point of this test.
    expect(result.imported).toEqual([])
  })

  // Regression test for a SECOND, distinct DoS shape found in the rewrite
  // that fixed the cubic deep-nesting bug above: collectCheatEntryRanges
  // was unconditionally re-running BOTH xml.indexOf(open, i) and
  // xml.indexOf(close, i) from `i` on every loop iteration. Once there are
  // no more <CheatEntry> open tags left ahead of `i` (this input has none
  // at all — only stray, unmatched close tags), indexOf(open, i) scans to
  // the end of the string and returns -1, and that full-string scan
  // repeated on EVERY remaining iteration (once per remaining close tag),
  // making the function quadratic in the number of close tags. This is a
  // WIDE, non-nested shape (not deep nesting), so it does not hit
  // MAX_CHEAT_ENTRY_DEPTH and was not caught by the test above. At 8000
  // close tags the old quadratic behavior took well over a second; a
  // correctly linear scan finishes near-instantly.
  it('imports a table with many unmatched close tags (wide, not deep) quickly, not quadratically', () => {
    const closeTagCount = 8000
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries>' +
      '</CheatEntry>'.repeat(closeTagCount) +
      '</CheatEntries></CheatTable>'

    const started = Date.now()
    const result = importCheatTable(xml)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(500)
    // No open tags at all means the stack is always empty when a close tag
    // is found, so no ranges are ever recorded — same "just prove it
    // returns promptly without throwing" point as the deep-nesting test.
    expect(result.imported).toEqual([])
  })

  // Regression test for a THIRD instance of the same quadratic pattern,
  // this time in extractTagBlocks (used by ownContent() to strip a
  // folder's nested <CheatEntries> block out of its own content before
  // extractTag looks for VariableType/etc). extractTagBlocks's inner
  // depth-tracking loop was unconditionally re-running
  // xml.indexOf(open, j) on every iteration, just like the bug fixed
  // above in collectCheatEntryRanges. A single <CheatEntry> whose content
  // is many nested <CheatEntries> opens immediately followed by that many
  // closes forces the inner loop through a long run of close tags AFTER
  // all the opens have been consumed (nextOpen settles at -1): the old
  // code re-scanned the remaining string from scratch on every one of
  // those close tags, making it quadratic in nesting count; the fix never
  // re-searches nextOpen once the branch that would consume it stops
  // being taken.
  it('imports a CheatEntry with many nested <CheatEntries> blocks quickly, not quadratically', () => {
    const nestCount = 20_000
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries><CheatEntry><ID>1</ID>' +
      '<CheatEntries>'.repeat(nestCount) +
      '</CheatEntries>'.repeat(nestCount) +
      '</CheatEntry></CheatEntries></CheatTable>'

    const started = Date.now()
    const result = importCheatTable(xml)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(500)
    // No VariableType on the entry (it's all nested <CheatEntries> noise)
    // means it's silently treated as a folder and skipped — same "just
    // prove it returns promptly without throwing" point as the tests
    // above.
    expect(result.imported).toEqual([])
  })

  // Regression test for a FOURTH instance of complexity-DoS, this time in
  // ownContent(): for each nested <CheatEntries> block, it used to run a
  // full whole-string `.replace()` against the entry's content — O(N *
  // length) for N sibling <CheatEntries> blocks inside one <CheatEntry>.
  // This builds one CheatEntry containing many SIBLING (not nested)
  // <CheatEntries>...</CheatEntries> blocks — the adversarial shape that
  // made the old N-separate-.replace() approach slow (measured 8.9s at
  // 1.67MB, 102s at 6.68MB on realistic scaled-up input). The fix builds
  // the stripped result in one linear pass over the entry's content, so
  // this should stay fast regardless of how many sibling blocks there are.
  it('imports a CheatEntry with many sibling <CheatEntries> blocks quickly, not quadratically', () => {
    const siblingCount = 6000
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries><CheatEntry><ID>1</ID>' +
      '<CheatEntries>x</CheatEntries>'.repeat(siblingCount) +
      '</CheatEntry></CheatEntries></CheatTable>'

    const started = Date.now()
    const result = importCheatTable(xml)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(1000)
    // No VariableType on the entry (only sibling <CheatEntries> noise)
    // means it's treated as a folder and skipped — same "just prove it
    // returns promptly without throwing" point as the tests above.
    expect(result.imported).toEqual([])
  })

  // Regression test for a FIFTH instance of complexity-DoS, in extractTag()
  // (used generically for VariableType/Description/AssemblerScript/
  // Address/Offsets). It used to run a regex `<tag>([\s\S]*?)</tag>` —
  // when no closing tag exists anywhere, the lazy `[\s\S]*?` quantifier's
  // backtracking engine effectively retries and expands to end-of-string
  // for every `<tag>`-shaped opening it attempts, making it quadratic in
  // the number of unclosed opens (measured 91.7s at 2.14MB with many
  // repeated, never-closed <VariableType> opens). The fix does two bounded
  // indexOf scans instead, so this should stay fast regardless of how many
  // unclosed opens precede the (nonexistent) close.
  it('imports a table with many unclosed <VariableType> tags quickly, not quadratically', () => {
    const openCount = 20_000
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><CheatTable><CheatEntries><CheatEntry><ID>1</ID>' +
      '<VariableType>'.repeat(openCount) +
      '</CheatEntry></CheatEntries></CheatTable>'

    const started = Date.now()
    const result = importCheatTable(xml)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(1000)
    // No closing </VariableType> anywhere means extractTag returns null,
    // so the entry is treated as a folder and skipped.
    expect(result.imported).toEqual([])
  })

  // Regression test for a SIXTH instance of complexity-DoS, in
  // parsePlainValueEntry's <LastState> Value="..." extraction. It used to
  // run a single greedy regex
  // `/<LastState\b[^>]*\bValue="([^"]*)"[^>]*>/` against the whole entry
  // — a greedy `[^>]*` with no terminating `>` after it restarts and scans
  // to end-of-string for each of N unclosed `<LastState ` occurrences, the
  // WORST measured case (151s at 1.76MB). The fix bounds the search to one
  // tag's worth of text (indexOf '<LastState', then indexOf '>' from
  // there) before running any regex, so this should stay fast regardless
  // of how many unclosed `<LastState ` occurrences precede the real one.
  it('imports an entry with many unclosed <LastState> tags quickly, not quadratically', () => {
    // Worst case for the old greedy regex: N occurrences of "<LastState "
    // and NO '>' anywhere in the string at all. The old code would, for
    // each of the N start positions, expand [^>]* to end-of-string, fail
    // to find Value="...", backtrack, and fail — O(remaining length) of
    // wasted work per occurrence. No 'Value="..."' attribute is present
    // either, so this also exercises the "not found" path end-to-end.
    const openCount = 20_000
    const entryXml =
      '<CheatEntry><ID>1</ID><Description>"LastState DoS"</Description>' +
      '<VariableType>4 Bytes</VariableType>' +
      '<Address>"game.exe"+1000</Address>' +
      '<LastState '.repeat(openCount) +
      '</CheatEntry>'
    const xml = wrapTable(entryXml)

    const started = Date.now()
    const result = importCheatTable(xml)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(1000)
    // The entry itself is otherwise well-formed (valid VariableType and
    // module+offset Address), so it imports — but no <LastState ...>
    // ever closes with a '>', so no Value="..." attribute is ever found
    // and the value correctly defaults to 0, without hanging.
    expect(result.imported).toHaveLength(1)
    expect((result.imported[0] as CheatDefinition).value).toBe(0)
  })
})

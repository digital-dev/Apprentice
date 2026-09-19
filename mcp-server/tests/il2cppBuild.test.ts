import { describe, it, expect } from 'vitest'
import { buildIl2cppFactory, type BuildOps } from '../src/factory/il2cppBuild'
import type { Il2cppClassInfo, Il2cppEnumeration, Il2cppField, Il2cppMethod } from '../src/factory/il2cppEnumerator'
import type { HookSite } from '../src/factory/hookSite'
import { FakeMemory } from './helpers/fakeIl2cpp'
import type { DataType } from '../src/cheatVerify'

function field(cls: string, ptr: string, name: string, offset: number, dataType: DataType | null, isStatic = false): Il2cppField {
  return { className: cls, classPtr: ptr, fieldName: name, offset, dataType, isStatic }
}

function method(cls: string, ptr: string, name: string): Il2cppMethod {
  return { className: cls, classPtr: ptr, name, pointer: '0x7ff600001000', isStatic: false, paramCount: 0 }
}

function klass(name: string, ptr: string, fields: Il2cppField[], methods: Il2cppMethod[]): Il2cppClassInfo {
  return { className: name, namespaceName: '', classPtr: ptr, parentPtr: '0x0', staticFieldsPtr: '0x0', fields, methods }
}

const MONEY = klass(
  'MoneyManager',
  '0x1000',
  [
    field('MoneyManager', '0x1000', 'onlineBalance', 0x128, 'float'),
    field('MoneyManager', '0x1000', '<Instance>k__BackingField', 0, null, true)
  ],
  [method('MoneyManager', '0x1000', 'Update')]
)
const PLAYER = klass(
  'PlayerHealth',
  '0x2000',
  [
    field('PlayerHealth', '0x2000', 'health', 0x40, 'float'),
    field('PlayerHealth', '0x2000', 'stamina', 0x44, 'float')
  ],
  [method('PlayerHealth', '0x2000', 'Update')]
)

const ROOT = { className: 'MoneyManager', fieldName: '<Instance>k__BackingField', instancePtr: '0x6000', instanceClassPtr: '0x1000' }

function enumeration(classes: Il2cppClassInfo[], roots = [ROOT]): Il2cppEnumeration {
  return { classes, roots, classesTotal: classes.length, classesScanned: classes.length, skipped: [] }
}

function site(m: Il2cppMethod, rva = '0x5ca073'): HookSite {
  return { method: m, rva, originalBytes: '48895c2408', length: 5, signature: '48 89 5c 24 08 ?? ??' }
}

function opsWith(balance: number, hook: (methods: Il2cppMethod[]) => HookSite | null = (ms) => site(ms[0])): BuildOps {
  const mem = new FakeMemory()
  mem.float(0x6000 + 0x128, balance)
  return {
    moduleName: 'GameAssembly.dll',
    readBytes: mem.readBytes,
    chooseHook: async (methods) => hook(methods)
  }
}

describe('buildIl2cppFactory', () => {
  it('drafts a verified capture-patch + anchor pair for money', async () => {
    const r = await buildIl2cppFactory(['money'], enumeration([MONEY, PLAYER]), opsWith(500))
    expect(r.patches).toEqual([
      {
        kind: 'patch',
        mode: 'capture',
        id: 'factory-capture-MoneyManager',
        name: 'Capture: MoneyManager.Update instance',
        originalBytes: '48895c2408',
        length: 5,
        signature: '48 89 5c 24 08 ?? ??',
        signatureOffset: 0,
        moduleName: 'GameAssembly.dll',
        moduleOffset: '0x5ca073',
        baseRegister: 'rcx',
        internal: true
      }
    ])
    expect(r.cheats).toEqual([
      {
        id: 'factory-money',
        name: 'Unlimited Money',
        dataType: 'float',
        mode: 'freeze',
        targets: [{ kind: 'anchor', patchId: 'factory-capture-MoneyManager', offset: '0x128', dataType: 'float' }],
        value: 999999
      }
    ])
    expect(r.checklist[0]).toMatchObject({
      id: 'factory-money',
      className: 'MoneyManager',
      fieldName: 'onlineBalance',
      verified: true,
      liveValue: 500,
      multiInstanceRisk: false,
      hook: 'MoneyManager.Update'
    })
  })

  it('drafts an unverified cheat, flagged for multi-instance risk, when no root reaches the class', async () => {
    const r = await buildIl2cppFactory(['health'], enumeration([MONEY, PLAYER]), opsWith(500))
    expect(r.cheats.map((c) => c.id)).toEqual(['factory-health'])
    expect(r.checklist[0]).toMatchObject({ verified: false, liveValue: null, multiInstanceRisk: true })
  })

  // Realistic user-mode addresses: the scanner ignores anything under the 64 KB null page.
  const HEAP_ROOT = 0x1d400006000n
  const HEAP_COMPONENT = 0x1d400007000n
  const heapRoot = { ...ROOT, instancePtr: '0x' + HEAP_ROOT.toString(16) }

  function heapWorld(componentClass: number): BuildOps {
    const mem = new FakeMemory()
    mem.qword(HEAP_ROOT, 0x1000) // root instance header
    mem.qword(HEAP_ROOT + 0x30n, HEAP_COMPONENT) // reference to the component
    mem.qword(HEAP_COMPONENT, componentClass) // the component's class header
    mem.float(HEAP_COMPONENT + 0x40n, 100)
    return { moduleName: 'GameAssembly.dll', readBytes: mem.readBytes, chooseHook: async (ms) => site(ms[0]) }
  }

  it('verifies a component class by following a reference from the singleton root', async () => {
    const r = await buildIl2cppFactory(['health'], enumeration([PLAYER], [heapRoot]), heapWorld(0x2000))
    expect(r.checklist[0]).toMatchObject({ verified: true, liveValue: 100, multiInstanceRisk: false })
  })

  it('ignores a referenced object of a different class', async () => {
    const r = await buildIl2cppFactory(['health'], enumeration([PLAYER], [heapRoot]), heapWorld(0x3333))
    expect(r.checklist[0]).toMatchObject({ verified: false })
  })

  // Fallback for classes no root reaches: scan memory for objects whose
  // header is the class pointer, dropping metadata self-references.
  function scanWorld(hitsFor: (classPtr: bigint) => bigint[], setup: (mem: FakeMemory) => void): BuildOps {
    const mem = new FakeMemory()
    setup(mem)
    return {
      moduleName: 'GameAssembly.dll',
      readBytes: mem.readBytes,
      chooseHook: async (ms) => site(ms[0]),
      scanQword: async (v) => hitsFor(v).map((a) => '0x' + a.toString(16))
    }
  }
  const OBJ = 0x1d400009000n
  const NOROOT = enumeration([PLAYER], [])

  it('verifies through an instance scan and is low-risk when exactly one instance exists', async () => {
    const ops = scanWorld(
      () => [OBJ, 0x2000n + 0x40n], // a real object, plus a hit inside the class struct itself
      (m) => {
        m.qword(OBJ, 0x2000)
        m.qword(OBJ + 8n, 0) // null monitor: an object, not a metadata record
        m.float(OBJ + 0x40n, 80)
        m.qword(0x2040, 0x2000) // the class's own self-reference
        m.qword(0x2048, 0x1234) // nonzero neighbour
      }
    )
    const r = await buildIl2cppFactory(['health'], NOROOT, ops)
    expect(r.checklist[0]).toMatchObject({ verified: true, liveValue: 80, instanceCount: 1, multiInstanceRisk: false })
  })

  it('drops scan hits that are metadata records (non-null word after the pointer)', async () => {
    const meta = 0x1d40000a000n
    const ops = scanWorld(
      () => [meta],
      (m) => {
        m.qword(meta, 0x2000)
        m.qword(meta + 8n, 0x7ff600004000n) // e.g. a return_type pointer
        m.float(meta + 0x40n, 80)
      }
    )
    const r = await buildIl2cppFactory(['health'], NOROOT, ops)
    expect(r.checklist[0]).toMatchObject({ verified: false, instanceCount: 0 })
  })

  it('flags multi-instance risk when several live instances are found', async () => {
    const second = 0x1d40000b000n
    const ops = scanWorld(
      () => [OBJ, second],
      (m) => {
        for (const o of [OBJ, second]) {
          m.qword(o, 0x2000)
          m.qword(o + 8n, 0)
          m.float(o + 0x40n, 60)
        }
      }
    )
    const r = await buildIl2cppFactory(['health'], NOROOT, ops)
    expect(r.checklist[0]).toMatchObject({ verified: true, instanceCount: 2, multiInstanceRisk: true })
  })

  it('does not accept a zero from a scan: zero is what garbage hits read as', async () => {
    const ops = scanWorld(
      () => [OBJ],
      (m) => {
        m.qword(OBJ, 0x2000)
        m.qword(OBJ + 8n, 0)
        m.float(OBJ + 0x44n, 0) // stamina's plausible range includes 0
      }
    )
    const r = await buildIl2cppFactory(['stamina'], NOROOT, ops)
    expect(r.checklist[0]).toMatchObject({ verified: false, instanceCount: 1 })
  })

  it('still accepts a zero read through a singleton root (authoritative)', async () => {
    const r = await buildIl2cppFactory(['money'], enumeration([MONEY]), opsWith(0))
    expect(r.checklist[0]).toMatchObject({ verified: true, liveValue: 0 })
  })

  it('does not verify when every scanned instance reads an implausible value', async () => {
    const ops = scanWorld(
      () => [OBJ],
      (m) => {
        m.qword(OBJ, 0x2000)
        m.qword(OBJ + 8n, 0)
        m.float(OBJ + 0x40n, -5) // health plausible range starts at 1
      }
    )
    const r = await buildIl2cppFactory(['health'], NOROOT, ops)
    expect(r.checklist[0]).toMatchObject({ verified: false })
  })

  it('shares one capture patch between cheats on the same class', async () => {
    const r = await buildIl2cppFactory(['health', 'stamina'], enumeration([PLAYER]), opsWith(0))
    expect(r.patches).toHaveLength(1)
    expect(r.cheats.map((c) => c.targets[0])).toEqual([
      expect.objectContaining({ patchId: 'factory-capture-PlayerHealth', offset: '0x40' }),
      expect.objectContaining({ patchId: 'factory-capture-PlayerHealth', offset: '0x44' })
    ])
  })

  it('rejects a field whose type is not allowed for the category', async () => {
    const wrongType = klass('PlayerHealth', '0x2000', [field('PlayerHealth', '0x2000', 'health', 0x40, 'int8')], PLAYER.methods)
    const r = await buildIl2cppFactory(['health'], enumeration([wrongType]), opsWith(0))
    expect(r.notFound).toEqual(['health'])
  })

  it('skips static fields', async () => {
    const stat = klass('PlayerHealth', '0x2000', [field('PlayerHealth', '0x2000', 'health', 0x40, 'float', true)], PLAYER.methods)
    const r = await buildIl2cppFactory(['health'], enumeration([stat]), opsWith(0))
    expect(r.notFound).toEqual(['health'])
  })

  it('rejects a candidate whose verified read is implausible and reports why', async () => {
    const r = await buildIl2cppFactory(['money'], enumeration([MONEY]), opsWith(1e12))
    expect(r.cheats).toEqual([])
    expect(r.unresolved).toEqual([{ category: 'money', reason: expect.stringContaining('implausible') }])
  })

  it('reports unresolved when no method on the class can be hooked', async () => {
    const r = await buildIl2cppFactory(['money'], enumeration([MONEY]), opsWith(500, () => null))
    expect(r.cheats).toEqual([])
    expect(r.unresolved).toEqual([{ category: 'money', reason: expect.stringContaining('hook') }])
  })

  it('reports landmine and unknown categories without drafting', async () => {
    const r = await buildIl2cppFactory(['hunger', 'speed', 'bogus'], enumeration([PLAYER]), opsWith(0))
    expect(r.manual.map((m) => m.category)).toEqual(['hunger', 'speed'])
    expect(r.notFound).toEqual(['bogus'])
    expect(r.cheats).toEqual([])
  })
})

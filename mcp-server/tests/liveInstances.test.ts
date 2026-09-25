import { describe, it, expect } from 'vitest'
import { findLiveInstances, type LiveInstanceOps } from '../src/factory/liveInstances'
import { FakeMemory, classHex, methodHex } from './helpers/fakeIl2cpp'

// Target assembly: one class "Widget" (plus one unrelated decoy class the
// name regex won't match, since findClassTable always walks a real
// table-of-two — see il2cppBootstrap.test.ts's own fixture for why).
// Every address below is spaced at least 0x1000 apart: a class struct write
// is a full CLASS_HEADER_BYTES (0x130) block, so anything closer risks one
// write silently zeroing a neighbour's string (bit us once while writing this).
const TARGET_TABLE = 0x10000n
const WIDGET_CLASS = 0x11000n
const DECOY_CLASS = 0x12000n
const WIDGET_NAME = 0x13000n
const DECOY_NAME = 0x14000n

// UnityEngine.CoreModule: one class "Object" (namespace "UnityEngine") with
// a single declared method "FindObjectsOfType(Type)".
const OBJ_TABLE = 0x20000n
const OBJECT_CLASS = 0x21000n
const OBJ_DECOY_CLASS = 0x22000n
const OBJECT_NAME = 0x23000n
const OBJ_DECOY_NAME = 0x24000n
const UNITYENGINE_NS = 0x25000n
const METHOD_TABLE = 0x26000n // Il2CppClass.methodsPtr -> array of MethodInfo*
const METHOD_REC = 0x27000n
const METHOD_NAME = 0x28000n
const METHOD_POINTER = 0x7ffabc001000n

const CLASS_GET_TYPE_EXPORT = 0x7ffabc002000n
const TYPE_GET_OBJECT_EXPORT = 0x7ffabc003000n
const IL2CPP_TYPE = 0x7ffabc004000n
const TYPE_OBJ = 0x7ffabc005000n
const RESULT_ARRAY = 0x30000n
const INSTANCE_A = 0x31000n
const INSTANCE_B = 0x32000n

function buildMemory(): FakeMemory {
  const mem = new FakeMemory()

  mem.cstr(WIDGET_NAME, 'Widget')
  mem.set(WIDGET_CLASS, classHex({ name: WIDGET_NAME, methodCount: 0, fieldCount: 0 }))
  mem.cstr(DECOY_NAME, 'NotWidget')
  mem.set(DECOY_CLASS, classHex({ name: DECOY_NAME, methodCount: 0, fieldCount: 0 }))
  mem.qword(TARGET_TABLE, WIDGET_CLASS)
  mem.qword(TARGET_TABLE + 8n, DECOY_CLASS)

  mem.cstr(OBJECT_NAME, 'Object')
  mem.cstr(UNITYENGINE_NS, 'UnityEngine')
  mem.set(
    OBJECT_CLASS,
    classHex({ name: OBJECT_NAME, namespace: UNITYENGINE_NS, methods: METHOD_TABLE, methodCount: 1, fieldCount: 0 })
  )
  mem.cstr(OBJ_DECOY_NAME, 'NotObject')
  mem.set(OBJ_DECOY_CLASS, classHex({ name: OBJ_DECOY_NAME, methodCount: 0, fieldCount: 0 }))
  mem.qword(OBJ_TABLE, OBJECT_CLASS)
  mem.qword(OBJ_TABLE + 8n, OBJ_DECOY_CLASS)

  mem.qword(METHOD_TABLE, METHOD_REC)
  mem.cstr(METHOD_NAME, 'FindObjectsOfType')
  mem.set(METHOD_REC, methodHex(METHOD_POINTER, METHOD_NAME, OBJECT_CLASS, 0, 1))

  // Il2CppArray: length @+0x18, element data @+0x20.
  mem.set(RESULT_ARRAY + 0x18n, Buffer.from([2, 0, 0, 0]).toString('hex'))
  mem.qword(RESULT_ARRAY + 0x20n, INSTANCE_A)
  mem.qword(RESULT_ARRAY + 0x20n + 8n, INSTANCE_B)

  return mem
}

// Mirrors il2cppBootstrap.test.ts's own remote-call mock, but must answer
// TWO independent findClassTable runs (target assembly, then
// UnityEngine.CoreModule) distinguished by which name writeString most
// recently wrote — the same way the real target's assembly_open call
// actually depends on the string just written to scratch.
function makeOps(mem: FakeMemory, overrides: Partial<LiveInstanceOps> = {}): LiveInstanceOps {
  let lastWritten = ''
  const scratch = '0x7fffeb9f0000'
  return {
    call: async (fn, args) => {
      const forTarget = lastWritten === 'Assembly-CSharp'
      switch (fn) {
        case 'domain_get':
          return '0x1'
        case 'assembly_open':
          return '0x2'
        case 'assembly_get_image':
          return '0x3'
        case 'image_class_count':
          return '0x2'
        case 'image_get_class':
          if (args[1] === '0x0') return '0x' + (forTarget ? WIDGET_CLASS.toString(16) : OBJECT_CLASS.toString(16))
          return '0x' + (forTarget ? DECOY_CLASS.toString(16) : OBJ_DECOY_CLASS.toString(16))
      }
      return null
    },
    writeString: (text) => {
      lastWritten = text
      return scratch
    },
    scanQword: async (value) => {
      if (value === WIDGET_CLASS) return ['0x' + TARGET_TABLE.toString(16)]
      if (value === OBJECT_CLASS) return ['0x' + OBJ_TABLE.toString(16)]
      return []
    },
    readBytes: mem.readBytes,
    resolveExport: (name) =>
      name === 'il2cpp_class_get_type'
        ? '0x' + CLASS_GET_TYPE_EXPORT.toString(16)
        : name === 'il2cpp_type_get_object'
          ? '0x' + TYPE_GET_OBJECT_EXPORT.toString(16)
          : null,
    callRemote: async (functionAddress, callArgs) => {
      if (functionAddress === '0x' + CLASS_GET_TYPE_EXPORT.toString(16)) return '0x' + IL2CPP_TYPE.toString(16)
      if (functionAddress === '0x' + TYPE_GET_OBJECT_EXPORT.toString(16)) return '0x' + TYPE_OBJ.toString(16)
      if (functionAddress === '0x' + METHOD_POINTER.toString(16)) {
        // Called as FindObjectsOfType(typeObj, methodInfoRecord) — sanity
        // check the args are what a real IL2CPP call site would pass.
        if (callArgs[0] !== '0x' + TYPE_OBJ.toString(16)) return null
        return '0x' + RESULT_ARRAY.toString(16)
      }
      return null
    },
    ...overrides
  }
}

describe('findLiveInstances', () => {
  it('resolves the target class and returns every live instance FindObjectsOfType reports', async () => {
    const mem = buildMemory()
    const ops = makeOps(mem)
    const result = await findLiveInstances(ops, 'Assembly-CSharp', 'Widget')
    expect(result).toEqual({
      classPtr: '0x' + WIDGET_CLASS.toString(16),
      instances: ['0x' + INSTANCE_A.toString(16), '0x' + INSTANCE_B.toString(16)]
    })
  })

  it('returns an empty instance list, not an error, when nothing is live yet', async () => {
    const mem = buildMemory()
    const ops = makeOps(mem, {
      callRemote: async (functionAddress) => {
        if (functionAddress === '0x' + CLASS_GET_TYPE_EXPORT.toString(16)) return '0x' + IL2CPP_TYPE.toString(16)
        if (functionAddress === '0x' + TYPE_GET_OBJECT_EXPORT.toString(16)) return '0x' + TYPE_OBJ.toString(16)
        if (functionAddress === '0x' + METHOD_POINTER.toString(16)) return '0x0'
        return null
      }
    })
    const result = await findLiveInstances(ops, 'Assembly-CSharp', 'Widget')
    expect(result).toEqual({ classPtr: '0x' + WIDGET_CLASS.toString(16), instances: [] })
  })

  it('errors clearly when the class name does not resolve to exactly one class', async () => {
    const mem = buildMemory()
    const ops = makeOps(mem)
    const result = await findLiveInstances(ops, 'Assembly-CSharp', 'NoSuchClass')
    expect(result).toEqual({ error: expect.stringMatching(/exactly 1 class/) })
  })

  it('errors when GameAssembly.dll is missing the il2cpp_class_get_type/il2cpp_type_get_object exports', async () => {
    const mem = buildMemory()
    const ops = makeOps(mem, { resolveExport: () => null })
    const result = await findLiveInstances(ops, 'Assembly-CSharp', 'Widget')
    expect(result).toEqual({ error: expect.stringMatching(/il2cpp_class_get_type/) })
  })

  it('errors when FindObjectsOfType is not found on UnityEngine.Object (stripped build)', async () => {
    const mem = buildMemory()
    // Blank out the method name so the FindObjectsOfType match fails.
    mem.cstr(METHOD_NAME, 'SomethingElse')
    const ops = makeOps(mem)
    const result = await findLiveInstances(ops, 'Assembly-CSharp', 'Widget')
    expect(result).toEqual({ error: expect.stringMatching(/FindObjectsOfType/) })
  })
})

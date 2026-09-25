import { leU64, toHex, decodeClass, decodeMethod, CLASS_HEADER_BYTES, METHOD_STRIDE } from './il2cppLayout'
import { findClassTable, type BootstrapOps } from './il2cppBootstrap'
import { enumerateIl2cpp } from './il2cppEnumerator'

// Finds every LIVE instance of a UnityEngine.Object-derived IL2CPP class by
// calling the engine's own UnityEngine.Object.FindObjectsOfType(Type)
// through the generic remote-call primitives (resolve_export/
// call_remote_function) — far more reliable than scanning the heap for the
// class pointer, which also matches hundreds of metadata self-references
// (MethodInfo.klass records, RGCTX/generic-instance tables, ...) that read
// as garbage when treated as real object data. See
// docs/superpowers/specs/2026-09-07-il2cpp-symbol-resolution-design.md for
// the underlying resolution recipe this composes, and
// il2cpp-engine-instance-discovery.md (session memory) for why this beat
// classPtr-heap-scanning in practice.
//
// Only works for classes Unity's own object system tracks (MonoBehaviour,
// ScriptableObject, Component, ...) — a plain C# class/struct never shows
// up here even if IL2CPP-compiled; there's no engine-side registry for it
// to search. findLiveInstances returning zero instances for such a class is
// expected, not a bug — callers should fall back to a heap-scan-and-filter
// approach (or, for a static/global object, a known singleton field) instead
// of retrying this.
export interface LiveInstanceOps extends BootstrapOps {
  resolveExport(name: string): string | null
  callRemote(functionAddress: string, args: string[]): Promise<string | null>
}

export interface LiveInstanceResult {
  classPtr: string
  instances: string[]
}

function readCString(ops: LiveInstanceOps, ptr: string): string | null {
  if (BigInt(ptr) < 0x10000n) return null
  const hex = ops.readBytes(ptr, 128)
  if (hex === null) return null
  const buf = Buffer.from(hex, 'hex')
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8')
}

export async function findLiveInstances(
  ops: LiveInstanceOps,
  assemblyName: string,
  className: string
): Promise<LiveInstanceResult | { error: string }> {
  const targetPtrs = await findClassTable(ops, assemblyName)
  const targetEnum = enumerateIl2cpp({ readBytes: ops.readBytes }, targetPtrs, [new RegExp(`^${className}$`)])
  if (targetEnum.classes.length !== 1) {
    return {
      error: `expected exactly 1 class named "${className}" in ${assemblyName}, found ${targetEnum.classes.length}`
    }
  }
  const targetClassPtr = targetEnum.classes[0].classPtr

  const objPtrs = await findClassTable(ops, 'UnityEngine.CoreModule')
  const objEnum = enumerateIl2cpp({ readBytes: ops.readBytes }, objPtrs, [/^Object$/])
  const objClass = objEnum.classes.find((c) => c.namespaceName === 'UnityEngine')
  if (objClass === undefined) return { error: 'UnityEngine.Object not found in UnityEngine.CoreModule' }

  const headerHex = ops.readBytes(objClass.classPtr, CLASS_HEADER_BYTES)
  if (headerHex === null) return { error: "could not read UnityEngine.Object's own class header" }
  const header = decodeClass(headerHex)
  if (header.methodCount === 0) return { error: 'UnityEngine.Object reports zero methods (managed-code stripping?)' }
  const methodArrayHex = ops.readBytes(header.methodsPtr, header.methodCount * 8)
  if (methodArrayHex === null) return { error: "could not read UnityEngine.Object's method table" }

  let found: { recPtr: string; pointer: string } | null = null
  for (let i = 0; i < header.methodCount; i++) {
    const recPtr = toHex(leU64(methodArrayHex, i * 8))
    const recHex = ops.readBytes(recPtr, METHOD_STRIDE)
    if (recHex === null) continue
    const rec = decodeMethod(recHex)
    const name = readCString(ops, rec.namePtr)
    if (name === 'FindObjectsOfType' && rec.paramCount === 1) {
      found = { recPtr, pointer: rec.pointer }
      break
    }
  }
  if (found === null) {
    return { error: 'UnityEngine.Object.FindObjectsOfType(Type) not found (managed-code stripping removed it?)' }
  }

  const classGetType = ops.resolveExport('il2cpp_class_get_type')
  const typeGetObject = ops.resolveExport('il2cpp_type_get_object')
  if (classGetType === null || typeGetObject === null) {
    return { error: 'GameAssembly.dll is missing il2cpp_class_get_type or il2cpp_type_get_object' }
  }

  const il2cppType = await ops.callRemote(classGetType, [targetClassPtr])
  if (il2cppType === null || BigInt(il2cppType) === 0n) return { error: 'il2cpp_class_get_type returned null' }
  const typeObj = await ops.callRemote(typeGetObject, [il2cppType])
  if (typeObj === null || BigInt(typeObj) === 0n) return { error: 'il2cpp_type_get_object returned null' }

  const arrayPtr = await ops.callRemote(found.pointer, [typeObj, found.recPtr])
  if (arrayPtr === null) return { error: 'FindObjectsOfType remote call failed' }
  if (BigInt(arrayPtr) === 0n) return { classPtr: targetClassPtr, instances: [] }

  // Il2CppArray: klass+monitor (0x10), bounds ptr (0x10), max_length int32
  // (0x18, padded to 8), element data starts at 0x20 — offsets verified live
  // against this project's Unity 2022.3 IL2CPP builds; re-check on a build
  // where this comes back implausible (see the length guard below).
  const lenHex = ops.readBytes(toHex(BigInt(arrayPtr) + 0x18n), 4)
  if (lenHex === null) return { error: 'could not read the result array length' }
  const len = Buffer.from(lenHex, 'hex').readInt32LE(0)
  if (len < 0 || len > 100000) return { error: `implausible result array length ${len}; offsets may not match this build` }
  const instances: string[] = []
  if (len > 0) {
    const dataHex = ops.readBytes(toHex(BigInt(arrayPtr) + 0x20n), len * 8)
    if (dataHex === null) return { error: 'could not read the result array contents' }
    for (let i = 0; i < len; i++) instances.push(toHex(leU64(dataHex, i * 8)))
  }
  return { classPtr: targetClassPtr, instances }
}

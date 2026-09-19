import type { DataType } from '../cheatVerify'
import {
  CLASS_HEADER_BYTES,
  FIELD_STRIDE,
  METHOD_STRIDE,
  TYPE_BYTES,
  cString,
  decodeClass,
  decodeField,
  decodeMethod,
  decodeType,
  leU64,
  toHex,
  typeEnumToDataType
} from './il2cppLayout'

// Reads only: enumeration is pure struct decoding over memory, so it costs
// no remote thread per class/field/method (see the design spec).
export interface Il2cppOps {
  readBytes(address: string, length: number): string | null
}

export interface Il2cppField {
  className: string
  classPtr: string
  fieldName: string
  offset: number
  dataType: DataType | null
  isStatic: boolean
}

export interface Il2cppMethod {
  className: string
  classPtr: string
  name: string
  pointer: string
  isStatic: boolean
  paramCount: number
}

export interface Il2cppClassInfo {
  className: string
  namespaceName: string
  classPtr: string
  parentPtr: string
  staticFieldsPtr: string
  fields: Il2cppField[]
  methods: Il2cppMethod[]
}

export interface Il2cppRoot {
  className: string
  fieldName: string
  instancePtr: string
  instanceClassPtr: string
}

export interface Il2cppEnumeration {
  classes: Il2cppClassInfo[]
  roots: Il2cppRoot[]
  classesTotal: number
  classesScanned: number
  // Human-readable reasons a class was dropped (failed layout cross-check).
  skipped: string[]
}

// Names that look like a singleton handle to the live instance, including
// the compiler-generated backing field of `static T Instance { get; }`.
const ROOT_NAME =
  /^(?:(?:m_|_|s_)?(?:instance|local|localplayer|player|current|main|singleton)|<(?:instance|local|localplayer|current|main|singleton)>k__BackingField)$/i

const NAME_BYTES = 128
const MAX_FIELDS = 512
const MAX_METHODS = 2048

function readString(ops: Il2cppOps, ptr: string): string | null {
  const hex = ops.readBytes(ptr, NAME_BYTES)
  return hex === null ? null : cString(hex)
}

function isNull(ptr: string): boolean {
  return BigInt(ptr) === 0n
}

export function enumerateIl2cpp(ops: Il2cppOps, classPointers: string[], classHints: RegExp[]): Il2cppEnumeration {
  const classes: Il2cppClassInfo[] = []
  const skipped: string[] = []
  const typeCache = new Map<string, { dataType: DataType | null; isStatic: boolean } | null>()

  const typeOf = (typePtr: string) => {
    if (typeCache.has(typePtr)) return typeCache.get(typePtr)!
    const hex = ops.readBytes(typePtr, TYPE_BYTES)
    const entry = hex === null ? null : (() => {
      const t = decodeType(hex)
      return { dataType: typeEnumToDataType(t.typeEnum), isStatic: t.isStatic }
    })()
    typeCache.set(typePtr, entry)
    return entry
  }

  for (const classPtr of classPointers) {
    const headerHex = ops.readBytes(classPtr, CLASS_HEADER_BYTES)
    if (headerHex === null) continue
    const header = decodeClass(headerHex)
    const className = isNull(header.namePtr) ? null : readString(ops, header.namePtr)
    if (className === null || !classHints.some((h) => h.test(className))) continue

    const info: Il2cppClassInfo = {
      className,
      namespaceName: (isNull(header.namespacePtr) ? '' : readString(ops, header.namespacePtr)) ?? '',
      classPtr,
      parentPtr: header.parentPtr,
      staticFieldsPtr: header.staticFieldsPtr,
      fields: [],
      methods: []
    }
    classes.push(info)

    // Fields: one contiguous read; every record must name this class as its
    // parent or the layout (or the class pointer) is not what we think.
    if (header.fieldCount > 0 && header.fieldCount <= MAX_FIELDS && !isNull(header.fieldsPtr)) {
      const runHex = ops.readBytes(header.fieldsPtr, header.fieldCount * FIELD_STRIDE)
      const fields: Il2cppField[] = []
      let consistent = runHex !== null
      for (let i = 0; runHex !== null && i < header.fieldCount; i++) {
        const rec = decodeField(runHex.slice(i * FIELD_STRIDE * 2, (i + 1) * FIELD_STRIDE * 2))
        if (rec.parentPtr !== classPtr) {
          consistent = false
          break
        }
        const fieldName = readString(ops, rec.namePtr)
        const type = typeOf(rec.typePtr)
        if (fieldName === null || type === null) continue
        fields.push({ className, classPtr, fieldName, offset: rec.offset, dataType: type.dataType, isStatic: type.isStatic })
      }
      if (consistent) info.fields = fields
      else skipped.push(`${className}: field records do not point back at the class (layout mismatch)`)
    }

    // Methods: a pointer array whose entries point at contiguous records.
    if (header.methodCount > 0 && header.methodCount <= MAX_METHODS && !isNull(header.methodsPtr)) {
      const arrayHex = ops.readBytes(header.methodsPtr, header.methodCount * 8)
      for (let i = 0; arrayHex !== null && i < header.methodCount; i++) {
        const recPtr = toHex(leU64(arrayHex, i * 8))
        const recHex = ops.readBytes(recPtr, METHOD_STRIDE)
        if (recHex === null) continue
        const rec = decodeMethod(recHex)
        if (rec.klassPtr !== classPtr) continue
        const name = readString(ops, rec.namePtr)
        if (name === null) continue
        info.methods.push({ className, classPtr, name, pointer: rec.pointer, isStatic: rec.isStatic, paramCount: rec.paramCount })
      }
    }
  }

  // Roots: a singleton-looking static field holding a live instance. The
  // instance's own header names its exact class.
  const roots: Il2cppRoot[] = []
  for (const cls of classes) {
    if (isNull(cls.staticFieldsPtr)) continue
    for (const f of cls.fields) {
      if (!f.isStatic || !ROOT_NAME.test(f.fieldName)) continue
      const slot = ops.readBytes(toHex(BigInt(cls.staticFieldsPtr) + BigInt(f.offset)), 8)
      if (slot === null) continue
      const instance = leU64(slot, 0)
      if (instance === 0n) continue
      const header = ops.readBytes(toHex(instance), 8)
      if (header === null) continue
      roots.push({
        className: cls.className,
        fieldName: f.fieldName,
        instancePtr: toHex(instance),
        instanceClassPtr: toHex(leU64(header, 0))
      })
    }
  }

  return { classes, roots, classesTotal: classPointers.length, classesScanned: classes.length, skipped }
}

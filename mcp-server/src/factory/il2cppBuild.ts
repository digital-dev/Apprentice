import type { DataType } from '../cheatVerify'
import { categoryById, type Category } from './categories'
import { rankFields } from './ranker'
import type { Il2cppEnumeration, Il2cppField, Il2cppMethod, Il2cppRoot } from './il2cppEnumerator'
import type { HookSite } from './hookSite'
import { CLASS_HEADER_BYTES, decodeClass, leU64, toHex } from './il2cppLayout'

// Orchestration for IL2CPP: category -> ranked field -> (optional) live
// verification through a singleton -> hook site -> capture patch + anchor
// cheat. Everything native is behind BuildOps so this is unit-testable.

export interface BuildOps {
  moduleName: string
  readBytes(address: string, length: number): string | null
  // `hint` is the target field's property name; methods that touch it are
  // preferred so the hook fires when the game reads or changes that value.
  chooseHook(methods: Il2cppMethod[], hint?: string): Promise<HookSite | null>
  // Memory scan for a qword value (a class pointer), used to find live
  // instances no singleton root reaches. Optional: without it those cheats
  // are simply drafted unverified.
  scanQword?(value: bigint): Promise<string[]>
}

// The profile shapes Tamper already loads (see games/Schedule I.json).
export interface CapturePatchDraft {
  kind: 'patch'
  mode: 'capture'
  id: string
  name: string
  originalBytes: string
  length: number
  signature: string
  signatureOffset: number
  moduleName: string
  moduleOffset: string
  baseRegister: 'rcx'
  internal: true
}

export interface AnchorCheatDraft {
  id: string
  name: string
  dataType: DataType
  mode: 'freeze' | 'oneshot'
  targets: { kind: 'anchor'; patchId: string; offset: string; dataType: DataType }[]
  value: number
}

export interface Il2cppChecklistItem {
  id: string
  name: string
  className: string
  fieldName: string
  offset: number
  dataType: DataType
  hook: string
  // True when a live singleton instance was read through the field with a
  // plausible value; false means only the in-game pass confirms it.
  verified: boolean
  liveValue: number | null
  // Live instances found by scan when no root reached the class (null when
  // verification went through a root, or no scan ran).
  instanceCount: number | null
  // A capture hook records whichever instance ran last, so an unverified
  // cheat on a many-instance class may land on the wrong one.
  multiInstanceRisk: boolean
  lookFor: string
  alternates: string[]
}

export interface Il2cppFactoryResult {
  patches: CapturePatchDraft[]
  cheats: AnchorCheatDraft[]
  checklist: Il2cppChecklistItem[]
  manual: { category: string; note: string }[]
  notFound: string[]
  unresolved: { category: string; reason: string }[]
}

const VALUE_BYTES: Record<DataType, number> = { int8: 1, int16: 2, int32: 4, int64: 8, float: 4, double: 8 }
const MAX_PARENT_HOPS = 16

function decodeValue(hex: string, dataType: DataType): number {
  const b = Buffer.from(hex, 'hex')
  switch (dataType) {
    case 'int8':
      return b.readUInt8(0)
    case 'int16':
      return b.readInt16LE(0)
    case 'int32':
      return b.readInt32LE(0)
    case 'int64':
      return Number(b.readBigInt64LE(0))
    case 'float':
      return b.readFloatLE(0)
    case 'double':
      return b.readDoubleLE(0)
  }
}

// True when `wantedClassPtr` is the instance's class or one of its bases.
function classChainIncludes(ops: BuildOps, startPtr: string, wantedClassPtr: string): boolean {
  let ptr = startPtr
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
    if (BigInt(ptr) === 0n) return false
    if (BigInt(ptr) === BigInt(wantedClassPtr)) return true
    const header = ops.readBytes(ptr, 0x60)
    if (header === null) return false
    ptr = toHex(leU64(header, 0x58))
  }
  return false
}

interface Verification {
  state: 'verified' | 'implausible' | 'unverified'
  value: number | null
  instanceCount: number | null
  // True when a singleton root or a single live instance pins down which
  // object the capture hook will record.
  lowRisk: boolean
}

// How much of a root object to search for references to component objects
// when its class header does not give an instance size, and the user-mode
// pointer range a plausible reference falls in.
const FALLBACK_SCAN_BYTES = 0x400
const MAX_OBJECT_SCAN_BYTES = 0x8000
const MIN_POINTER = 0x10000n
const MAX_POINTER = 0x7fffffffffffn
const MAX_SCANNED_INSTANCES = 64
// A scan that finds more candidates than this is mostly noise (freed and
// look-alike objects), so its values prove nothing.
const MAX_TRUSTED_SCAN_INSTANCES = 16

function instanceWindow(ops: BuildOps, classPtr: string): number {
  const hex = ops.readBytes(classPtr, CLASS_HEADER_BYTES)
  if (hex === null) return FALLBACK_SCAN_BYTES
  const size = decodeClass(hex).instanceSize
  return size >= 0x20 && size <= MAX_OBJECT_SCAN_BYTES ? size : FALLBACK_SCAN_BYTES
}

// Components are usually reached from a singleton by a plain reference field
// (Player.Local -> its health component). Rather than decode every field
// type, scan the root object's qwords for a pointer whose Il2CppObject
// header names exactly the wanted class.
function referencedInstances(ops: BuildOps, root: Il2cppRoot, wantedClassPtr: string): string[] {
  const size = instanceWindow(ops, root.instanceClassPtr)
  const hex = ops.readBytes(root.instancePtr, size)
  if (hex === null) return []
  const wanted = BigInt(wantedClassPtr)
  const found: string[] = []
  // Skip the 16-byte Il2CppObject header (class pointer, monitor).
  for (let offset = 0x10; offset + 8 <= size; offset += 8) {
    const pointer = leU64(hex, offset)
    if (pointer < MIN_POINTER || pointer > MAX_POINTER) continue
    const header = ops.readBytes(toHex(pointer), 8)
    if (header !== null && leU64(header, 0) === wanted) found.push(toHex(pointer))
  }
  return found
}

// Live objects of a class found by scanning for its pointer. Most hits are
// metadata (the class's own self-references, FieldInfo.parent,
// MethodInfo.klass, the class table); a real object's monitor word, right
// after the class pointer, is null there and nonzero in those records.
async function scannedInstances(ops: BuildOps, classPtr: string): Promise<string[]> {
  if (ops.scanQword === undefined) return []
  const cls = BigInt(classPtr)
  const found: string[] = []
  for (const hit of await ops.scanQword(cls)) {
    const address = BigInt(hit)
    if (address >= cls && address < cls + BigInt(CLASS_HEADER_BYTES)) continue
    if (address % 8n !== 0n) continue
    const monitor = ops.readBytes(toHex(address + 8n), 8)
    if (monitor === null || leU64(monitor, 0) !== 0n) continue
    found.push(toHex(address))
    if (found.length >= MAX_SCANNED_INSTANCES) break
  }
  return found
}

async function verifyField(field: Il2cppField, roots: Il2cppRoot[], ops: BuildOps, cat: Category): Promise<Verification> {
  const dataType = field.dataType as DataType
  const [lo, hi] = cat.plausible
  const plausible = (v: number) => Number.isFinite(v) && v >= lo && v <= hi
  const read = (instancePtr: string): number | null => {
    const hex = ops.readBytes(toHex(BigInt(instancePtr) + BigInt(field.offset)), VALUE_BYTES[dataType])
    return hex === null ? null : decodeValue(hex, dataType)
  }

  // 1. Through a live singleton root: authoritative, so an implausible
  //    read here means the field or type is wrong and rejects the candidate.
  //    A zero is fine here: it is the real object's real value.
  let rootImplausible: number | null = null
  for (const root of roots) {
    const instances = classChainIncludes(ops, root.instanceClassPtr, field.classPtr)
      ? [root.instancePtr]
      : referencedInstances(ops, root, field.classPtr)
    for (const instance of instances) {
      const v = read(instance)
      if (v === null) continue
      if (plausible(v)) return { state: 'verified', value: v, instanceCount: null, lowRisk: true }
      rootImplausible = v
    }
  }
  if (rootImplausible !== null) return { state: 'implausible', value: rootImplausible, instanceCount: null, lowRisk: false }

  // 2. By scanning for live instances. Not authoritative: stray hits (freed
  //    objects, look-alike records) read as garbage, and zero is what garbage
  //    most often reads as. So demand a plausible NON-ZERO value, and let
  //    failure leave the cheat unverified rather than rejected.
  if (ops.scanQword === undefined) return { state: 'unverified', value: null, instanceCount: null, lowRisk: false }
  const instances = await scannedInstances(ops, field.classPtr)
  if (instances.length > MAX_TRUSTED_SCAN_INSTANCES) {
    return { state: 'unverified', value: null, instanceCount: instances.length, lowRisk: false }
  }
  for (const instance of instances) {
    const v = read(instance)
    if (v !== null && v !== 0 && plausible(v)) {
      return { state: 'verified', value: v, instanceCount: instances.length, lowRisk: instances.length === 1 }
    }
  }
  return { state: 'unverified', value: null, instanceCount: instances.length, lowRisk: false }
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_')

export async function buildIl2cppFactory(
  wishlist: string[],
  enumeration: Il2cppEnumeration,
  ops: BuildOps
): Promise<Il2cppFactoryResult> {
  const result: Il2cppFactoryResult = { patches: [], cheats: [], checklist: [], manual: [], notFound: [], unresolved: [] }
  const patchIds = new Set<string>()
  const hookCache = new Map<string, HookSite | null>()
  // Identical-code folding: the linker merges byte-identical functions, so
  // one methodPointer can belong to several classes' MethodInfos (typically
  // trivial getters). A capture hook there fires for whichever class calls
  // it, so any pointer owned by more than one class is not a hook site.
  const ownersByPointer = new Map<string, Set<string>>()
  for (const c of enumeration.classes) {
    for (const m of c.methods) {
      if (!ownersByPointer.has(m.pointer)) ownersByPointer.set(m.pointer, new Set())
      ownersByPointer.get(m.pointer)!.add(c.classPtr)
    }
  }
  const methodsByClass = new Map(
    enumeration.classes.map((c) => [c.classPtr, c.methods.filter((m) => ownersByPointer.get(m.pointer)!.size === 1)])
  )

  const propertyName = (fieldName: string): string => fieldName.replace(/^<|>k__BackingField$/g, '')
  const hookFor = async (classPtr: string, fieldName: string): Promise<HookSite | null> => {
    if (!hookCache.has(classPtr)) {
      hookCache.set(classPtr, await ops.chooseHook(methodsByClass.get(classPtr) ?? [], propertyName(fieldName)))
    }
    return hookCache.get(classPtr)!
  }

  for (const id of wishlist) {
    const cat = categoryById(id)
    if (cat === undefined) {
      result.notFound.push(id)
      continue
    }
    if (cat.manualReview !== undefined) {
      result.manual.push({ category: id, note: cat.manualReview })
      continue
    }

    // Type fit and instance-only: statics live in another block entirely.
    const candidates = enumeration.classes
      .flatMap((c) => c.fields)
      .filter((f) => !f.isStatic && f.dataType !== null && cat.dataTypes.includes(f.dataType))
    const ranked = rankFields(cat, candidates)
    if (ranked.length === 0) {
      result.notFound.push(id)
      continue
    }

    let implausible = false
    let unhookable = false
    let done = false
    for (const field of ranked) {
      const verification = await verifyField(field, enumeration.roots, ops, cat)
      if (verification.state === 'implausible') {
        implausible = true
        continue
      }
      const hook = await hookFor(field.classPtr, field.fieldName)
      if (hook === null) {
        unhookable = true
        continue
      }

      const dataType = field.dataType as DataType
      const patchId = `factory-capture-${sanitize(field.className)}`
      if (!patchIds.has(patchId)) {
        patchIds.add(patchId)
        result.patches.push({
          kind: 'patch',
          mode: 'capture',
          id: patchId,
          name: `Capture: ${field.className}.${hook.method.name} instance`,
          originalBytes: hook.originalBytes,
          length: hook.length,
          signature: hook.signature,
          signatureOffset: 0,
          moduleName: ops.moduleName,
          moduleOffset: hook.rva,
          baseRegister: 'rcx',
          internal: true
        })
      }

      // A multi category takes every matching field on the same class.
      const targetFields = cat.multi
        ? ranked.filter((f) => f.classPtr === field.classPtr && f.dataType === field.dataType)
        : [field]
      const targets = targetFields.map((f) => ({
        kind: 'anchor' as const,
        patchId,
        offset: '0x' + f.offset.toString(16),
        dataType
      }))

      const cheatId = `factory-${cat.id}`
      result.cheats.push({ id: cheatId, name: cat.label, dataType, mode: cat.mode, targets, value: cat.value })
      if (cat.edit !== undefined) {
        result.cheats.push({
          id: `${cheatId}-edit`,
          name: cat.edit,
          dataType,
          mode: 'oneshot',
          targets,
          value: cat.value
        })
      }
      result.checklist.push({
        id: cheatId,
        name: cat.label,
        className: field.className,
        fieldName: field.fieldName,
        offset: field.offset,
        dataType,
        hook: `${field.className}.${hook.method.name}`,
        verified: verification.state === 'verified',
        liveValue: verification.state === 'verified' ? verification.value : null,
        instanceCount: verification.instanceCount,
        multiInstanceRisk: !(verification.state === 'verified' && verification.lowRisk),
        lookFor: cat.lookFor,
        alternates: ranked.filter((f) => !targetFields.includes(f)).map((f) => `${f.className}.${f.fieldName}`)
      })
      done = true
      break
    }

    if (!done) {
      result.unresolved.push({
        category: id,
        reason: unhookable
          ? 'no method on the owning class could be hooked safely (already detoured, rip-relative prologue, or no unique signature)'
          : implausible
            ? 'every candidate read an implausible live value through the singleton, so the field or type is wrong'
            : 'no candidate resolved'
      })
    }
  }
  return result
}

import type { DataType } from '../cheatVerify'
import { categoryById, type Category } from './categories'
import { rankFields } from './ranker'
import type { Il2cppEnumeration, Il2cppField, Il2cppMethod, Il2cppRoot } from './il2cppEnumerator'
import type { HookSite } from './hookSite'
import { leU64, toHex } from './il2cppLayout'

// Orchestration for IL2CPP: category -> ranked field -> (optional) live
// verification through a singleton -> hook site -> capture patch + anchor
// cheat. Everything native is behind BuildOps so this is unit-testable.

export interface BuildOps {
  moduleName: string
  readBytes(address: string, length: number): string | null
  chooseHook(methods: Il2cppMethod[]): Promise<HookSite | null>
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

type Verification =
  | { state: 'verified'; value: number }
  | { state: 'implausible'; value: number }
  | { state: 'unverified' }

function verifyThroughRoot(field: Il2cppField, roots: Il2cppRoot[], ops: BuildOps, cat: Category): Verification {
  const dataType = field.dataType as DataType
  for (const root of roots) {
    if (!classChainIncludes(ops, root.instanceClassPtr, field.classPtr)) continue
    const hex = ops.readBytes(toHex(BigInt(root.instancePtr) + BigInt(field.offset)), VALUE_BYTES[dataType])
    if (hex === null) continue
    const value = decodeValue(hex, dataType)
    const [lo, hi] = cat.plausible
    return Number.isFinite(value) && value >= lo && value <= hi ? { state: 'verified', value } : { state: 'implausible', value }
  }
  return { state: 'unverified' }
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
  const methodsByClass = new Map(enumeration.classes.map((c) => [c.classPtr, c.methods]))

  const hookFor = async (classPtr: string): Promise<HookSite | null> => {
    if (!hookCache.has(classPtr)) hookCache.set(classPtr, await ops.chooseHook(methodsByClass.get(classPtr) ?? []))
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
      const verification = verifyThroughRoot(field, enumeration.roots, ops, cat)
      if (verification.state === 'implausible') {
        implausible = true
        continue
      }
      const hook = await hookFor(field.classPtr)
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

      const cheatId = `factory-${cat.id}`
      result.cheats.push({
        id: cheatId,
        name: cat.label,
        dataType,
        mode: cat.mode,
        targets: [{ kind: 'anchor', patchId, offset: '0x' + field.offset.toString(16), dataType }],
        value: cat.value
      })
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
        multiInstanceRisk: verification.state !== 'verified',
        lookFor: cat.lookFor,
        alternates: ranked.filter((f) => f !== field).map((f) => `${f.className}.${f.fieldName}`)
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

// Direct port of mcp-server/src/ueReflect.ts's pure decode/walk functions --
// kept as a separate, self-contained copy rather than a cross-package
// import for the same reason monoTargetResolve.ts's relationship to
// mcp-server's mono tools already established: mcp-server and this app are
// independent packages with no shared-lib precedent between them. See
// docs/superpowers/specs/2026-09-17-ue-reflection-decode-design.md for why
// the GNames/GUObjectArray config below is a required input, never
// discovered by this module itself.
import type { UeTarget } from './store'
import type { UeConfig } from './profile'

export type ReadBytes = (address: string, length: number) => string | null

export interface FName {
  comparisonIndex: number
  number: number
}

export interface PropertyEntry {
  fieldAddress: string
  name: FName
  offsetInternal: number
}

const OFFSET_CLASS_PRIVATE = 0x10
const OFFSET_NAME_PRIVATE = 0x18
const OFFSET_OUTER_PRIVATE = 0x20
const OFFSET_USTRUCT_CHILD_PROPERTIES = 0x50

// FField/FProperty member offsets differ by engine version: UE 5.1 (Palworld) keeps a 16-byte
// FFieldVariant owner, later builds (Subnautica 2, 5.6) pack it into 8 bytes, shifting Next, Name
// and Offset_Internal down. Discovery probes which one a game uses (see ueDiscover.ts).
export interface FieldLayout {
  next: number
  name: number
  offsetInternal: number
}
export const FIELD_LAYOUTS: Record<NonNullable<UeConfig['fieldLayout']>, FieldLayout> = {
  legacy: { next: 0x20, name: 0x28, offsetInternal: 0x4c },
  compact: { next: 0x18, name: 0x20, offsetInternal: 0x44 }
}
export function fieldLayoutFor(config: UeConfig): FieldLayout {
  return FIELD_LAYOUTS[config.fieldLayout ?? 'legacy']
}

// Matches every other unbounded-walk primitive in this codebase -- a
// corrupt/misconfigured chain must not loop forever.
const MAX_PROPERTY_CHAIN_LENGTH = 4096

function addHex(address: string, delta: number): string {
  return '0x' + (BigInt(address) + BigInt(delta)).toString(16)
}

function readUInt64LE(hex: string): bigint {
  return Buffer.from(hex, 'hex').readBigUInt64LE(0)
}

function readPointer(readBytes: ReadBytes, address: string): string | null {
  const hex = readBytes(address, 8)
  if (hex === null) return null
  const value = readUInt64LE(hex)
  if (value === 0n) return null
  return '0x' + value.toString(16)
}

function readFName(readBytes: ReadBytes, address: string): FName | null {
  const hex = readBytes(address, 8)
  if (hex === null) return null
  const buf = Buffer.from(hex, 'hex')
  return { comparisonIndex: buf.readInt32LE(0), number: buf.readInt32LE(4) }
}

// Formula ported from Encryqed/Dumper-7's NameArray.cpp (the bUseNamePool
// branch's ByIndex + FNameEntry::Init decode).
export function decodeFName(
  readBytes: ReadBytes,
  poolConfig: UeConfig['gNames'],
  comparisonIndex: number
): string | null {
  const { gNamesBase, blockOffsetBits, nameEntryStride, stringOffset, headerOffset, lengthShiftCount } = poolConfig

  const chunkIdx = comparisonIndex >> blockOffsetBits
  const inChunkOffset = (comparisonIndex & ((1 << blockOffsetBits) - 1)) * nameEntryStride
  const blockPtrAddress = addHex(gNamesBase, 0x10 + chunkIdx * 8)

  const blockBase = readPointer(readBytes, blockPtrAddress)
  if (blockBase === null) return null

  const entryAddress = addHex(blockBase, inChunkOffset)
  const headerHex = readBytes(addHex(entryAddress, headerOffset), 2)
  if (headerHex === null) return null
  const header = Buffer.from(headerHex, 'hex').readUInt16LE(0)

  const nameLen = header >> lengthShiftCount
  if (nameLen === 0) return null // numbered-name fallback, not handled this phase

  const isWide = (header & 1) === 1
  const stringAddress = addHex(entryAddress, stringOffset)
  if (isWide) {
    const hex = readBytes(stringAddress, nameLen * 2)
    if (hex === null) return null
    return Buffer.from(hex, 'hex').toString('utf16le')
  }
  const hex = readBytes(stringAddress, nameLen)
  if (hex === null) return null
  return Buffer.from(hex, 'hex').toString('utf8')
}

// Walks a UStruct/UClass's ChildProperties -> FField.Next chain, collecting
// each node's raw (undecoded) FName and Offset_Internal.
export function walkProperties(
  readBytes: ReadBytes,
  classAddress: string,
  layout: FieldLayout = FIELD_LAYOUTS.legacy
): PropertyEntry[] {
  const entries: PropertyEntry[] = []
  let current = readPointer(readBytes, addHex(classAddress, OFFSET_USTRUCT_CHILD_PROPERTIES))

  for (let i = 0; i < MAX_PROPERTY_CHAIN_LENGTH && current !== null; i++) {
    const name = readFName(readBytes, addHex(current, layout.name))
    const offsetHex = readBytes(addHex(current, layout.offsetInternal), 4)
    if (name === null || offsetHex === null) break
    const offsetInternal = Buffer.from(offsetHex, 'hex').readInt32LE(0)
    entries.push({ fieldAddress: current, name, offsetInternal })
    current = readPointer(readBytes, addHex(current, layout.next))
  }

  return entries
}

export function resolveFieldOffset(
  readBytes: ReadBytes,
  poolConfig: UeConfig['gNames'],
  classAddress: string,
  fieldName: string,
  layout: FieldLayout = FIELD_LAYOUTS.legacy
): { offset: number } | null {
  for (const entry of walkProperties(readBytes, classAddress, layout)) {
    const decoded = decodeFName(readBytes, poolConfig, entry.name.comparisonIndex)
    if (decoded === fieldName) return { offset: entry.offsetInternal }
  }
  return null
}

// Walks GUObjectArray for the first object named `className` whose own
// class decodes to "Class". maxObjectsToScan is required, not defaulted --
// a misconfigured arrayConfig makes it easy to loop over garbage memory for
// a long time, and that's a caller decision.
export function resolveClassAddress(
  readBytes: ReadBytes,
  arrayConfig: UeConfig['gObjectArray'],
  poolConfig: UeConfig['gNames'],
  className: string,
  maxObjectsToScan: number
): string | null {
  const { chunksArrayBase, numElementsPerChunk, itemStride, itemInitialOffset } = arrayConfig

  for (let index = 0; index < maxObjectsToScan; index++) {
    const chunkIdx = Math.floor(index / numElementsPerChunk)
    const inChunkIdx = index % numElementsPerChunk

    const blockPtrAddress = addHex(chunksArrayBase, chunkIdx * 8)
    const blockBase = readPointer(readBytes, blockPtrAddress)
    if (blockBase === null) continue

    const itemAddress = addHex(blockBase, inChunkIdx * itemStride)
    const objectAddress = readPointer(readBytes, addHex(itemAddress, itemInitialOffset))
    if (objectAddress === null) continue

    const name = readFName(readBytes, addHex(objectAddress, OFFSET_NAME_PRIVATE))
    if (name === null) continue
    const decodedName = decodeFName(readBytes, poolConfig, name.comparisonIndex)
    if (decodedName !== className) continue

    const classPrivate = readPointer(readBytes, addHex(objectAddress, OFFSET_CLASS_PRIVATE))
    if (classPrivate === null) continue
    const classOfClassName = readFName(readBytes, addHex(classPrivate, OFFSET_NAME_PRIVATE))
    if (classOfClassName === null) continue
    const decodedClassOfClassName = decodeFName(readBytes, poolConfig, classOfClassName.comparisonIndex)
    if (decodedClassOfClassName === 'Class') return objectAddress
  }

  return null
}

// Resolves a UeTarget to a live address: find the class, find the field's
// byte offset, add it to the instance pointer a capture-mode patch already
// supplied (see store.ts's UeTarget doc for why reflection alone can't
// reach an instance on its own). Every failure mode returns null rather
// than throwing, matching every other resolver in this codebase.
export function resolveUeTargetAddress(
  target: UeTarget,
  config: UeConfig,
  instancePointer: string,
  readBytes: ReadBytes
): string | null {
  const classAddress = resolveClassAddress(
    readBytes,
    config.gObjectArray,
    config.gNames,
    target.className,
    target.maxObjectsToScan
  )
  if (classAddress === null) return null

  const field = resolveFieldOffset(readBytes, config.gNames, classAddress, target.fieldName, fieldLayoutFor(config))
  if (field === null) return null

  return addHex(instancePointer, field.offset + (target.valueOffset ?? 0))
}

const OFFSET_USTRUCT_SUPER_STRUCT = 0x40
const MAX_SUPER_DEPTH = 64
const CDO_PREFIX = 'Default__'
export const PATH_OUTER = '^Outer'

// Like resolveFieldOffset, but keeps walking SuperStruct: members such as
// CharacterMovement live on a parent class (ACharacter), not the game's own.
export function resolveInheritedFieldOffset(
  readBytes: ReadBytes,
  poolConfig: UeConfig['gNames'],
  classAddress: string,
  fieldName: string,
  layout: FieldLayout = FIELD_LAYOUTS.legacy
): { offset: number } | null {
  let current: string | null = classAddress
  for (let depth = 0; depth < MAX_SUPER_DEPTH && current !== null; depth++) {
    const found = resolveFieldOffset(readBytes, poolConfig, current, fieldName, layout)
    if (found !== null) return found
    current = readPointer(readBytes, addHex(current, OFFSET_USTRUCT_SUPER_STRUCT))
  }
  return null
}

// Every object in GUObjectArray as [address, class pointer]. Items are read in slices (one read per ~170 objects, the addon
// caps a read at 4096 bytes); the class pointer costs one more read per object, so a full pass is seconds on a big game.
export type ObjectTable = { at: number; entries: [string, string][] }

function* objectStream(
  readBytes: ReadBytes,
  arrayConfig: UeConfig['gObjectArray'],
  maxObjectsToScan: number
): Generator<[string, string]> {
  const { chunksArrayBase, numElementsPerChunk, itemStride, itemInitialOffset } = arrayConfig
  const sliceItems = Math.max(1, Math.floor(4000 / itemStride))
  for (let start = 0; start < maxObjectsToScan; start += sliceItems) {
    const blockBase = readPointer(readBytes, addHex(chunksArrayBase, Math.floor(start / numElementsPerChunk) * 8))
    if (blockBase === null) {
      start = (Math.floor(start / numElementsPerChunk) + 1) * numElementsPerChunk - sliceItems
      continue
    }
    const inChunk = start % numElementsPerChunk
    const count = Math.min(sliceItems, numElementsPerChunk - inChunk, maxObjectsToScan - start)
    const raw = readBytes(addHex(blockBase, inChunk * itemStride), count * itemStride)
    if (raw === null) continue
    const buf = Buffer.from(raw, 'hex')
    for (let i = 0; i < count; i++) {
      const objectPtr = buf.readBigUInt64LE(i * itemStride + itemInitialOffset)
      if (objectPtr === 0n) continue
      const objectAddress = '0x' + objectPtr.toString(16)
      const classPrivate = readPointer(readBytes, addHex(objectAddress, OFFSET_CLASS_PRIVATE))
      if (classPrivate === null) continue
      yield [objectAddress, classPrivate]
    }
  }
}

export function buildObjectTable(
  readBytes: ReadBytes,
  arrayConfig: UeConfig['gObjectArray'],
  maxObjectsToScan: number,
  now: number = Date.now()
): ObjectTable {
  return { at: now, entries: Array.from(objectStream(readBytes, arrayConfig, maxObjectsToScan)) }
}

// First live instance of `classAddress`: an object whose ClassPrivate is that
// class or a subclass of it (a running game's player is usually a Blueprint
// subclass of the C++ class), and whose name is not the class default object
// ("Default__X"). Class pointers repeat heavily, so derivation is memoized.
export function findInstanceOfClass(
  readBytes: ReadBytes,
  arrayConfig: UeConfig['gObjectArray'],
  poolConfig: UeConfig['gNames'],
  classAddress: string,
  maxObjectsToScan: number,
  outerClassAddress?: string
): string | null {
  return findInstancesOfClass(readBytes, arrayConfig, poolConfig, classAddress, maxObjectsToScan, outerClassAddress, 1)[0] ?? null
}

// Every live instance (same rules as findInstanceOfClass), up to `limit`.
export function findInstancesOfClass(
  readBytes: ReadBytes,
  arrayConfig: UeConfig['gObjectArray'],
  poolConfig: UeConfig['gNames'],
  classAddress: string,
  maxObjectsToScan: number,
  outerClassAddress: string | undefined,
  limit: number,
  table?: ObjectTable
): string[] {
  const found: string[] = []
  const classObjectMemo = new Map<string, boolean>()
  const derivesFrom = (target: string): ((cls: string) => boolean) => {
    const want = BigInt(target)
    const derives = new Map<bigint, boolean>()
    return (cls) => {
      const key = BigInt(cls)
      const known = derives.get(key)
      if (known !== undefined) return known
      let found = false
      let current: string | null = cls
      for (let depth = 0; depth < MAX_SUPER_DEPTH && current !== null; depth++) {
        if (BigInt(current) === want) {
          found = true
          break
        }
        current = readPointer(readBytes, addHex(current, OFFSET_USTRUCT_SUPER_STRUCT))
      }
      derives.set(key, found)
      return found
    }
  }
  const isDerived = derivesFrom(classAddress)
  const isOuterDerived = outerClassAddress === undefined ? null : derivesFrom(outerClassAddress)
  for (const [objectAddress, classPrivate] of table?.entries ?? objectStream(readBytes, arrayConfig, maxObjectsToScan)) {
    if (!isDerived(classPrivate)) continue
    const name = readFName(readBytes, addHex(objectAddress, OFFSET_NAME_PRIVATE))
    const decoded = name === null ? null : decodeFName(readBytes, poolConfig, name.comparisonIndex)
    if (decoded === null || decoded.startsWith(CDO_PREFIX)) continue
    // A component template inside a class default object ("Default__X" is its Outer) is not a live instance.
    const outer = readPointer(readBytes, addHex(objectAddress, OFFSET_OUTER_PRIVATE))
    const outerName = outer === null ? null : readFName(readBytes, addHex(outer, OFFSET_NAME_PRIVATE))
    const outerDecoded = outerName === null ? null : decodeFName(readBytes, poolConfig, outerName.comparisonIndex)
    if (outerDecoded !== null && outerDecoded.startsWith(CDO_PREFIX)) continue
    // Likewise a component template owned by a Blueprint class (its Outer is a BlueprintGeneratedClass, a UClass).
    const outerClassPtr = outer === null ? null : readPointer(readBytes, addHex(outer, OFFSET_CLASS_PRIVATE))
    if (outerClassPtr !== null) {
      let isClassObject = classObjectMemo.get(outerClassPtr)
      if (isClassObject === undefined) {
        const n = readFName(readBytes, addHex(outerClassPtr, OFFSET_NAME_PRIVATE))
        const decodedClass = n === null ? null : decodeFName(readBytes, poolConfig, n.comparisonIndex)
        isClassObject = decodedClass !== null && decodedClass.endsWith('Class')
        classObjectMemo.set(outerClassPtr, isClassObject)
      }
      if (isClassObject) continue
    }
    if (isOuterDerived !== null) {
      // Components and attribute sets are owned by an actor (their Outer): pick the one owned by the wanted actor class.
      const outerClass = outer === null ? null : readPointer(readBytes, addHex(outer, OFFSET_CLASS_PRIVATE))
      if (outerClass === null || !isOuterDerived(outerClass)) continue
    }
    found.push(objectAddress)
    if (found.length >= limit) return found
  }
  return found
}

// Two caches: rootClass -> live instance (the GUObjectArray walk costs seconds), and
// target key -> its resolved address plus the pointer links it was reached through
// (walking the field names costs hundreds of reads, and runs every freeze tick).
export interface UeInstanceCache {
  roots: Map<string, string>
  targets: Map<string, { links: { at: string; value: string }[]; final: string }>
  // All-instance lists per root key: one GUObjectArray walk serves every target on that root.
  instances: Map<string, { at: number; objects: string[] }>
  // One object-array pass shared by every all-instances target (the pass, not the filtering, is the cost).
  table?: ObjectTable
  // Addresses per all-instances target, valid for the instance list (by its timestamp) they were built from.
  multi: Map<string, { listAt: number; addresses: string[] }>
}

export function createUeInstanceCache(): UeInstanceCache {
  return { roots: new Map(), targets: new Map(), instances: new Map(), multi: new Map() }
}

// A data asset set is loaded once and rarely changes; a walk costs about a second on the main thread.
const INSTANCE_LIST_TTL_MS = 180_000
const INSTANCE_LIST_EMPTY_TTL_MS = 15_000
// A target with nothing live yet (no vehicle spawned) retries from the shared table, and rebuilds the table this often.
const TABLE_EMPTY_RETRY_MS = 45_000
const MAX_MULTI_INSTANCES = 4096

// Root-instance cache key: the same class owned by a different actor class is a different instance.
export const ueRootKey = (t: UeTarget): string =>
  t.rootOuterClass === undefined ? `${t.rootClass}` : `${t.rootClass}@${t.rootOuterClass}`

const targetKey = (t: UeTarget): string =>
  `${ueRootKey(t)}/${(t.path ?? []).join('.')}/${t.fieldName}${t.valueOffset === undefined ? '' : `+${t.valueOffset}`}`

// Resolves a root-path UeTarget: instance of rootClass, follow each `path`
// pointer field by reflected name, then add the last field's offset. A hit on
// the target cache costs one read per link: each pointer must still hold the
// value it had, and the root must still be alive (its class pointer readable).
export function resolveUeRootTargetAddress(
  target: UeTarget,
  config: UeConfig,
  readBytes: ReadBytes,
  cache: UeInstanceCache
): string | null {
  if (target.rootClass === undefined) return null
  const classOf = (object: string): string | null => readPointer(readBytes, addHex(object, OFFSET_CLASS_PRIVATE))

  const layout = fieldLayoutFor(config)
  const key = targetKey(target)
  const hit = cache.targets.get(key)
  if (hit !== undefined) {
    if (hit.links.every((link) => readPointer(readBytes, link.at) === link.value)) return hit.final
    cache.targets.delete(key)
  }

  let root = cache.roots.get(ueRootKey(target)) ?? null
  if (root !== null) {
    const rootClassAddress = classOf(root)
    const name = rootClassAddress === null ? null : readFName(readBytes, addHex(rootClassAddress, OFFSET_NAME_PRIVATE))
    const decoded = name === null ? null : decodeFName(readBytes, config.gNames, name.comparisonIndex)
    // The instance may be of a Blueprint subclass, so only its liveness is checked here.
    if (rootClassAddress === null || decoded === null) {
      cache.roots.delete(ueRootKey(target))
      root = null
    }
  }
  if (root === null) {
    const rootClassAddress = resolveClassAddress(readBytes, config.gObjectArray, config.gNames, target.rootClass, target.maxObjectsToScan)
    if (rootClassAddress === null) return null
    let outerClassAddress: string | undefined
    if (target.rootOuterClass !== undefined) {
      const outer = resolveClassAddress(readBytes, config.gObjectArray, config.gNames, target.rootOuterClass, target.maxObjectsToScan)
      if (outer === null) return null
      outerClassAddress = outer
    }
    root = findInstanceOfClass(readBytes, config.gObjectArray, config.gNames, rootClassAddress, target.maxObjectsToScan, outerClassAddress)
    if (root === null) return null
    cache.roots.set(ueRootKey(target), root)
  }

  const links: { at: string; value: string }[] = [
    { at: addHex(root, OFFSET_CLASS_PRIVATE), value: classOf(root) ?? '' }
  ]
  let object = root
  for (const step of target.path ?? []) {
    const cls = classOf(object)
    if (cls === null) return null
    // '^Outer' follows UObject::OuterPrivate (not a reflected field): an actor's outer is its Level.
    const fieldOffset = step === PATH_OUTER ? OFFSET_OUTER_PRIVATE : resolveInheritedFieldOffset(readBytes, config.gNames, cls, step, layout)?.offset
    if (fieldOffset === undefined) return null
    const at = addHex(object, fieldOffset)
    const next = readPointer(readBytes, at)
    if (next === null) return null
    links.push({ at, value: next })
    object = next
  }

  const cls = classOf(object)
  if (cls === null) return null
  const last = resolveInheritedFieldOffset(readBytes, config.gNames, cls, target.fieldName, layout)
  if (last === null) return null
  const final = addHex(object, last.offset + (target.valueOffset ?? 0))
  links.push({ at: addHex(object, OFFSET_CLASS_PRIVATE), value: cls })
  cache.targets.set(key, { links, final })
  return final
}

// Every address an all-instances target covers: each live instance of rootClass (optionally owned by
// rootOuterClass), through `path`, plus the field's offset. Empty when nothing resolves. The instance list is cached
// (see INSTANCE_LIST_TTL_MS); the field offset is looked up once per distinct class.
export function resolveUeMultiTargetAddresses(
  target: UeTarget,
  config: UeConfig,
  readBytes: ReadBytes,
  cache: UeInstanceCache,
  now: number = Date.now()
): string[] {
  if (target.rootClass === undefined) return []
  const layout = fieldLayoutFor(config)
  const key = ueRootKey(target)
  let entry = cache.instances.get(key)
  const emptyRetry = entry !== undefined && entry.objects.length === 0
  const stale = entry === undefined || now - entry.at > (emptyRetry ? INSTANCE_LIST_EMPTY_TTL_MS : INSTANCE_LIST_TTL_MS)
  if (stale) {
    // One pass over GUObjectArray serves every target on every root until it ages out.
    if (cache.table === undefined || now - cache.table.at > (emptyRetry ? TABLE_EMPTY_RETRY_MS : INSTANCE_LIST_TTL_MS)) {
      cache.table = buildObjectTable(readBytes, config.gObjectArray, target.maxObjectsToScan, now)
    }
    let objects: string[] = []
    const rootClassAddress = resolveClassAddress(readBytes, config.gObjectArray, config.gNames, target.rootClass, target.maxObjectsToScan)
    const outerClassAddress =
      target.rootOuterClass === undefined
        ? undefined
        : resolveClassAddress(readBytes, config.gObjectArray, config.gNames, target.rootOuterClass, target.maxObjectsToScan) ?? null
    if (rootClassAddress !== null && outerClassAddress !== null) {
      objects = findInstancesOfClass(
        readBytes,
        config.gObjectArray,
        config.gNames,
        rootClassAddress,
        target.maxObjectsToScan,
        outerClassAddress,
        MAX_MULTI_INSTANCES,
        cache.table
      )
    }
    entry = { at: now, objects }
    cache.instances.set(key, entry)
  }
  if (entry === undefined) return []

  const memoKey = targetKey(target)
  const memo = cache.multi.get(memoKey)
  if (memo !== undefined && memo.listAt === entry.at) return memo.addresses

  const offsets = new Map<string, number | null>()
  const offsetFor = (cls: string, field: string): number | null => {
    const memo = `${cls}/${field}`
    const known = offsets.get(memo)
    if (known !== undefined) return known
    const found = resolveInheritedFieldOffset(readBytes, config.gNames, cls, field, layout)
    offsets.set(memo, found === null ? null : found.offset)
    return found === null ? null : found.offset
  }

  const addresses: string[] = []
  for (const root of entry.objects) {
    let object: string | null = root
    for (const step of target.path ?? []) {
      const cls: string | null = object === null ? null : readPointer(readBytes, addHex(object, OFFSET_CLASS_PRIVATE))
      if (object === null || cls === null) {
        object = null
        break
      }
      const stepOffset: number | null = step === PATH_OUTER ? OFFSET_OUTER_PRIVATE : offsetFor(cls, step)
      object = stepOffset === null ? null : readPointer(readBytes, addHex(object, stepOffset))
    }
    if (object === null) continue
    const cls = readPointer(readBytes, addHex(object, OFFSET_CLASS_PRIVATE))
    if (cls === null) continue
    const offset = offsetFor(cls, target.fieldName)
    if (offset === null) continue
    addresses.push(addHex(object, offset + (target.valueOffset ?? 0)))
  }
  cache.multi.set(memoKey, { listAt: entry.at, addresses })
  return addresses
}

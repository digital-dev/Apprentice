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
const OFFSET_FFIELD_NEXT = 0x20
const OFFSET_FFIELD_NAME_PRIVATE = 0x28
const OFFSET_FPROPERTY_OFFSET_INTERNAL = 0x4c
const OFFSET_USTRUCT_CHILD_PROPERTIES = 0x50

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
export function walkProperties(readBytes: ReadBytes, classAddress: string): PropertyEntry[] {
  const entries: PropertyEntry[] = []
  let current = readPointer(readBytes, addHex(classAddress, OFFSET_USTRUCT_CHILD_PROPERTIES))

  for (let i = 0; i < MAX_PROPERTY_CHAIN_LENGTH && current !== null; i++) {
    const name = readFName(readBytes, addHex(current, OFFSET_FFIELD_NAME_PRIVATE))
    const offsetHex = readBytes(addHex(current, OFFSET_FPROPERTY_OFFSET_INTERNAL), 4)
    if (name === null || offsetHex === null) break
    const offsetInternal = Buffer.from(offsetHex, 'hex').readInt32LE(0)
    entries.push({ fieldAddress: current, name, offsetInternal })
    current = readPointer(readBytes, addHex(current, OFFSET_FFIELD_NEXT))
  }

  return entries
}

export function resolveFieldOffset(
  readBytes: ReadBytes,
  poolConfig: UeConfig['gNames'],
  classAddress: string,
  fieldName: string
): { offset: number } | null {
  for (const entry of walkProperties(readBytes, classAddress)) {
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

  const field = resolveFieldOffset(readBytes, config.gNames, classAddress, target.fieldName)
  if (field === null) return null

  return addHex(instancePointer, field.offset)
}

const OFFSET_USTRUCT_SUPER_STRUCT = 0x40
const MAX_SUPER_DEPTH = 64
const CDO_PREFIX = 'Default__'

// Like resolveFieldOffset, but keeps walking SuperStruct: members such as
// CharacterMovement live on a parent class (ACharacter), not the game's own.
export function resolveInheritedFieldOffset(
  readBytes: ReadBytes,
  poolConfig: UeConfig['gNames'],
  classAddress: string,
  fieldName: string
): { offset: number } | null {
  let current: string | null = classAddress
  for (let depth = 0; depth < MAX_SUPER_DEPTH && current !== null; depth++) {
    const found = resolveFieldOffset(readBytes, poolConfig, current, fieldName)
    if (found !== null) return found
    current = readPointer(readBytes, addHex(current, OFFSET_USTRUCT_SUPER_STRUCT))
  }
  return null
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
  maxObjectsToScan: number
): string | null {
  const { chunksArrayBase, numElementsPerChunk, itemStride, itemInitialOffset } = arrayConfig
  const want = BigInt(classAddress)
  const derives = new Map<bigint, boolean>()
  const isDerived = (cls: string): boolean => {
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
  // Items are read in slices (one read per ~170 objects, the addon caps a read at 4096 bytes)
  // and only an object whose class matches costs further reads.
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
      if (classPrivate === null || !isDerived(classPrivate)) continue
      const name = readFName(readBytes, addHex(objectAddress, OFFSET_NAME_PRIVATE))
      const decoded = name === null ? null : decodeFName(readBytes, poolConfig, name.comparisonIndex)
      if (decoded === null || decoded.startsWith(CDO_PREFIX)) continue
      return objectAddress
    }
  }
  return null
}

// Two caches: rootClass -> live instance (the GUObjectArray walk costs seconds), and
// target key -> its resolved address plus the pointer links it was reached through
// (walking the field names costs hundreds of reads, and runs every freeze tick).
export interface UeInstanceCache {
  roots: Map<string, string>
  targets: Map<string, { links: { at: string; value: string }[]; final: string }>
}

export function createUeInstanceCache(): UeInstanceCache {
  return { roots: new Map(), targets: new Map() }
}

const targetKey = (t: UeTarget): string => `${t.rootClass}/${(t.path ?? []).join('.')}/${t.fieldName}`

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

  const key = targetKey(target)
  const hit = cache.targets.get(key)
  if (hit !== undefined) {
    if (hit.links.every((link) => readPointer(readBytes, link.at) === link.value)) return hit.final
    cache.targets.delete(key)
  }

  let root = cache.roots.get(target.rootClass) ?? null
  if (root !== null) {
    const rootClassAddress = classOf(root)
    const name = rootClassAddress === null ? null : readFName(readBytes, addHex(rootClassAddress, OFFSET_NAME_PRIVATE))
    const decoded = name === null ? null : decodeFName(readBytes, config.gNames, name.comparisonIndex)
    // The instance may be of a Blueprint subclass, so only its liveness is checked here.
    if (rootClassAddress === null || decoded === null) {
      cache.roots.delete(target.rootClass)
      root = null
    }
  }
  if (root === null) {
    const rootClassAddress = resolveClassAddress(readBytes, config.gObjectArray, config.gNames, target.rootClass, target.maxObjectsToScan)
    if (rootClassAddress === null) return null
    root = findInstanceOfClass(readBytes, config.gObjectArray, config.gNames, rootClassAddress, target.maxObjectsToScan)
    if (root === null) return null
    cache.roots.set(target.rootClass, root)
  }

  const links: { at: string; value: string }[] = [
    { at: addHex(root, OFFSET_CLASS_PRIVATE), value: classOf(root) ?? '' }
  ]
  let object = root
  for (const step of target.path ?? []) {
    const cls = classOf(object)
    if (cls === null) return null
    const field = resolveInheritedFieldOffset(readBytes, config.gNames, cls, step)
    if (field === null) return null
    const at = addHex(object, field.offset)
    const next = readPointer(readBytes, at)
    if (next === null) return null
    links.push({ at, value: next })
    object = next
  }

  const cls = classOf(object)
  if (cls === null) return null
  const last = resolveInheritedFieldOffset(readBytes, config.gNames, cls, target.fieldName)
  if (last === null) return null
  const final = addHex(object, last.offset)
  links.push({ at: addHex(object, OFFSET_CLASS_PRIVATE), value: cls })
  cache.targets.set(key, { links, final })
  return final
}

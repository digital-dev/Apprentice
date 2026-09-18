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

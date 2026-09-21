// Finds a UE game's GNames pool and GUObjectArray from code, so no address is
// stored in a profile (see docs/superpowers/specs/2026-09-20-ue-autodiscovery-design.md).
// Read-only: it only scans the main module and reads memory.
import type { UeConfig } from './profile'
import { decodeFName, resolveClassAddress, walkProperties, FIELD_LAYOUTS, type ReadBytes } from './ueTargetResolve'

export interface UeDiscoverDeps {
  readBytes: ReadBytes
  // Signature scan bounded to the game's main module.
  scanAob: (signature: string) => Promise<string[]>
}

// FName pool init guard: lea reg,[pool]; jmp; lea rcx,[pool]; call ctor; mov byte [guard],1
const GNAMES_SIGNATURE = '48 8D 05 ?? ?? ?? ?? EB ?? 48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? C6 05 ?? ?? ?? ?? 01'
// Chunked object array lookup: mov rax,[GObjects.Objects]; mov rcx,[rax+rcx*8]; lea rax,[rcx+rdx*8*3]
const GOBJECTS_SIGNATURE = '48 8B 05 ?? ?? ?? ?? 48 8B 0C C8 48 8D 04 D1'

const MAX_CANDIDATES = 24
const MAX_OBJECTS_TO_VALIDATE = 200_000

function hex(value: bigint): string {
  return '0x' + value.toString(16)
}

// The rip-relative target of the instruction at `at`: rel32 sits `rel32At` bytes in.
function ripTarget(readBytes: ReadBytes, at: string, rel32At: number, instrLen: number): bigint | null {
  const raw = readBytes(hex(BigInt(at) + BigInt(rel32At)), 4)
  if (raw === null) return null
  return BigInt(at) + BigInt(instrLen) + BigInt(Buffer.from(raw, 'hex').readInt32LE(0))
}

const NAME_LAYOUTS: UeConfig['gNames'][] = []
for (const blockOffsetBits of [16, 14])
  for (const nameEntryStride of [2, 4])
    for (const stringOffset of [2, 6])
      for (const lengthShiftCount of [6, 1])
        NAME_LAYOUTS.push({ gNamesBase: '', blockOffsetBits, nameEntryStride, stringOffset, headerOffset: 0, lengthShiftCount })

// A pool is accepted only when index 0 decodes to "None" and the engine's first
// registered property type follows within the first few indexes (its index is
// the entry's byte offset over the stride, so 1 to 3 in practice), which wrong
// layouts do not produce.
export function probeNamePool(readBytes: ReadBytes, base: string): UeConfig['gNames'] | null {
  for (const layout of NAME_LAYOUTS) {
    const config = { ...layout, gNamesBase: base }
    try {
      if (decodeFName(readBytes, config, 0) !== 'None') continue
      for (let index = 1; index <= 8; index++) if (decodeFName(readBytes, config, index) === 'ByteProperty') return config
    } catch {
      // a bad layout can read past a block: try the next
    }
  }
  return null
}

// Picks the FField layout for this engine build: the one under which a well-known class (AActor, many
// properties) walks to a run of names that all decode to identifiers. A wrong layout reads garbage
// pointers and stops early or decodes junk.
export function probeFieldLayout(
  readBytes: ReadBytes,
  gObjectArray: UeConfig['gObjectArray'],
  gNames: UeConfig['gNames']
): NonNullable<UeConfig['fieldLayout']> | null {
  const actor = resolveClassAddress(readBytes, gObjectArray, gNames, 'Actor', MAX_OBJECTS_TO_VALIDATE)
  if (actor === null) return null
  for (const name of ['legacy', 'compact'] as const) {
    const entries = walkProperties(readBytes, actor, FIELD_LAYOUTS[name])
    if (entries.length < 8) continue
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/
    if (entries.every((e) => identifier.test(decodeFName(readBytes, gNames, e.name.comparisonIndex) ?? ''))) return name
  }
  return null
}

export async function discoverUeConfig(deps: UeDiscoverDeps): Promise<UeConfig | null> {
  const { readBytes, scanAob } = deps

  let gNames: UeConfig['gNames'] | null = null
  for (const hit of (await scanAob(GNAMES_SIGNATURE)).slice(0, MAX_CANDIDATES)) {
    const target = ripTarget(readBytes, hit, 3, 7)
    if (target === null) continue
    gNames = probeNamePool(readBytes, hex(target))
    if (gNames !== null) break
  }
  if (gNames === null) return null

  for (const hit of (await scanAob(GOBJECTS_SIGNATURE)).slice(0, MAX_CANDIDATES)) {
    const global = ripTarget(readBytes, hit, 3, 7)
    if (global === null) continue
    const pointer = readBytes(hex(global), 8)
    if (pointer === null) continue
    const chunksArrayBase = hex(Buffer.from(pointer, 'hex').readBigUInt64LE(0))
    if (BigInt(chunksArrayBase) === 0n) continue
    for (const itemStride of [24, 16]) {
      const gObjectArray = { chunksArrayBase, numElementsPerChunk: 65536, itemStride, itemInitialOffset: 0 }
      if (resolveClassAddress(readBytes, gObjectArray, gNames, 'Object', MAX_OBJECTS_TO_VALIDATE) !== null) {
        const fieldLayout = probeFieldLayout(readBytes, gObjectArray, gNames)
        return fieldLayout === null ? { gNames, gObjectArray } : { gNames, gObjectArray, fieldLayout }
      }
    }
  }
  return null
}

import type { ChainTarget, DataType } from '../cheatVerify'
import { categoryById } from './categories'
import type { NativeGame, NativeRoot } from './nativeGames'

export interface NativeOps {
  scanAob(signature: string): Promise<string[]>
  readBytes(address: string, length: number): string | null
  // Same chain form Tamper and verify_cheat use: start at `base` (the module
  // base) and walk `offsets`, the first being the static slot's RVA. Null when unreadable.
  readValue(base: string, offsets: string[], dataType: DataType): number | null
}

export interface NativeModule {
  name: string
  base: string
  size: number
}

export interface NativeDraft {
  id: string
  name: string
  dataType: DataType
  mode: 'freeze' | 'oneshot'
  targets: ChainTarget[]
  value: number
  offValue?: number
}

export interface NativeChecklistItem {
  id: string
  name: string
  dataType: DataType
  liveValues: number[]
  lookFor: string
}

export interface NativeResult {
  drafts: NativeDraft[]
  checklist: NativeChecklistItem[]
  manual: { category: string; note: string }[]
  // Not in this game's table.
  notFound: string[]
  // In the table, but no plausible live value (not in a save yet, or a stale chain).
  unresolved: string[]
  roots: { id: string; rva: string }[]
}

const hex = (n: bigint): string => '0x' + n.toString(16)

export type RootResolution = { ok: true; address: bigint } | { ok: false; reason: string }

// Resolves `mov reg,[rip+rel32]` to the address of the static pointer it loads.
export async function resolveRoot(root: NativeRoot, ops: NativeOps, module: NativeModule): Promise<RootResolution> {
  const matches = await ops.scanAob(root.signature)
  if (matches.length !== 1) return { ok: false, reason: `${root.id}: signature matched ${matches.length} places, need exactly 1` }
  const at = BigInt(matches[0])
  const operand = ops.readBytes(hex(at + BigInt(root.rel32At)), 4)
  if (operand === null) return { ok: false, reason: `${root.id}: could not read the rel32 operand` }
  const address = at + BigInt(root.instrLen) + BigInt(Buffer.from(operand, 'hex').readInt32LE(0))
  const start = BigInt(module.base)
  if (address < start || address >= start + BigInt(module.size)) {
    return { ok: false, reason: `${root.id}: resolved outside ${module.name}` }
  }
  return { ok: true, address }
}

export async function buildNativeFactory(
  wishlist: string[],
  game: NativeGame,
  ops: NativeOps,
  module: NativeModule
): Promise<NativeResult> {
  const result: NativeResult = { drafts: [], checklist: [], manual: [], notFound: [], unresolved: [], roots: [] }
  const roots = new Map<string, bigint>()
  const failures: string[] = []
  for (const root of game.roots) {
    const resolved = await resolveRoot(root, ops, module)
    if (resolved.ok) {
      roots.set(root.id, resolved.address)
      result.roots.push({ id: root.id, rva: hex(resolved.address - BigInt(module.base)) })
    } else {
      failures.push(resolved.reason)
    }
  }

  for (const id of wishlist) {
    const category = categoryById(id)
    if (category?.manualReview !== undefined) {
      result.manual.push({ category: id, note: category.manualReview })
      continue
    }
    const cheat = game.cheats.find((c) => c.category === id)
    if (cheat === undefined) {
      result.notFound.push(id)
      continue
    }
    const rootAddress = roots.get(cheat.root)
    const rootRva = rootAddress === undefined ? '' : hex(rootAddress - BigInt(module.base))
    const values: number[] = []
    let plausible = rootAddress !== undefined
    if (rootAddress !== undefined) {
      for (const chain of cheat.chains) {
        const value = ops.readValue(module.base, [rootRva, ...chain], cheat.dataType)
        if (value === null || !Number.isFinite(value) || value < cheat.plausible[0] || value > cheat.plausible[1]) {
          plausible = false
          break
        }
        values.push(value)
      }
    }
    if (!plausible || rootAddress === undefined) {
      result.unresolved.push(id)
      continue
    }

    const label = category?.label ?? id
    const draftId = `factory-${id}`
    const baseOffset = rootRva
    result.drafts.push({
      id: draftId,
      name: label,
      dataType: cheat.dataType,
      mode: cheat.mode,
      targets: cheat.chains.map((offsets) => ({ moduleName: module.name, baseOffset, offsets })),
      value: cheat.value,
      ...(cheat.offValue !== undefined ? { offValue: cheat.offValue } : {})
    })
    result.checklist.push({ id: draftId, name: label, dataType: cheat.dataType, liveValues: values, lookFor: cheat.lookFor })
  }

  if (failures.length > 0) result.unresolved.push(...failures.map((f) => `root: ${f}`))
  return result
}

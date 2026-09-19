import type { CheatDefinition, DataType, MonoTarget, TargetStatus } from '../cheatVerify'
import { categoryById } from './categories'
import { rankFields } from './ranker'
import type { Enumeration } from './monoEnumerator'

export type DraftCheat = CheatDefinition & { mode: 'freeze' | 'oneshot'; offValue?: number }

export interface ChecklistItem {
  id: string
  name: string
  target: MonoTarget
  dataType: DataType
  liveValue: number
  lookFor: string
  alternates: string[]
}

export interface FactoryResult {
  drafts: DraftCheat[]
  checklist: ChecklistItem[]
  // Landmine categories: reported with the reason, never drafted.
  manual: { category: string; note: string }[]
  // Unknown category, or no field name matched.
  notFound: string[]
  // Fields matched but nothing resolved to a plausible live value.
  unresolved: string[]
}

export type VerifyFn = (target: MonoTarget, dataType: DataType, cheatValue: number) => Promise<TargetStatus>

export async function buildFactory(
  wishlist: string[],
  enumeration: Enumeration,
  verify: VerifyFn
): Promise<FactoryResult> {
  const result: FactoryResult = { drafts: [], checklist: [], manual: [], notFound: [], unresolved: [] }

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
    const ranked = rankFields(cat, enumeration.fields)
    if (ranked.length === 0) {
      result.notFound.push(id)
      continue
    }

    let accepted: { field: (typeof ranked)[number]; target: MonoTarget; dataType: DataType; value: number } | null = null
    search: for (const field of ranked) {
      for (const dataType of cat.dataTypes) {
        for (const root of enumeration.roots) {
          const target: MonoTarget = {
            kind: 'mono',
            className: root.className,
            staticFieldName: root.staticFieldName,
            instanceFieldName: field.fieldName,
            ...(field.className !== root.className ? { instanceClassName: field.className } : {})
          }
          const status = await verify(target, dataType, cat.value)
          if (!status.alive || status.value === null) continue
          const [lo, hi] = cat.plausible
          if (!Number.isFinite(status.value) || status.value < lo || status.value > hi) continue
          accepted = { field, target, dataType, value: status.value }
          break search
        }
      }
    }

    if (accepted === null) {
      result.unresolved.push(id)
      continue
    }

    const draftId = `factory-${cat.id}`
    result.drafts.push({
      id: draftId,
      name: cat.label,
      dataType: accepted.dataType,
      mode: cat.mode,
      targets: [accepted.target],
      value: cat.value,
      ...(cat.offValue !== undefined ? { offValue: cat.offValue } : {})
    })
    result.checklist.push({
      id: draftId,
      name: cat.label,
      target: accepted.target,
      dataType: accepted.dataType,
      liveValue: accepted.value,
      lookFor: cat.lookFor,
      alternates: ranked.filter((f) => f !== accepted!.field).map((f) => `${f.className}.${f.fieldName}`)
    })
  }
  return result
}

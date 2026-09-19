import type { Category } from './categories'

export interface FieldCandidate {
  className: string
  fieldName: string
}

export interface ScoredField extends FieldCandidate {
  score: number
}

export const MIN_SCORE = 10

// Variants of a stat that are not the stat itself. Freezing the current
// value high is enough; chasing max/regen fields is a dead end (SKILL.md).
// (No bare "min": it is a substring of "stamina".)
const NOT_THE_STAT = /max|regen|rate|mult|timer|delay|cooldown|percent|ratio|color|text|label|bar|hud|default|drain|cost/i

function stripPrefix(fieldName: string): string {
  return fieldName.replace(/^(m_|_)+/, '')
}

export function scoreField(cat: Category, f: FieldCandidate): number {
  const name = stripPrefix(f.fieldName)
  if (!cat.nameHints.some((h) => h.test(name))) return 0
  let score = 10
  if (NOT_THE_STAT.test(name)) score -= 8
  if (cat.classHints.some((h) => h.test(f.className))) score += 3
  return score
}

// Array.prototype.sort is stable, so equal scores keep input order.
// Generic so callers' extra fields (offset, data type, ...) survive ranking.
export function rankFields<T extends FieldCandidate>(cat: Category, fields: T[], topN = 3): (T & { score: number })[] {
  return fields
    .map((f) => ({ ...f, score: scoreField(cat, f) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}

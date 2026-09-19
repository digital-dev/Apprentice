import type { DataType } from '../cheatVerify'

// Executable form of the category -> recipe lookup in
// .claude/skills/authoring-tamper-cheats/SKILL.md. `manualReview` marks a
// category whose naive mechanism is a known trap there (decay loses the
// race against the game's tick; zeroing a rate stalls the system): the
// factory reports it and never drafts it.
export interface Category {
  id: string
  label: string
  // Tested against the field name with any leading `m_`/`_` stripped.
  nameHints: RegExp[]
  // Tested against the declaring class name; a match adds a score bonus and
  // decides which classes the enumerator lists fields for.
  classHints: RegExp[]
  // Preferred first; the rest are tried in order if the live read is implausible.
  dataTypes: DataType[]
  mode: 'freeze' | 'oneshot'
  value: number
  // Sane range for the live read. Anything outside means wrong type/field.
  plausible: [number, number]
  lookFor: string
  manualReview?: string
}

const ACTOR = [/player/i, /character/i, /humanoid/i, /hero/i, /entity/i, /unit/i, /actor/i]

export const CATEGORIES: Category[] = [
  {
    id: 'health',
    label: 'Infinite Health',
    nameHints: [/health/i, /^hp$/i, /hitpoint/i],
    classHints: ACTOR,
    dataTypes: ['float', 'int32'],
    mode: 'freeze',
    value: 1000,
    plausible: [1, 100000],
    lookFor: 'Take damage: the health bar stays full.'
  },
  {
    id: 'stamina',
    label: 'Infinite Stamina',
    nameHints: [/stamina/i, /endurance/i],
    classHints: ACTOR,
    dataTypes: ['float', 'int32'],
    mode: 'freeze',
    value: 999,
    plausible: [0, 100000],
    lookFor: 'Sprint or attack repeatedly: the stamina bar never drains.'
  },
  {
    id: 'mana',
    label: 'Infinite Mana',
    nameHints: [/mana/i, /eitr/i, /^mp$/i, /magicpoint/i],
    classHints: ACTOR,
    dataTypes: ['float', 'int32'],
    mode: 'freeze',
    value: 999,
    plausible: [0, 100000],
    lookFor: 'Cast repeatedly: the mana bar never drains.'
  },
  {
    id: 'money',
    label: 'Unlimited Money',
    nameHints: [/money/i, /cash/i, /gold/i, /coin/i, /credit/i, /currency/i, /balance/i],
    classHints: [...ACTOR, /inventory/i, /wallet/i, /economy/i, /money/i, /currency/i, /profile/i],
    dataTypes: ['int32', 'float', 'int64'],
    mode: 'freeze',
    value: 999999,
    plausible: [0, 1000000000],
    lookFor: 'The on-screen money reads 999999; buy something and it stays.'
  },
  {
    id: 'godmode',
    label: 'God Mode',
    nameHints: [/god(mode)?/i, /invincib/i, /immortal/i, /invulnerab/i],
    classHints: ACTOR,
    dataTypes: ['int8'],
    mode: 'freeze',
    value: 1,
    plausible: [0, 1],
    lookFor: 'Take damage: none is applied.'
  },
  {
    id: 'hunger',
    label: 'Never Hungry',
    nameHints: [/hunger/i, /thirst/i, /food/i, /fatigue/i],
    classHints: ACTOR,
    dataTypes: ['float'],
    mode: 'oneshot',
    value: 0,
    plausible: [0, 100000],
    lookFor: '',
    manualReview:
      'Continuously decaying stat: a freeze loses the race against the game tick. Find the decay-enable flag and write it once (recipe B) by hand.'
  },
  {
    id: 'speed',
    label: 'Movement Speed',
    nameHints: [/speed/i],
    classHints: ACTOR,
    dataTypes: ['float'],
    mode: 'freeze',
    value: 0,
    plausible: [0, 1000],
    lookFor: '',
    manualReview:
      'Rate/multiplier field: zeroing can stall the very system it should speed up. Needs a live differential test by hand before writing anything.'
  }
]

export function categoryById(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id)
}

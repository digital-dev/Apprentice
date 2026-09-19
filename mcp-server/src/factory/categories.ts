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
  // Take every matching field on the winning class as a target of one cheat
  // (e.g. several curfew flags that must all be cleared).
  multi?: boolean
  // Also emit a one-shot "Edit ..." cheat on the same targets, for setting
  // an exact value from the UI instead of freezing.
  edit?: string
  // Written once when the cheat is turned OFF. Needed when the game never
  // puts the field back itself, so a frozen value would otherwise stay for
  // good (a frozen time multiplier of 0 keeps the clock stopped after the
  // toggle is switched off). Left unset where keeping the value is the point
  // (money, health). Must be a known default: a wrong one is worse than none.
  offValue?: number
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
    id: 'bank',
    label: 'Unlimited Bank Balance',
    nameHints: [/onlinebalance/i, /bank/i],
    classHints: [/money/i, /bank/i, /atm/i, /economy/i],
    dataTypes: ['float', 'int32'],
    mode: 'freeze',
    value: 999999999,
    plausible: [0, 1000000000000],
    lookFor: 'The bank/online balance reads the frozen amount; spend some and it refills.',
    edit: 'Edit Bank Balance'
  },
  {
    id: 'cash',
    label: 'Unlimited Cash',
    nameHints: [/balance/i, /cash/i],
    classHints: [/cash/i, /wallet/i],
    dataTypes: ['float', 'int32'],
    mode: 'freeze',
    value: 999999,
    plausible: [0, 1000000000],
    lookFor: 'The cash in hand reads the frozen amount; buy something and it refills.',
    edit: 'Edit Cash'
  },
  {
    id: 'water',
    label: 'Unlimited Water',
    nameHints: [/fillamount/i, /waterlevel/i, /^water$/i, /watercontent/i],
    classHints: [/watercontainer/i, /wateringcan/i, /water/i],
    dataTypes: ['float', 'int32'],
    mode: 'freeze',
    value: 999,
    plausible: [0, 100000],
    lookFor: 'Water plants repeatedly: the can never empties. (If the can looks overfull, lower the frozen value.)'
  },
  {
    id: 'curfew',
    label: 'No Curfew',
    nameHints: [/isenabled/i, /iscurrentlyactive/i, /ishardcurfewactive/i, /curfewactive/i],
    classHints: [/curfew/i],
    dataTypes: ['int8'],
    mode: 'freeze',
    value: 0,
    plausible: [0, 1],
    multi: true,
    lookFor: 'Stay out past curfew: no warning, no police response.'
  },
  {
    id: 'freezetime',
    label: 'Freeze Daytime',
    nameHints: [/timespeedmultiplier/i, /timescale/i],
    classHints: [/timemanager/i, /gametime/i, /clock/i],
    dataTypes: ['float'],
    mode: 'freeze',
    value: 0,
    offValue: 1,
    plausible: [0, 100],
    lookFor: 'The in-game clock stops. Toggle off to resume; sleeping may misbehave while frozen.'
  },
  {
    id: 'runspeed',
    label: 'Run Speed Multiplier',
    nameHints: [/sprintmultiplier/i, /runspeed/i],
    classHints: [/movement/i, /controller/i],
    dataTypes: ['float'],
    mode: 'freeze',
    value: 3,
    offValue: 1,
    plausible: [0.01, 100],
    lookFor:
      'Sprint: noticeably faster. This field may be recomputed every frame; if it does nothing, it needs a method patch instead.'
  },
  {
    id: 'nosearch',
    label: 'No Body Search',
    nameHints: [/bodysearchpending/i, /searchpending/i],
    classHints: [/crime/i, /police/i, /search/i],
    dataTypes: ['int8'],
    mode: 'freeze',
    value: 0,
    plausible: [0, 1],
    lookFor: 'Get stopped by police: no body search is triggered.'
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

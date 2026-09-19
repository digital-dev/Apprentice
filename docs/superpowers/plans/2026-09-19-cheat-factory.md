# Cheat Factory (`author_cheats`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One MCP tool, `author_cheats`, that turns a wishlist of cheat categories into pre-verified draft profile entries plus a single in-game checklist, for Unity/Mono games.

**Architecture:** Pure, engine-neutral modules (category table, ranker, emitter/orchestrator) with dependency-injected native ops, plus one Mono enumerator adapter and one thin MCP tool. All logic is unit-tested with fakes, so no live game is needed until the final validation task.

**Tech Stack:** TypeScript, vitest (root `vitest.config.ts`), zod, `@modelcontextprotocol/sdk` 1.22.0 (pinned; do not bump), existing `mcp-server/src/addon.ts` primitives.

**Spec:** `docs/superpowers/specs/2026-09-19-cheat-factory-design.md` (read its "Amendments" section: it overrides the body).

## Global Constraints

- MCP server never writes game memory. The only write is the draft file `<profile>.draft.json`.
- Mono only. Non-Mono engines return an error naming the playbook from `fingerprint_process`.
- Only namespace-less classes are targetable (`resolveMonoTargetAddress` passes `''` as namespace).
- Do not edit the live profile; drafts are promoted by hand after the in-game pass.
- Commit messages: no `Co-Authored-By` or `Claude-Session` trailers (repo rule, see `no-claude-attribution-apprentice` memory).
- Run tests from the repo root: `npx vitest run mcp-server/tests/<file>`.
- New code lives in `mcp-server/src/factory/`; match the existing style (no semicolons, single quotes, 2-space indent).

## File Structure

- Create `mcp-server/src/factory/categories.ts`: category table (data + `categoryById`).
- Create `mcp-server/src/factory/ranker.ts`: `scoreField`, `rankFields`, `MIN_SCORE`.
- Create `mcp-server/src/factory/monoEnumerator.ts`: `enumerateMono` over injected `MonoEnumOps`.
- Create `mcp-server/src/factory/build.ts`: `buildFactory` orchestration, draft/checklist types.
- Create `mcp-server/src/tools/author.ts`: `registerAuthorTools`, the `author_cheats` tool.
- Modify `mcp-server/src/tools/verify.ts`: export `monoOpsFor`.
- Modify `mcp-server/src/server.ts`: register the new tool.
- Create tests `mcp-server/tests/factoryRanker.test.ts`, `factoryEnumerator.test.ts`, `factoryBuild.test.ts`.
- Modify `.claude/skills/authoring-tamper-cheats/SKILL.md` and `mcp-server/README.md`: document the workflow.

---

### Task 1: Category table and ranker

**Files:**
- Create: `mcp-server/src/factory/categories.ts`
- Create: `mcp-server/src/factory/ranker.ts`
- Test: `mcp-server/tests/factoryRanker.test.ts`

**Interfaces:**
- Produces (`categories.ts`):
  ```ts
  export interface Category {
    id: string
    label: string
    nameHints: RegExp[]
    classHints: RegExp[]
    dataTypes: DataType[]
    mode: 'freeze' | 'oneshot'
    value: number
    plausible: [number, number]
    lookFor: string
    manualReview?: string
  }
  export const CATEGORIES: Category[]
  export function categoryById(id: string): Category | undefined
  ```
- Produces (`ranker.ts`):
  ```ts
  export interface FieldCandidate { className: string; fieldName: string }
  export interface ScoredField extends FieldCandidate { score: number }
  export const MIN_SCORE = 10
  export function scoreField(cat: Category, f: FieldCandidate): number
  export function rankFields(cat: Category, fields: FieldCandidate[], topN?: number): ScoredField[]
  ```

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/factoryRanker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { categoryById } from '../src/factory/categories'
import { rankFields, scoreField, type FieldCandidate } from '../src/factory/ranker'

// Field names taken from games/valheim.json's hand-authored cheats.
const valheim: FieldCandidate[] = [
  { className: 'Player', fieldName: 'm_localPlayer' },
  { className: 'Player', fieldName: 'm_godMode' },
  { className: 'Player', fieldName: 'm_stamina' },
  { className: 'Player', fieldName: 'm_staminaRegenTimer' },
  { className: 'Player', fieldName: 'm_eitr' },
  { className: 'Character', fieldName: 'm_health' },
  { className: 'Character', fieldName: 'm_maxHealth' },
  { className: 'Character', fieldName: 'm_healthRegen' },
  { className: 'Character', fieldName: 'm_runSpeed' }
]

function names(id: string): string[] {
  const cat = categoryById(id)!
  return rankFields(cat, valheim).map((s) => `${s.className}.${s.fieldName}`)
}

describe('rankFields', () => {
  it('finds the current-health field and rejects max/regen variants', () => {
    expect(names('health')).toEqual(['Character.m_health'])
  })
  it('finds stamina and rejects the regen timer', () => {
    expect(names('stamina')).toEqual(['Player.m_stamina'])
  })
  it('finds the god-mode flag', () => {
    expect(names('godmode')).toEqual(['Player.m_godMode'])
  })
  it('finds eitr as mana', () => {
    expect(names('mana')).toEqual(['Player.m_eitr'])
  })
  it('returns nothing when no field matches (money in Valheim fields)', () => {
    expect(names('money')).toEqual([])
  })
  it('keeps input order for equal scores and honours topN', () => {
    const cat = categoryById('health')!
    const fields: FieldCandidate[] = [
      { className: 'Character', fieldName: 'm_hp' },
      { className: 'Character', fieldName: 'm_health' },
      { className: 'Character', fieldName: 'm_currentHealth' }
    ]
    expect(rankFields(cat, fields, 2).map((s) => s.fieldName)).toEqual(['m_hp', 'm_health'])
  })
})

describe('scoreField', () => {
  it('gives a class-hint bonus', () => {
    const cat = categoryById('health')!
    const inHint = scoreField(cat, { className: 'Character', fieldName: 'm_health' })
    const outOfHint = scoreField(cat, { className: 'Zzz', fieldName: 'm_health' })
    expect(inHint).toBeGreaterThan(outOfHint)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run mcp-server/tests/factoryRanker.test.ts`
Expected: FAIL, cannot resolve `../src/factory/categories`.

- [ ] **Step 3: Write the category table**

Create `mcp-server/src/factory/categories.ts`:

```ts
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
```

- [ ] **Step 4: Write the ranker**

Create `mcp-server/src/factory/ranker.ts`:

```ts
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
export function rankFields(cat: Category, fields: FieldCandidate[], topN = 3): ScoredField[] {
  return fields
    .map((f) => ({ ...f, score: scoreField(cat, f) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run mcp-server/tests/factoryRanker.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/factory/categories.ts mcp-server/src/factory/ranker.ts mcp-server/tests/factoryRanker.test.ts
git commit -m "feat: add cheat factory category table and field ranker"
```

---

### Task 2: Mono enumerator

**Files:**
- Create: `mcp-server/src/factory/monoEnumerator.ts`
- Test: `mcp-server/tests/factoryEnumerator.test.ts`

**Interfaces:**
- Consumes: `FieldCandidate` from `./ranker`.
- Produces:
  ```ts
  export interface MonoEnumOps {
    listAssemblyNames(): Promise<{ image: string; name: string }[]>
    listClassesInImage(image: string): Promise<{ namespaceName: string; className: string; classHandle: string }[]>
    listFieldNames(classHandle: string): Promise<string[]>
    staticFieldAddress(classHandle: string, fieldName: string): Promise<string | null>
    readBytes(address: string, length: number): string | null
  }
  export interface Root { className: string; staticFieldName: string }
  export interface Enumeration {
    fields: FieldCandidate[]
    roots: Root[]
    deadRoots: Root[]
    classesScanned: number
  }
  export function enumerateMono(ops: MonoEnumOps, classHints: RegExp[]): Promise<Enumeration>
  ```

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/factoryEnumerator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { enumerateMono, type MonoEnumOps } from '../src/factory/monoEnumerator'

const LIVE = '00f0ad0b00000000'
const NULL_PTR = '0000000000000000'

function fakeOps(overrides: Partial<MonoEnumOps> = {}): MonoEnumOps & { staticCalls: string[] } {
  const staticCalls: string[] = []
  const ops: MonoEnumOps = {
    listAssemblyNames: async () => [
      { image: '0x1', name: 'Assembly-CSharp' },
      { image: '0x2', name: 'mscorlib' }
    ],
    listClassesInImage: async (image) =>
      image === '0x1'
        ? [
            { namespaceName: '', className: 'Player', classHandle: '0xa' },
            { namespaceName: '', className: 'Character', classHandle: '0xb' },
            { namespaceName: '', className: 'Boring', classHandle: '0xc' },
            { namespaceName: 'Foo', className: 'PlayerHelper', classHandle: '0xd' }
          ]
        : [{ namespaceName: '', className: 'PlayerFromCorlib', classHandle: '0xe' }],
    listFieldNames: async (h) =>
      h === '0xa' ? ['m_localPlayer', 'm_stamina', 'm_godMode'] : h === '0xb' ? ['m_health'] : [],
    staticFieldAddress: async (h, f) => (h === '0xa' && f === 'm_localPlayer' ? '0x1000' : null),
    readBytes: () => LIVE
  }
  const merged = { ...ops, ...overrides }
  const original = merged.staticFieldAddress
  merged.staticFieldAddress = async (h, f) => {
    staticCalls.push(`${h}.${f}`)
    return original(h, f)
  }
  return Object.assign(merged, { staticCalls })
}

const HINTS = [/player/i, /character/i]

describe('enumerateMono', () => {
  it('lists fields only for hinted, namespace-less classes in the game assembly', async () => {
    const result = await enumerateMono(fakeOps(), HINTS)
    expect(result.classesScanned).toBe(2)
    expect(result.fields).toEqual([
      { className: 'Player', fieldName: 'm_localPlayer' },
      { className: 'Player', fieldName: 'm_stamina' },
      { className: 'Player', fieldName: 'm_godMode' },
      { className: 'Character', fieldName: 'm_health' }
    ])
  })

  it('finds a live static singleton root', async () => {
    const result = await enumerateMono(fakeOps(), HINTS)
    expect(result.roots).toEqual([{ className: 'Player', staticFieldName: 'm_localPlayer' }])
    expect(result.deadRoots).toEqual([])
  })

  it('only probes static storage for singleton-looking names', async () => {
    const ops = fakeOps()
    await enumerateMono(ops, HINTS)
    expect(ops.staticCalls).toEqual(['0xa.m_localPlayer'])
  })

  it('reports a null-pointer root as dead, not live', async () => {
    const result = await enumerateMono(fakeOps({ readBytes: () => NULL_PTR }), HINTS)
    expect(result.roots).toEqual([])
    expect(result.deadRoots).toEqual([{ className: 'Player', staticFieldName: 'm_localPlayer' }])
  })

  it('falls back to non-system assemblies when there is no Assembly-CSharp', async () => {
    const ops = fakeOps({
      listAssemblyNames: async () => [
        { image: '0x2', name: 'mscorlib' },
        { image: '0x1', name: 'GameCode' }
      ]
    })
    const result = await enumerateMono(ops, HINTS)
    expect(result.classesScanned).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run mcp-server/tests/factoryEnumerator.test.ts`
Expected: FAIL, cannot resolve `../src/factory/monoEnumerator`.

- [ ] **Step 3: Write the enumerator**

Create `mcp-server/src/factory/monoEnumerator.ts`:

```ts
import type { FieldCandidate } from './ranker'

// Thin seam over the addon's mono_* primitives so the enumeration logic is
// testable without a live process.
export interface MonoEnumOps {
  listAssemblyNames(): Promise<{ image: string; name: string }[]>
  listClassesInImage(image: string): Promise<{ namespaceName: string; className: string; classHandle: string }[]>
  listFieldNames(classHandle: string): Promise<string[]>
  staticFieldAddress(classHandle: string, fieldName: string): Promise<string | null>
  readBytes(address: string, length: number): string | null
}

export interface Root {
  className: string
  staticFieldName: string
}

export interface Enumeration {
  fields: FieldCandidate[]
  // Static singleton handles whose pointer is non-zero right now.
  roots: Root[]
  // Same shape but the pointer is null (player not in a world yet).
  deadRoots: Root[]
  classesScanned: number
}

const GAME_ASSEMBLY = /^Assembly-CSharp/i
const SYSTEM_ASSEMBLY = /^(mscorlib|System|Unity|Mono\.|netstandard|Newtonsoft)/i
// Names that look like a singleton handle to the live instance.
const ROOT_NAME = /^(m_|_|s_)?(instance|local|localplayer|player|current|main|singleton)$/i
const NULL_POINTER = '0000000000000000'

export async function enumerateMono(ops: MonoEnumOps, classHints: RegExp[]): Promise<Enumeration> {
  const assemblies = await ops.listAssemblyNames()
  const game = assemblies.filter((a) => GAME_ASSEMBLY.test(a.name))
  const images = game.length > 0 ? game : assemblies.filter((a) => !SYSTEM_ASSEMBLY.test(a.name))

  const fields: FieldCandidate[] = []
  const roots: Root[] = []
  const deadRoots: Root[] = []
  let classesScanned = 0

  for (const image of images) {
    const classes = await ops.listClassesInImage(image.image)
    for (const cls of classes) {
      // resolveMonoTargetAddress only resolves with an empty namespace.
      if (cls.namespaceName !== '') continue
      if (!classHints.some((h) => h.test(cls.className))) continue
      classesScanned++
      const names = await ops.listFieldNames(cls.classHandle)
      for (const fieldName of names) {
        fields.push({ className: cls.className, fieldName })
        if (!ROOT_NAME.test(fieldName)) continue
        const address = await ops.staticFieldAddress(cls.classHandle, fieldName)
        if (address === null) continue
        const pointer = ops.readBytes(address, 8)
        if (pointer === null) continue
        const root = { className: cls.className, staticFieldName: fieldName }
        if (pointer === NULL_POINTER) deadRoots.push(root)
        else roots.push(root)
      }
    }
  }
  return { fields, roots, deadRoots, classesScanned }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run mcp-server/tests/factoryEnumerator.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/factory/monoEnumerator.ts mcp-server/tests/factoryEnumerator.test.ts
git commit -m "feat: add Mono field and singleton-root enumerator for the cheat factory"
```

---

### Task 3: Draft builder and checklist

**Files:**
- Create: `mcp-server/src/factory/build.ts`
- Test: `mcp-server/tests/factoryBuild.test.ts`

**Interfaces:**
- Consumes: `Category`, `categoryById` (Task 1); `rankFields`, `FieldCandidate` (Task 1); `Enumeration` (Task 2); `MonoTarget`, `DataType`, `CheatDefinition`, `TargetStatus` from `../cheatVerify`.
- Produces:
  ```ts
  export type DraftCheat = CheatDefinition & { mode: 'freeze' | 'oneshot' }
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
    manual: { category: string; note: string }[]
    notFound: string[]
    unresolved: string[]
  }
  export type VerifyFn = (target: MonoTarget, dataType: DataType, cheatValue: number) => Promise<TargetStatus>
  export function buildFactory(wishlist: string[], enumeration: Enumeration, verify: VerifyFn): Promise<FactoryResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/factoryBuild.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildFactory, type VerifyFn } from '../src/factory/build'
import type { Enumeration } from '../src/factory/monoEnumerator'
import type { TargetStatus } from '../src/cheatVerify'

const enumeration: Enumeration = {
  fields: [
    { className: 'Player', fieldName: 'm_localPlayer' },
    { className: 'Player', fieldName: 'm_stamina' },
    { className: 'Player', fieldName: 'm_godMode' },
    { className: 'Player', fieldName: 'm_hp' },
    { className: 'Character', fieldName: 'm_health' }
  ],
  roots: [{ className: 'Player', staticFieldName: 'm_localPlayer' }],
  deadRoots: [],
  classesScanned: 2
}

const dead: TargetStatus = { supported: true, alive: false, value: null, expected: null, matches: null }
const live = (value: number): TargetStatus => ({ supported: true, alive: true, value, expected: null, matches: null })

// Table of (instanceFieldName, dataType) -> live value; anything else is dead.
function verifyFrom(table: Record<string, number>): VerifyFn {
  return async (target, dataType) => {
    const key = `${target.instanceFieldName}:${dataType}`
    return key in table ? live(table[key]) : dead
  }
}

describe('buildFactory', () => {
  it('drafts each resolvable category and sets instanceClassName only for base-class fields', async () => {
    const verify = verifyFrom({ 'm_health:float': 25, 'm_stamina:float': 100, 'm_godMode:int8': 0 })
    const r = await buildFactory(['health', 'stamina', 'godmode'], enumeration, verify)
    expect(r.drafts.map((d) => d.id)).toEqual(['factory-health', 'factory-stamina', 'factory-godmode'])
    expect(r.drafts[0].targets[0]).toEqual({
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_health',
      instanceClassName: 'Character'
    })
    expect(r.drafts[1].targets[0]).toEqual({
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_stamina'
    })
    expect(r.drafts[0]).toMatchObject({ dataType: 'float', mode: 'freeze', value: 1000, name: 'Infinite Health' })
    expect(r.checklist).toHaveLength(3)
    expect(r.checklist[0]).toMatchObject({ id: 'factory-health', liveValue: 25 })
  })

  it('falls back to the next data type when the first read is dead', async () => {
    const verify = verifyFrom({ 'm_health:int32': 25 })
    const r = await buildFactory(['health'], enumeration, verify)
    expect(r.drafts[0].dataType).toBe('int32')
  })

  it('rejects an implausible live value and lists the category as unresolved', async () => {
    const verify = verifyFrom({ 'm_health:float': 1e12, 'm_hp:float': 1e12 })
    const r = await buildFactory(['health'], enumeration, verify)
    expect(r.drafts).toEqual([])
    expect(r.unresolved).toEqual(['health'])
  })

  it('tries the next ranked field and reports the other as an alternate', async () => {
    // m_hp ranks first (input order) but is dead; m_health resolves.
    const verify = verifyFrom({ 'm_health:float': 25 })
    const r = await buildFactory(['health'], enumeration, verify)
    expect(r.drafts[0].targets[0]).toMatchObject({ instanceFieldName: 'm_health' })
    expect(r.checklist[0].alternates).toEqual(['Player.m_hp'])
  })

  it('reports landmine categories as manual with no draft', async () => {
    const r = await buildFactory(['hunger', 'speed'], enumeration, verifyFrom({}))
    expect(r.drafts).toEqual([])
    expect(r.manual.map((m) => m.category)).toEqual(['hunger', 'speed'])
    expect(r.manual[0].note).toMatch(/decay/i)
  })

  it('reports no-match and unknown categories as notFound', async () => {
    const r = await buildFactory(['money', 'bogus'], enumeration, verifyFrom({}))
    expect(r.notFound).toEqual(['money', 'bogus'])
  })

  it('marks every ranked category unresolved when there is no live root', async () => {
    const r = await buildFactory(['health'], { ...enumeration, roots: [] }, verifyFrom({ 'm_health:float': 25 }))
    expect(r.unresolved).toEqual(['health'])
    expect(r.drafts).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run mcp-server/tests/factoryBuild.test.ts`
Expected: FAIL, cannot resolve `../src/factory/build`.

- [ ] **Step 3: Write the builder**

Create `mcp-server/src/factory/build.ts`:

```ts
import type { CheatDefinition, DataType, MonoTarget, TargetStatus } from '../cheatVerify'
import { categoryById } from './categories'
import { rankFields } from './ranker'
import type { Enumeration } from './monoEnumerator'

export type DraftCheat = CheatDefinition & { mode: 'freeze' | 'oneshot' }

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
      value: cat.value
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run mcp-server/tests/factoryBuild.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/factory/build.ts mcp-server/tests/factoryBuild.test.ts
git commit -m "feat: add cheat factory draft builder with plausibility-checked resolution"
```

---

### Task 4: `author_cheats` MCP tool

**Files:**
- Create: `mcp-server/src/tools/author.ts`
- Modify: `mcp-server/src/tools/verify.ts:42` (export `monoOpsFor`)
- Modify: `mcp-server/src/server.ts` (register)

**Interfaces:**
- Consumes: `enumerateMono`, `MonoEnumOps` (Task 2); `buildFactory`, `VerifyFn` (Task 3); `CATEGORIES` (Task 1); `monoOpsFor` from `./verify`; `classifyEngine` from `../engineFingerprint`; `resolveMonoTargetAddress`, `buildTargetStatus` from `../cheatVerify`.
- Produces: MCP tool `author_cheats { handle: number, wishlist: string[], profilePath: string, monoDllBase?: string }`.

- [ ] **Step 1: Export `monoOpsFor`**

In `mcp-server/src/tools/verify.ts` change line 42 from `function monoOpsFor(handle: number): MonoResolveOps {` to:

```ts
export function monoOpsFor(handle: number): MonoResolveOps {
```

- [ ] **Step 2: Write the tool**

Create `mcp-server/src/tools/author.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { classifyEngine } from '../engineFingerprint'
import { resolveMonoTargetAddress, buildTargetStatus } from '../cheatVerify'
import { CATEGORIES } from '../factory/categories'
import { enumerateMono, type MonoEnumOps } from '../factory/monoEnumerator'
import { buildFactory, type VerifyFn } from '../factory/build'
import { monoOpsFor } from './verify'

function enumOpsFor(handle: number, monoDllBase: string): MonoEnumOps {
  return {
    listAssemblyNames: () => addon.monoListAssemblyNames(handle, monoDllBase),
    listClassesInImage: (image) => addon.monoListClassesInImage(handle, monoDllBase, image),
    listFieldNames: (classHandle) => addon.monoListFieldNames(handle, monoDllBase, classHandle),
    staticFieldAddress: (classHandle, field) => addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, field),
    readBytes: (address, length) => addon.tryReadBytes(handle, address, length)
  }
}

function draftPathFor(profilePath: string): string {
  return profilePath.replace(/\.json$/i, '') + '.draft.json'
}

function exeFor(profilePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as { exe?: string }
    if (typeof parsed.exe === 'string') return parsed.exe
  } catch {
    // no readable profile yet -- fall through to the filename
  }
  return path.basename(profilePath).replace(/\.json$/i, '')
}

export function registerAuthorTools(server: McpServer): void {
  server.registerTool(
    'author_cheats',
    {
      description:
        `Unity/Mono only. Turn a wishlist of cheat categories (${CATEGORIES.map((c) => c.id).join(', ')}) into draft, read-verified value cheats: enumerates Mono classes/fields, ranks them by name against each category, finds the live singleton root (e.g. Player.m_localPlayer -- the player must be in a world), tries each candidate through the real pointer chain, and keeps the first whose live value is plausible. Writes drafts to <profile>.draft.json (never the live profile, never game memory) and returns a checklist to confirm in-game. Landmine categories (hunger, speed) come back under "manual" with the reason and no draft.`,
      inputSchema: {
        handle: z.number().int(),
        wishlist: z.array(z.string()).min(1),
        profilePath: z.string(),
        monoDllBase: z.string().optional()
      }
    },
    async (args: { handle: number; wishlist: string[]; profilePath: string; monoDllBase?: string }) => {
      const classification = classifyEngine(addon.listModules(args.handle))
      let monoDllBase = args.monoDllBase ?? null
      if (monoDllBase === null) {
        if (classification.engine !== 'unity-mono') {
          return err(
            `author_cheats supports Unity/Mono only (detected: ${classification.engine}). Run fingerprint_process for that engine's playbook.`
          )
        }
        monoDllBase = classification.monoDllBase
      }

      const wanted = args.wishlist.map((id) => CATEGORIES.find((c) => c.id === id)).filter((c) => c !== undefined)
      const classHints = wanted.flatMap((c) => c!.classHints)
      const enumeration = await enumerateMono(enumOpsFor(args.handle, monoDllBase), classHints)

      if (enumeration.roots.length === 0) {
        const dead = enumeration.deadRoots.map((r) => `${r.className}.${r.staticFieldName}`)
        return err(
          dead.length > 0
            ? `found singleton handle(s) ${dead.join(', ')} but they are null -- load into a save/world first, then retry`
            : `no singleton handle found on ${enumeration.classesScanned} scanned class(es); this game needs a manual root (see the authoring-tamper-cheats skill)`
        )
      }

      const handle = args.handle
      const base = monoDllBase
      const verify: VerifyFn = async (target, dataType, cheatValue) => {
        const address = await resolveMonoTargetAddress(target, handle, base, monoOpsFor(handle))
        return buildTargetStatus(
          address,
          (addr) => addon.tryReadValue(handle, addr, [], dataType),
          target,
          cheatValue,
          dataType
        )
      }

      const result = await buildFactory(args.wishlist, enumeration, verify)

      let draftPath: string | null = null
      if (result.drafts.length > 0) {
        draftPath = draftPathFor(args.profilePath)
        fs.writeFileSync(
          draftPath,
          JSON.stringify({ schema: 2, exe: exeFor(args.profilePath), modules: {}, cheats: result.drafts }, null, 2)
        )
      }

      return ok({
        roots: enumeration.roots,
        classesScanned: enumeration.classesScanned,
        draftPath,
        ...result
      })
    }
  )
}
```

- [ ] **Step 3: Register in the server**

In `mcp-server/src/server.ts` add after the `registerUeTools` import:

```ts
import { registerAuthorTools } from './tools/author'
```

and after `registerUeTools(server)`:

```ts
  registerAuthorTools(server)
```

- [ ] **Step 4: Type-check and rebuild**

Run: `npx tsc -p mcp-server/tsconfig.json --noEmit`
Expected: exits 0, no output. If it fails on the `wanted` filter's narrowing, replace that line with:

```ts
const wanted = CATEGORIES.filter((c) => args.wishlist.includes(c.id))
```
and use `wanted.flatMap((c) => c.classHints)`. Then re-run.

- [ ] **Step 5: Run the whole factory suite**

Run: `npx vitest run mcp-server/tests/factoryRanker.test.ts mcp-server/tests/factoryEnumerator.test.ts mcp-server/tests/factoryBuild.test.ts mcp-server/tests/cheatVerify.test.ts`
Expected: PASS, all tests, confirming the `verify.ts` export did not break existing behaviour.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/tools/author.ts mcp-server/src/tools/verify.ts mcp-server/src/server.ts
git commit -m "feat: add author_cheats MCP tool"
```

---

### Task 5: Docs and live Valheim validation

**Files:**
- Modify: `.claude/skills/authoring-tamper-cheats/SKILL.md` (add workflow section after "Overview")
- Modify: `mcp-server/README.md` (add tool entry next to `verify_cheat`)

**Interfaces:** none.

- [ ] **Step 1: Add the workflow to SKILL.md**

Insert after the Overview section, before "Which recipe is this?":

```markdown
## Fast path: `author_cheats` (Unity/Mono)

For a Unity/Mono game, run this first -- it replaces the per-cheat RE loop
for the common categories (health, stamina, mana, money, godmode):

1. `attach`, `fingerprint_process` (must report `unity-mono`).
2. Get the player into a world/save (the singleton root must be non-null).
3. `author_cheats(handle, ["health","stamina","mana","money","godmode"], "games/<exe>.json")`.
4. Read the result: `checklist` (confirm each in-game), `unresolved`
   (fields matched but no plausible live value), `notFound` (no field
   name matched -- fall back to the recipe below), `manual` (hunger/speed:
   landmines, do by hand).
5. Toggle each drafted cheat in Tamper from `games/<exe>.draft.json` and
   check its `lookFor` line. Move confirmed entries into the real profile.

Non-Mono engines get an error naming the playbook; use the recipes below.
```

- [ ] **Step 2: Add the README entry**

In `mcp-server/README.md`, next to the `verify_cheat` entry, add:

```markdown
- `author_cheats` -- Unity/Mono only. Wishlist of categories in, read-verified draft value cheats (`<profile>.draft.json`) plus an in-game checklist out. Writes only the draft file, never game memory or the live profile.
```

- [ ] **Step 3: Rebuild the MCP server so the running tool list includes it**

Run: `cd mcp-server && npm run build`
Expected: exits 0. (Close any process holding `memory_addon.node` first if the build reports a lock; restart the MCP server afterwards so `author_cheats` appears.)

- [ ] **Step 4: Live validation on Valheim (needs the game running, player in a world)**

Attach, then call `author_cheats(handle, ["health","stamina","mana","godmode","money","hunger","speed"], "games/valheim.json")`.
Record in the commit body or a note: which of `health/stamina/mana/godmode` produced the same target as the hand-authored `mono-godmode`, `mono-stamina`, `mono-eitr` entries in `games/valheim.json`; `money` should be `notFound`; `hunger`/`speed` should be `manual`.
Success bar from the spec: the four resolvable categories match the hand-authored targets, in one call. If a category resolves to a different field, read the checklist `alternates` and adjust its `nameHints`/`classHints` in `categories.ts`, re-run the ranker tests, and repeat.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/authoring-tamper-cheats/SKILL.md mcp-server/README.md
git commit -m "docs: document the author_cheats fast path"
```

---

## Self-Review

**Spec coverage:** category table (T1), ranker (T1), Mono enumerator with root probing (T2), emitter + plausibility verify + landmine report-only + alternates + notFound/unresolved (T3), draft-file-only write, engine gate, dead-root error, tool wiring (T4), docs and live Valheim ≥ hand-authored comparison (T5). Amendments (Mono only, no type-fit, namespace-less only, base-class `instanceClassName`) are each implemented in T2/T3/T4. Spec's "UE drafts" is dropped by the amendment and returns the engine error in T4.

**Placeholders:** none; every code step has full code.

**Type consistency:** `FieldCandidate`/`ScoredField`/`MIN_SCORE` (T1) used in T2/T3; `Enumeration` fields (`fields`, `roots`, `deadRoots`, `classesScanned`) match between T2 definition, T3 test fixture, and T4 usage; `VerifyFn(target, dataType, cheatValue)` matches T3 tests and the T4 closure; `MonoEnumOps` method names match between T2 and `enumOpsFor` in T4; `Category` fields used in T3/T4 (`dataTypes`, `plausible`, `mode`, `value`, `label`, `lookFor`, `manualReview`, `classHints`) all exist in T1.

**Known limit:** the class-to-root pairing is verified only by a plausibility read through the real pointer; a wrong pairing that happens to read a plausible number would pass, which is why the in-game checklist is mandatory.

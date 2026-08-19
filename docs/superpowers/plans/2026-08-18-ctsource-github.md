# ctSource.ts GitHub search/fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user search a curated set of open GitHub `.CT`-table repos
by game name, pick a result, and import it through the existing (extended)
`ctImport.ts` pipeline — the actual "download and import cheats easily"
feature this whole project was for.

**Architecture:** A new pure module (`ctSource.ts`) wrapping two
unauthenticated GitHub API calls (repo tree listing, cached per session;
raw file fetch), with an injected `fetch` function for testability. Wired
through a new `ctSource:search`/`ctSource:fetch` IPC pair that mirrors the
existing `ct:import` handler's "pick = confirm, save immediately, return a
summary" convention, and a small search modal in `CheatList.tsx`.

**Tech Stack:** TypeScript (Electron main + renderer), native `fetch`
(Node 18+, available in this Electron version — no new dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-ct-table-import-design.md`
(Component 1: `ctSource.ts`)

**Depends on:** nothing — independent of the other two plans. Benefits
from `docs/superpowers/plans/2026-08-18-ctimport-extensions.md` once it
lands (more of what's found actually imports successfully) but works
correctly without it, importing whatever `ctImport.ts` recognizes at the
time.

## Global Constraints

- Unauthenticated GitHub API only — no PAT/sign-in required for v1.
- A curated, hand-maintained repo list — no crawling/auto-discovery.
- Every failure (offline, rate-limited, malformed response) is a normal
  returned error, never a thrown crash that takes down the renderer — this
  app is otherwise fully offline-capable and this feature must degrade
  cleanly.

---

### Task 1: `ctSource.ts` — search and fetch

**Files:**
- Create: `src/main/ctSource.ts`
- Test: `tests/main/ctSource.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `CtRepo`, `CtSearchResult` types; `searchCtTables(gameName:
  string, fetchImpl?: typeof fetch): Promise<CtSearchResult[]>`;
  `fetchCtTable(result: CtSearchResult, fetchImpl?: typeof fetch):
  Promise<string>`; `clearTreeCache()` (test-only reset of the in-memory
  cache).

- [ ] **Step 1: Write the failing tests**

Create `tests/main/ctSource.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { searchCtTables, fetchCtTable, clearTreeCache, CT_REPOS } from '../../src/main/ctSource'
import type { CtSearchResult } from '../../src/main/ctSource'

function treeResponse(paths: string[]): Response {
  const tree = paths.map((path) => ({ path, type: 'blob' }))
  return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 })
}

describe('searchCtTables', () => {
  beforeEach(() => clearTreeCache())

  it('matches .CT files whose path contains the game name, case-insensitively', async () => {
    let calls = 0
    const fake = async (url: string): Promise<Response> => {
      calls++
      if (url.includes(CT_REPOS[0].repo)) {
        return treeResponse(['Valheim Cheat Table.CT', 'readme.md', 'other-game.ct'])
      }
      return treeResponse([])
    }
    const results = await searchCtTables('valheim', fake as typeof fetch)
    expect(results).toContainEqual({
      repo: `${CT_REPOS[0].owner}/${CT_REPOS[0].repo}`,
      path: 'Valheim Cheat Table.CT',
      name: 'Valheim Cheat Table.CT'
    })
    expect(results.every((r) => r.name.toLowerCase().endsWith('.ct'))).toBe(true)
    expect(calls).toBe(CT_REPOS.length) // one tree fetch per curated repo
  })

  it('aggregates matches across multiple repos', async () => {
    const fake = async (): Promise<Response> => treeResponse(['Elden Ring.CT'])
    const results = await searchCtTables('elden ring', fake as typeof fetch)
    expect(results).toHaveLength(CT_REPOS.length) // every repo "has" a match in this fake
  })

  it('caches a repo tree across repeat searches within the same process', async () => {
    let calls = 0
    const fake = async (): Promise<Response> => {
      calls++
      return treeResponse(['Valheim.CT'])
    }
    await searchCtTables('valheim', fake as typeof fetch)
    const callsAfterFirst = calls
    await searchCtTables('anothergame', fake as typeof fetch)
    expect(calls).toBe(callsAfterFirst) // second search reused the cached trees
  })

  it('treats a failed repo fetch as zero results from that repo, not a thrown error', async () => {
    const fake = async (url: string): Promise<Response> => {
      if (url.includes(CT_REPOS[0].repo)) return new Response('rate limited', { status: 403 })
      return treeResponse(['Valheim.CT'])
    }
    const results = await searchCtTables('valheim', fake as typeof fetch)
    // every repo other than the failing one still contributes
    expect(results.length).toBe(CT_REPOS.length - 1)
  })
})

describe('fetchCtTable', () => {
  it('fetches the raw file content from raw.githubusercontent.com', async () => {
    const result: CtSearchResult = { repo: 'owner/repo', path: 'Valheim.CT', name: 'Valheim.CT' }
    const fake = async (url: string): Promise<Response> => {
      expect(url).toBe('https://raw.githubusercontent.com/owner/repo/main/Valheim.CT')
      return new Response('<CheatTable></CheatTable>', { status: 200 })
    }
    // branch defaults to 'main' when not encoded in the result — see Step 3
    const xml = await fetchCtTable(result, fake as typeof fetch)
    expect(xml).toBe('<CheatTable></CheatTable>')
  })

  it('throws a descriptive error on a failed fetch', async () => {
    const result: CtSearchResult = { repo: 'owner/repo', path: 'Missing.CT', name: 'Missing.CT' }
    const fake = async (): Promise<Response> => new Response('not found', { status: 404 })
    await expect(fetchCtTable(result, fake as typeof fetch)).rejects.toThrow(/404/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/main/ctSource.test.ts`
Expected: FAIL — `src/main/ctSource.ts` does not exist yet.

- [ ] **Step 3: Implement `ctSource.ts`**

Create `src/main/ctSource.ts`:

```ts
// Finds and fetches Cheat Engine .CT tables from a curated set of open
// GitHub repositories. FearlessRevolution/OpenCheatTables (the usual
// CT-table forums) were investigated and rejected as a source: both are
// behind bot-protection that blocks even a plain fetch of their homepage,
// with no official API and unclear scraping terms. GitHub hosts real,
// openly-licensed .CT files with a stable, legitimate, unauthenticated
// API — that's what this module uses.

export interface CtRepo {
  owner: string
  repo: string
  branch: string
}

// Hand-maintained — every entry here has been manually checked to
// actually host .CT files. No auto-discovery/crawling.
export const CT_REPOS: CtRepo[] = [
  { owner: 'themaoci', repo: 'Game-Cheat-Tables-CE-', branch: 'main' },
  { owner: 'The-Grand-Archives', repo: 'Elden-Ring-CT-TGA', branch: 'main' },
  { owner: 'The-Grand-Archives', repo: 'Dark-Souls-III-CT-TGA', branch: 'main' },
  { owner: 'Hexorg', repo: 'CheatEngineTables', branch: 'main' },
  { owner: 'grasmanek94', repo: 'cheat-tables', branch: 'main' },
  { owner: 'bbfox0703', repo: 'Mydev-Cheat-Engine-Tables', branch: 'main' }
]

export interface CtSearchResult {
  repo: string // "owner/repo"
  path: string // full path within the repo
  name: string // basename, for display
  branch?: string // defaults to the repo's configured branch when absent
}

interface TreeEntry {
  path: string
  type: string
}

// One entry per repo, populated on first search and reused for the rest
// of the process's lifetime — a repeat search costs zero extra API calls.
// Exported only for tests (clearTreeCache); not part of the module's
// public surface used by ipc.ts.
const treeCache = new Map<string, TreeEntry[]>()

export function clearTreeCache(): void {
  treeCache.clear()
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

async function fetchRepoTree(repo: CtRepo, fetchImpl: typeof fetch): Promise<TreeEntry[]> {
  const key = `${repo.owner}/${repo.repo}@${repo.branch}`
  const cached = treeCache.get(key)
  if (cached) return cached

  try {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${repo.branch}?recursive=1`
    const res = await fetchImpl(url)
    if (!res.ok) return [] // rate-limited/gone/etc: this repo contributes nothing, not an error
    const body = (await res.json()) as { tree?: TreeEntry[] }
    const entries = Array.isArray(body.tree) ? body.tree : []
    treeCache.set(key, entries)
    return entries
  } catch {
    return [] // offline or a network error: same "contributes nothing" treatment
  }
}

// Searches every curated repo's file tree for a .CT/.ct file whose path
// contains `gameName`, case-insensitively. Never throws — a repo that
// fails to fetch simply contributes no results, so one bad/rate-limited
// repo never breaks the whole search.
export async function searchCtTables(
  gameName: string,
  fetchImpl: typeof fetch = fetch
): Promise<CtSearchResult[]> {
  const needle = gameName.toLowerCase()
  const results: CtSearchResult[] = []
  for (const repo of CT_REPOS) {
    const tree = await fetchRepoTree(repo, fetchImpl)
    for (const entry of tree) {
      if (entry.type !== 'blob') continue
      if (!entry.path.toLowerCase().endsWith('.ct')) continue
      if (!entry.path.toLowerCase().includes(needle)) continue
      results.push({
        repo: `${repo.owner}/${repo.repo}`,
        path: entry.path,
        name: basename(entry.path),
        branch: repo.branch
      })
    }
  }
  return results
}

// Fetches the raw XML content of one search result. Unlike the tree
// listing, raw.githubusercontent.com is not subject to the same rate
// limit as api.github.com, so no caching here.
export async function fetchCtTable(
  result: CtSearchResult,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const branch = result.branch ?? 'main'
  const url = `https://raw.githubusercontent.com/${result.repo}/${branch}/${result.path}`
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch "${result.name}" from GitHub (HTTP ${res.status}).`)
  }
  return res.text()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/main/ctSource.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/ctSource.ts tests/main/ctSource.test.ts
git commit -m "main: add ctSource.ts — GitHub CT table search and fetch"
```

---

### Task 2: IPC, preload, and the search modal

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/tamper.d.ts`
- Modify: `src/renderer/src/screens/CheatList.tsx`

**Interfaces:**
- Consumes: `searchCtTables`, `fetchCtTable`, `CtSearchResult` (Task 1);
  `importCheatTable` (existing, `src/main/ctImport.ts`); `saveCheat`
  (existing, `src/main/store.ts`).
- Produces: IPC channels `ctSource:search`, `ctSource:fetch`; renderer API
  `window.tamper.searchCtTables`/`window.tamper.fetchCtTable`; a "Search
  online (.CT)" button and modal in `CheatList.tsx`.

This task has no dedicated unit test of its own — `CheatList.tsx` has no
existing renderer test harness for any of its screens (the existing
`ct:import`/rename features are verified manually, per this codebase's own
established convention, noted in the spec's Testing section) — verified
here by a full build and manual smoke-check instead.

- [ ] **Step 1: Add the IPC handlers**

In `src/main/ipc.ts`, add near the top-level imports (alongside the
existing `import { importCheatTable } from './ctImport'` at line 22):

```ts
import { searchCtTables, fetchCtTable } from './ctSource'
import type { CtSearchResult } from './ctSource'
```

Add the two new handlers directly after the existing `ct:import` handler
(after line 1211, before the `ct:export` handler's comment):

```ts
  // Searches the curated GitHub repo list (see ctSource.ts) for a .CT file
  // matching gameName. Never throws to the renderer — a search failure
  // (offline, rate-limited) comes back as an empty result list plus an
  // error string, so the UI can show it without a try/catch of its own.
  ipcMain.handle(
    'ctSource:search',
    async (_e, gameName: string): Promise<{ results: CtSearchResult[]; error: string | null }> => {
      try {
        const results = await searchCtTables(gameName)
        return { results, error: null }
      } catch (err) {
        return { results: [], error: String(err) }
      }
    }
  )

  // Fetches one search result and imports it through the same
  // importCheatTable pipeline ct:import uses — picking a result IS the
  // confirm gesture, matching ct:import's own "no separate confirm step"
  // convention.
  ipcMain.handle(
    'ctSource:fetch',
    async (
      _e,
      exeName: string,
      result: CtSearchResult
    ): Promise<{ importedNames: string[]; skipped: { description: string; reason: string }[] } | { error: string }> => {
      let xml: string
      try {
        xml = await fetchCtTable(result)
      } catch (err) {
        return { error: String(err) }
      }
      const { imported, skipped } = importCheatTable(xml)
      for (const cheat of imported) saveCheat(exeName, cheat)
      return { importedNames: imported.map((c) => c.name), skipped }
    }
  )
```

- [ ] **Step 2: Add the preload bridge**

In `src/preload/index.ts`, directly after the existing `exportCheatTable`
line (line 72):

```ts
  searchCtTables: (gameName: string) => ipcRenderer.invoke('ctSource:search', gameName),
  fetchCtTable: (exeName: string, result: CtSearchResult) =>
    ipcRenderer.invoke('ctSource:fetch', exeName, result),
```

Add the needed import at the top of `src/preload/index.ts` (check the
existing import block for where `PatchCheat`/similar main-process types are
already imported as `type`-only, and add alongside):

```ts
import type { CtSearchResult } from '../main/ctSource'
```

- [ ] **Step 3: Add the renderer types**

In `src/renderer/src/tamper.d.ts`, directly after the existing
`exportCheatTable` entry (after line 246):

```ts
      // Searches the curated GitHub CT-table repos for a game name. `error`
      // is set (results empty) on a network/rate-limit failure — the UI
      // shows it rather than throwing.
      searchCtTables: (gameName: string) => Promise<{ results: CtSearchResult[]; error: string | null }>
      // Fetches and imports one search result, saving immediately —
      // mirrors importCheatTable's own convention. Returns an { error }
      // shape on fetch failure instead of the usual import summary.
      fetchCtTable: (
        exeName: string,
        result: CtSearchResult
      ) => Promise<
        | { importedNames: string[]; skipped: { description: string; reason: string }[] }
        | { error: string }
      >
```

Add the type import near the top of `tamper.d.ts`, alongside its existing
type-only imports from `../../main/store` or similar:

```ts
import type { CtSearchResult } from '../../main/ctSource'
```

- [ ] **Step 4: Add the search modal to `CheatList.tsx`**

Add state, directly after the existing `ctExportResult` state declaration
(after line 315):

```ts
  const [ctSourceOpen, setCtSourceOpen] = useState(false)
  const [ctSourceQuery, setCtSourceQuery] = useState(exeName.replace(/\.exe$/i, ''))
  const [ctSourceSearching, setCtSourceSearching] = useState(false)
  const [ctSourceResults, setCtSourceResults] = useState<CtSearchResult[]>([])
  const [ctSourceError, setCtSourceError] = useState<string | null>(null)
  const [ctSourceFetchingPath, setCtSourceFetchingPath] = useState<string | null>(null)
```

Add handlers directly after the existing `exportCheatTable` function:

```ts
  async function searchCtSource() {
    setCtSourceSearching(true)
    setCtSourceError(null)
    setCtSourceResults([])
    try {
      const { results, error } = await window.tamper.searchCtTables(ctSourceQuery)
      setCtSourceResults(results)
      setCtSourceError(error)
    } finally {
      setCtSourceSearching(false)
    }
  }

  async function fetchCtSourceResult(result: CtSearchResult) {
    setCtSourceFetchingPath(result.path)
    try {
      const outcome = await window.tamper.fetchCtTable(exeName, result)
      if ('error' in outcome) {
        setCtSourceError(outcome.error)
        return
      }
      setCtImportResult(outcome) // reuse the existing import-summary banner
      setCtSourceOpen(false)
      const all: StoredCheat[] = await window.tamper.loadCheats(exeName)
      setCheats(all.filter((c): c is CheatDefinition => !isPatch(c) && !isScript(c)))
      setPatches(all.filter(isPatch))
      setScripts(all.filter(isScript))
    } finally {
      setCtSourceFetchingPath(null)
    }
  }
```

Add the import for `CtSearchResult` at the top of `CheatList.tsx`, next to
its existing `import type { ... } from '../../../main/store'`-style lines:

```ts
import type { CtSearchResult } from '../../../main/ctSource'
```

Add the button, directly after the existing `Export to Cheat Table (.CT)`
button (after line 1173):

```tsx
      <button onClick={() => setCtSourceOpen(true)}>Search online (.CT)</button>
```

Add the modal, directly after the closing `)}` of the `ctImportResult`
banner block (after line 1202), reusing the same `.banner` class:

```tsx
      {ctSourceOpen && (
        <div className="banner" style={{ flexWrap: 'wrap' }}>
          <p style={{ flexBasis: '100%' }}>
            Search open GitHub Cheat Engine table repositories for this game.
          </p>
          <input
            value={ctSourceQuery}
            onChange={(e) => setCtSourceQuery(e.target.value)}
            placeholder="Game name"
          />
          <button onClick={searchCtSource} disabled={ctSourceSearching || ctSourceQuery.trim() === ''}>
            {ctSourceSearching ? 'Searching…' : 'Search'}
          </button>
          <button onClick={() => setCtSourceOpen(false)}>Close</button>

          {ctSourceError && (
            <p style={{ flexBasis: '100%' }} className="muted">
              {ctSourceError}
            </p>
          )}

          {ctSourceResults.length > 0 && (
            <ul style={{ flexBasis: '100%' }}>
              {ctSourceResults.map((r) => (
                <li key={`${r.repo}/${r.path}`}>
                  {r.repo} — {r.name}{' '}
                  <button
                    onClick={() => fetchCtSourceResult(r)}
                    disabled={ctSourceFetchingPath === r.path}
                  >
                    {ctSourceFetchingPath === r.path ? 'Importing…' : 'Import'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!ctSourceSearching && ctSourceResults.length === 0 && !ctSourceError && (
            <p style={{ flexBasis: '100%' }} className="muted">
              No results yet — try a search.
            </p>
          )}
        </div>
      )}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Full build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all PASS (no renderer tests exist for this screen, per this
task's note above — this confirms no regression elsewhere).

- [ ] **Step 8: Manual smoke check**

Launch the app (`Apprentice.cmd`, after stopping any already-running
instance), open a game's cheat list, click "Search online (.CT)", search
"valheim", confirm at least one result appears (network required for this
step — if offline, confirm instead that `ctSourceError` renders a message
rather than the UI hanging or crashing), click Import on a result, and
confirm the existing import-summary banner appears and the cheat list
reloads.

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts src/renderer/src/screens/CheatList.tsx
git commit -m "renderer+main: add GitHub CT table search UI"
```

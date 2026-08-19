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
// Exported only for test use (resetting cache state between test cases),
// not called by ipc.ts or any production code path.
const treeCache = new Map<string, TreeEntry[]>()

export function clearTreeCache(): void {
  treeCache.clear()
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

// A hung connection (captive portal, half-open socket) would otherwise
// leave a fetch pending forever with no feedback to the user — bound
// every request so a search or import fails fast instead of spinning.
const FETCH_TIMEOUT_MS = 10_000

// Best-effort cap on a fetched table's byte size, checked against
// Content-Length before buffering the body. Content-Length isn't always
// present/reliable (chunked responses, a server that omits or lies about
// it), so this is only a first line of defense — ctImport.ts's own
// depth/count caps are the actual backstop against a body that evades
// this check.
// Exported so ipc.ts's ct:import handler (the LOCAL file picker path) can
// apply the same cap to a file read directly off disk, not just a fetched
// one — see ipc.ts for why that path was previously missing this check.
export const MAX_TABLE_BYTES = 5 * 1024 * 1024

interface RepoTreeFetch {
  entries: TreeEntry[]
  failed: boolean
}

async function fetchRepoTree(repo: CtRepo, fetchImpl: typeof fetch): Promise<RepoTreeFetch> {
  const key = `${repo.owner}/${repo.repo}@${repo.branch}`
  const cached = treeCache.get(key)
  if (cached) return { entries: cached, failed: false }

  try {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${repo.branch}?recursive=1`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return { entries: [], failed: true } // rate-limited/gone/etc
    const body = (await res.json()) as { tree?: TreeEntry[] }
    const entries = Array.isArray(body.tree) ? body.tree : []
    treeCache.set(key, entries)
    return { entries, failed: false }
  } catch {
    return { entries: [], failed: true } // offline, timeout, or a network error
  }
}

export interface CtSearchOutcome {
  results: CtSearchResult[]
  failedRepoCount: number
}

// Searches every curated repo's file tree for a .CT/.ct file whose path
// contains `gameName`, case-insensitively. Never throws — a repo that
// fails to fetch simply contributes no results, so one bad/rate-limited
// repo never breaks the whole search — but the number of repos that
// failed is reported back so the caller can distinguish "genuinely no
// matches" from "couldn't reach GitHub", which a bare empty result list
// can't. All curated repos are fetched concurrently, not one at a time —
// they're independent GETs, and a sequential loop would multiply a single
// hung connection's delay by the repo count.
export async function searchCtTables(
  gameName: string,
  fetchImpl: typeof fetch = fetch
): Promise<CtSearchOutcome> {
  const needle = gameName.toLowerCase()
  const results: CtSearchResult[] = []
  let failedRepoCount = 0
  const trees = await Promise.all(CT_REPOS.map((repo) => fetchRepoTree(repo, fetchImpl)))
  CT_REPOS.forEach((repo, i) => {
    const { entries, failed } = trees[i]
    if (failed) failedRepoCount++
    for (const entry of entries) {
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
  })
  return { results, failedRepoCount }
}

// Fetches the raw XML content of one search result. Unlike the tree
// listing, raw.githubusercontent.com is not subject to the same rate
// limit as api.github.com, so no caching here.
export async function fetchCtTable(
  result: CtSearchResult,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const branch = result.branch ?? 'main'
  // Path segments (and, defensively, the branch) are URL-encoded — a
  // legal Git path/branch containing '#' or '?' would otherwise truncate
  // the URL at that character, silently fetching the wrong content or
  // 404ing instead of the intended file.
  const encodedPath = result.path.split('/').map(encodeURIComponent).join('/')
  const url = `https://raw.githubusercontent.com/${result.repo}/${encodeURIComponent(branch)}/${encodedPath}`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Failed to fetch "${result.name}" from GitHub (HTTP ${res.status}).`)
  }
  const contentLength = res.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_TABLE_BYTES) {
    throw new Error(`"${result.name}" is too large (${contentLength} bytes) to import.`)
  }
  return res.text()
}

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

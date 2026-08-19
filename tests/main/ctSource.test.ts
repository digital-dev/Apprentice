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
    const { results, failedRepoCount } = await searchCtTables('valheim', fake as typeof fetch)
    expect(results).toContainEqual({
      repo: `${CT_REPOS[0].owner}/${CT_REPOS[0].repo}`,
      path: 'Valheim Cheat Table.CT',
      name: 'Valheim Cheat Table.CT',
      branch: CT_REPOS[0].branch
    })
    expect(results.every((r) => r.name.toLowerCase().endsWith('.ct'))).toBe(true)
    expect(calls).toBe(CT_REPOS.length) // one tree fetch per curated repo
    expect(failedRepoCount).toBe(0)
  })

  it('aggregates matches across multiple repos', async () => {
    const fake = async (): Promise<Response> => treeResponse(['Elden Ring.CT'])
    const { results } = await searchCtTables('elden ring', fake as typeof fetch)
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

  it('treats a failed repo fetch as zero results from that repo, not a thrown error, but reports the failure count', async () => {
    const fake = async (url: string): Promise<Response> => {
      if (url.includes(CT_REPOS[0].repo)) return new Response('rate limited', { status: 403 })
      return treeResponse(['Valheim.CT'])
    }
    const { results, failedRepoCount } = await searchCtTables('valheim', fake as typeof fetch)
    // every repo other than the failing one still contributes
    expect(results.length).toBe(CT_REPOS.length - 1)
    expect(failedRepoCount).toBe(1)
  })

  it('reports every repo as failed when all fetches fail', async () => {
    const fake = async (): Promise<Response> => new Response('rate limited', { status: 403 })
    const { results, failedRepoCount } = await searchCtTables('valheim', fake as typeof fetch)
    expect(results).toEqual([])
    expect(failedRepoCount).toBe(CT_REPOS.length)
  })

  it('fetches all curated repos concurrently, not one at a time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fake = async (): Promise<Response> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return treeResponse([])
    }
    await searchCtTables('valheim', fake as typeof fetch)
    expect(maxInFlight).toBeGreaterThan(1)
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

  it('URL-encodes path segments and branch so a special character cannot truncate the URL', async () => {
    const result: CtSearchResult = {
      repo: 'owner/repo',
      path: 'Tables/Weird #1?.CT',
      name: 'Weird #1?.CT',
      branch: 'feature/odd branch'
    }
    const fake = async (url: string): Promise<Response> => {
      expect(url).toBe(
        'https://raw.githubusercontent.com/owner/repo/feature%2Fodd%20branch/Tables/Weird%20%231%3F.CT'
      )
      return new Response('<CheatTable></CheatTable>', { status: 200 })
    }
    await fetchCtTable(result, fake as typeof fetch)
  })

  it('rejects a response whose declared Content-Length exceeds the size cap', async () => {
    const result: CtSearchResult = { repo: 'owner/repo', path: 'Huge.CT', name: 'Huge.CT' }
    const fake = async (): Promise<Response> =>
      new Response('irrelevant body', {
        status: 200,
        headers: { 'content-length': String(6 * 1024 * 1024) }
      })
    await expect(fetchCtTable(result, fake as typeof fetch)).rejects.toThrow(/too large/i)
  })
})

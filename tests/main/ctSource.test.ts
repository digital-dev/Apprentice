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
      name: 'Valheim Cheat Table.CT',
      branch: CT_REPOS[0].branch
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

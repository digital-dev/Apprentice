import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLibrary, artDataUrl, LibraryScanner } from '../../src/main/library'
import { listProfiles, setProfileDir } from '../../src/main/profile'
import { realSteamFs, type SteamDeps, type SteamGame } from '../../src/main/steamLibrary'

const game = (appId: string, name: string, executables: string[]): SteamGame => ({
  appId,
  name,
  installDir: 'x',
  library: 'x',
  executables
})

describe('buildLibrary', () => {
  const profiles = [
    { exe: 'Schedule I', cheatCount: 26 },
    { exe: 'start_protected_game', cheatCount: 13 }
  ]

  it('ties each game to its profile and cheat count', () => {
    const lib = buildLibrary(
      [game('1', 'Schedule I', ['Schedule I.exe']), game('2', 'ELDEN RING', ['eldenring.exe', 'start_protected_game.exe'])],
      profiles,
      new Set()
    )
    expect(lib.find((g) => g.appId === '1')).toMatchObject({ exe: 'Schedule I', cheatCount: 26 })
    expect(lib.find((g) => g.appId === '2')).toMatchObject({ exe: 'start_protected_game', cheatCount: 13 })
  })

  it('puts games with cheats first, then sorts by name', () => {
    const lib = buildLibrary(
      [game('1', 'Zebra', ['z.exe']), game('2', 'Alpha', ['a.exe']), game('3', 'Schedule I', ['Schedule I.exe'])],
      profiles,
      new Set()
    )
    expect(lib.map((g) => g.name)).toEqual(['Schedule I', 'Alpha', 'Zebra'])
  })

  it('leaves an unsupported game with no exe and zero cheats', () => {
    const [g] = buildLibrary([game('9', 'Other', ['other.exe'])], profiles, new Set())
    expect(g).toMatchObject({ exe: null, cheatCount: 0 })
  })

  it('marks a game running when any of its executables is in the process list', () => {
    const lib = buildLibrary(
      [game('1', 'Schedule I', ['Schedule I.exe']), game('2', 'Other', ['other.exe'])],
      profiles,
      new Set(['schedule i.exe'])
    )
    expect(lib.find((g) => g.appId === '1')?.running).toBe(true)
    expect(lib.find((g) => g.appId === '2')?.running).toBe(false)
  })
})

describe('artDataUrl', () => {
  let root: string
  const deps: SteamDeps = { fs: realSteamFs, readRegistry: () => null, env: {} }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const put = (name: string, bytes: Buffer) => {
    const dir = path.join(root, 'appcache', 'librarycache', '42', 'abc')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), bytes)
  }

  it('returns a base64 data URL with the right mime type', () => {
    put('library_600x900.jpg', Buffer.from([1, 2, 3]))
    expect(artDataUrl(deps, root, '42', 'portrait')).toBe('data:image/jpeg;base64,AQID')
    put('logo.png', Buffer.from([4, 5]))
    expect(artDataUrl(deps, root, '42', 'logo')).toBe('data:image/png;base64,BAU=')
  })

  it('returns null when there is no art, or the file is empty or absurdly large', () => {
    expect(artDataUrl(deps, root, '42', 'portrait')).toBeNull()
    put('library_600x900.jpg', Buffer.alloc(0))
    expect(artDataUrl(deps, root, '42', 'portrait')).toBeNull()
    put('library_hero.jpg', Buffer.alloc(5 * 1024 * 1024))
    expect(artDataUrl(deps, root, '42', 'hero')).toBeNull()
  })
})

describe('LibraryScanner', () => {
  it('caches a scan within the ttl and rescans when forced or expired', () => {
    let reads = 0
    const deps: SteamDeps = {
      fs: realSteamFs,
      readRegistry: () => {
        reads++
        return null
      },
      env: {}
    }
    let clock = 0
    const scanner = new LibraryScanner(deps, 1000, () => clock)
    scanner.scan()
    const first = reads
    scanner.scan()
    expect(reads).toBe(first) // cached
    scanner.scan(true)
    expect(reads).toBeGreaterThan(first) // forced
    const afterForce = reads
    clock = 5000
    scanner.scan()
    expect(reads).toBeGreaterThan(afterForce) // expired
  })

  it('reports no games and no root when Steam is not installed', () => {
    const deps: SteamDeps = { fs: realSteamFs, readRegistry: () => null, env: {} }
    expect(new LibraryScanner(deps).scan()).toMatchObject({ root: null, games: [] })
  })
})

describe('listProfiles', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'games-'))
    setProfileDir(dir)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('lists profiles with their visible cheat count, skipping drafts, junk and internal patches', () => {
    fs.writeFileSync(
      path.join(dir, 'Schedule I.json'),
      JSON.stringify({ exe: 'Schedule I', cheats: [{ id: 'a' }, { id: 'b' }, { id: 'c', internal: true }] })
    )
    fs.writeFileSync(path.join(dir, 'Schedule I.draft.json'), JSON.stringify({ exe: 'Schedule I', cheats: [{ id: 'x' }] }))
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope')
    fs.writeFileSync(path.join(dir, 'notes.md'), '# hi')
    expect(listProfiles()).toEqual([{ exe: 'Schedule I', cheatCount: 2 }])
  })

  it('falls back to the file name when a profile has no exe field, and survives a missing folder', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), JSON.stringify({ cheats: [{ id: 'a' }] }))
    expect(listProfiles()).toEqual([{ exe: 'valheim', cheatCount: 1 }])
    setProfileDir(path.join(dir, 'does-not-exist'))
    expect(listProfiles()).toEqual([])
  })
})

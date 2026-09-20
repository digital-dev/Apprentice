import fs from 'node:fs'
import path from 'node:path'
import {
  discoverGames,
  findArtFile,
  findSteamRoot,
  isRunning,
  matchProfile,
  type ArtKind,
  type SteamDeps,
  type SteamGame
} from './steamLibrary'
import type { ProfileSummary } from './profile'

// Assembles what the game library screen shows: installed Steam games, each
// tied to its cheat profile (if any) and its running state. See
// docs/superpowers/specs/2026-09-20-game-library-design.md.

export interface LibraryGame {
  appId: string
  name: string
  // The cheat profile this game uses, or null when Apprentice has no cheats for it.
  exe: string | null
  cheatCount: number
  running: boolean
}

// Games with cheats first (they are why you are here), then by name.
export function buildLibrary(
  games: SteamGame[],
  profiles: ProfileSummary[],
  processNames: ReadonlySet<string>
): LibraryGame[] {
  const profileExes = profiles.map((p) => p.exe)
  return games
    .map((g): LibraryGame => {
      const exe = matchProfile(g.executables, profileExes)
      return {
        appId: g.appId,
        name: g.name,
        exe,
        cheatCount: exe === null ? 0 : (profiles.find((p) => p.exe === exe)?.cheatCount ?? 0),
        running: isRunning(g.executables, processNames)
      }
    })
    .sort((a, b) => Number(b.exe !== null) - Number(a.exe !== null) || a.name.localeCompare(b.name))
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }
// Cover art is tens to a few hundred KB; anything far bigger is not art.
const MAX_ART_BYTES = 4 * 1024 * 1024

// A data URL for one image, or null when the game has none cached. Data URLs
// because the renderer has no file access and loads no remote content.
export function artDataUrl(deps: SteamDeps, root: string, appId: string, kind: ArtKind): string | null {
  const file = findArtFile(deps, root, appId, kind)
  if (file === null) return null
  const mime = MIME[path.extname(file).toLowerCase()]
  if (!mime) return null
  try {
    const bytes = fs.readFileSync(file)
    if (bytes.length === 0 || bytes.length > MAX_ART_BYTES) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

// Scanning walks each install folder, which is cheap but not free, and the
// screen asks on every visit. Cache briefly; `force` is for a manual refresh.
export class LibraryScanner {
  private cached: { at: number; root: string | null; games: SteamGame[] } | null = null

  constructor(
    private readonly deps: SteamDeps,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  scan(force = false): { root: string | null; games: SteamGame[] } {
    if (!force && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached
    const root = findSteamRoot(this.deps)
    const games = root === null ? [] : discoverGames(this.deps, root)
    this.cached = { at: this.now(), root, games }
    return this.cached
  }
}

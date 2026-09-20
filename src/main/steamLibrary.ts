import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Finds the user's installed Steam games and their cover art, wherever Steam
// and its library folders live. Read-only, and it never touches the network:
// art comes from Steam's own on-disk cache. The registry and file system are
// injected so every rule below is tested against fixtures in the real formats.
// See docs/superpowers/specs/2026-09-20-game-library-design.md.

// ---- Valve KeyValues (.vdf / .acf) ----------------------------------------

export interface VdfObject {
  [key: string]: VdfValue
}
export type VdfValue = string | VdfObject

// A forgiving parser for Valve's text format: "key" "value" pairs and
// "key" { ... } blocks, // comments, backslash escapes inside quotes. Truncated
// input yields whatever parsed so far rather than throwing: a half-written file
// must not take the library down.
export function parseVdf(text: string): VdfObject {
  let i = 0
  const n = text.length

  const skipSpace = (): void => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
      } else return
    }
  }

  const readString = (): string | null => {
    skipSpace()
    if (text[i] !== '"') return null
    i++
    let out = ''
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        const next = text[i + 1]
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        i += 2
      } else out += text[i++]
    }
    i++ // closing quote
    return out
  }

  const readObject = (): VdfObject => {
    const obj: VdfObject = {}
    for (;;) {
      skipSpace()
      if (i >= n) return obj
      if (text[i] === '}') {
        i++
        return obj
      }
      const key = readString()
      if (key === null) {
        i++ // stray character: skip it rather than loop forever
        continue
      }
      skipSpace()
      if (text[i] === '{') {
        i++
        obj[key] = readObject()
      } else {
        const value = readString()
        if (value !== null) obj[key] = value
      }
    }
  }

  return readObject()
}

// ---- Environment ------------------------------------------------------------

export interface SteamFs {
  exists(p: string): boolean
  readText(p: string): string | null
  readDir(p: string): { name: string; isDir: boolean }[]
}

export interface SteamDeps {
  fs: SteamFs
  // The value of a registry string, or null. Windows only; anything else null.
  readRegistry(key: string, name: string): string | null
  env: Record<string, string | undefined>
}

export const realSteamFs: SteamFs = {
  exists: (p) => fs.existsSync(p),
  readText: (p) => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  readDir: (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }))
    } catch {
      return []
    }
  }
}

// `reg query` rather than a native module: no dependency, and the output is one
// line of "    Name    REG_SZ    value".
function realReadRegistry(key: string, name: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = out.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`, 'i'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export function realSteamDeps(): SteamDeps {
  return { fs: realSteamFs, readRegistry: realReadRegistry, env: process.env }
}

// ---- Steam root and libraries -----------------------------------------------

const norm = (p: string): string => path.normalize(p)
const sameFolder = (a: string, b: string): boolean => norm(a).toLowerCase() === norm(b).toLowerCase()

export function findSteamRoot(deps: SteamDeps): string | null {
  const candidates = [
    deps.readRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    deps.readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    deps.env['ProgramFiles(x86)'] ? path.join(deps.env['ProgramFiles(x86)']!, 'Steam') : null,
    deps.env['ProgramFiles'] ? path.join(deps.env['ProgramFiles']!, 'Steam') : null
  ]
  for (const c of candidates) {
    if (c && deps.fs.exists(path.join(norm(c), 'steamapps'))) return norm(c)
  }
  return null
}

// The root itself is always a library; libraryfolders.vdf adds the others (other
// drives). One that no longer exists, such as an unplugged drive, is dropped.
export function libraryPaths(deps: SteamDeps, root: string): string[] {
  const found: string[] = [norm(root)]
  const text = deps.fs.readText(path.join(root, 'steamapps', 'libraryfolders.vdf'))
  if (text) {
    const folders = (parseVdf(text).libraryfolders ?? {}) as VdfObject
    for (const entry of Object.values(folders)) {
      const p = typeof entry === 'object' ? entry.path : undefined
      if (typeof p !== 'string' || !p) continue
      if (found.some((f) => sameFolder(f, p))) continue
      if (deps.fs.exists(path.join(norm(p), 'steamapps'))) found.push(norm(p))
    }
  }
  return found
}

// ---- Games --------------------------------------------------------------------

export interface SteamGame {
  appId: string
  name: string
  installDir: string
  library: string
  executables: string[]
}

// Not games: Steam's own redistributable packages that show up as apps.
const NON_GAME_NAMES = /^steamworks common redistributables$|^steam linux runtime|^proton\b/i

// Crash reporters, installers and redistributables ship beside real games and
// would only add noise to matching. An anti-cheat bootstrap that IS the game's
// launch exe (start_protected_game.exe) is deliberately not listed here.
const HELPER_EXE =
  /^(unitycrashhandler(32|64)?|crashreport(er|client)?|.*crashpad.*|unins\d*|uninstall.*|vc_?redist.*|dxsetup|dotnet.*|ue4prereqsetup.*|.*installer.*|.*_setup|setup|dxwebsetup)\.exe$/i

export function isHelperExe(name: string): boolean {
  return HELPER_EXE.test(name)
}

// Folders that hold thousands of assets and never a game's own executable.
const SKIP_DIR = /^(content|paks|movies|localization|_commonredist|redist|redistributables|directx|vcredist|mono|monobleedingedge|il2cpp_data|streamingassets)$|_data$/i

// Unreal games keep the shipping exe three folders down (Pal/Binaries/Win64), so
// look that deep, but never into the asset folders above.
const EXE_SEARCH_DEPTH = 3

function collectExecutables(deps: SteamDeps, dir: string, depth = 0): string[] {
  const out: string[] = []
  for (const entry of deps.fs.readDir(dir)) {
    if (entry.isDir) {
      if (depth < EXE_SEARCH_DEPTH && !SKIP_DIR.test(entry.name)) {
        out.push(...collectExecutables(deps, path.join(dir, entry.name), depth + 1))
      }
    } else if (/\.exe$/i.test(entry.name) && !isHelperExe(entry.name)) {
      out.push(entry.name)
    }
  }
  return out
}

export function discoverGames(deps: SteamDeps, root: string): SteamGame[] {
  const games: SteamGame[] = []
  const seen = new Set<string>()
  for (const library of libraryPaths(deps, root)) {
    const steamapps = path.join(library, 'steamapps')
    for (const entry of deps.fs.readDir(steamapps)) {
      const m = entry.name.match(/^appmanifest_(\d+)\.acf$/)
      if (!m || seen.has(m[1])) continue
      const text = deps.fs.readText(path.join(steamapps, entry.name))
      const state = text ? (parseVdf(text).AppState as VdfObject | undefined) : undefined
      const name = state?.name
      const installdir = state?.installdir
      if (typeof name !== 'string' || typeof installdir !== 'string' || !name || !installdir) continue
      if (NON_GAME_NAMES.test(name)) continue
      const installDir = path.join(steamapps, 'common', installdir)
      // A manifest can outlive its files: only an install that is really there counts.
      if (!deps.fs.exists(installDir)) continue
      seen.add(m[1])
      games.push({
        appId: m[1],
        name,
        installDir,
        library,
        executables: [...new Set(collectExecutables(deps, installDir))]
      })
    }
  }
  return games.sort((a, b) => a.name.localeCompare(b.name))
}

// ---- Cover art ----------------------------------------------------------------

export type ArtKind = 'portrait' | 'hero' | 'header' | 'logo'

// Preferred name first. Steam caches portrait art as library_600x900.jpg for some
// games and library_capsule.jpg (the same portrait shape) for many others.
const ART_FILES: Record<ArtKind, string[]> = {
  portrait: ['library_600x900.jpg', 'library_capsule.jpg'],
  hero: ['library_hero.jpg'],
  header: ['library_header.jpg'],
  logo: ['logo.png']
}

// Steam stores each image in a folder named by a hash that varies per image and
// per Steam version, so search the app's cache folder for the file by name.
export function findArtFile(deps: SteamDeps, root: string, appId: string, kind: ArtKind): string | null {
  // The id becomes part of a path: digits only, or it could walk out of the cache.
  if (!/^\d+$/.test(appId)) return null
  const appDir = path.join(root, 'appcache', 'librarycache', appId)
  const entries = deps.fs.readDir(appDir)
  for (const wanted of ART_FILES[kind]) {
    for (const entry of entries) {
      if (!entry.isDir) {
        if (entry.name === wanted) return path.join(appDir, entry.name)
        continue
      }
      const candidate = path.join(appDir, entry.name, wanted)
      if (deps.fs.exists(candidate)) return candidate
    }
  }
  return null
}

// ---- Profiles and running state -------------------------------------------------

const stem = (exe: string): string => exe.replace(/\.exe$/i, '').toLowerCase()

// The cheat profile a game belongs to: one whose exe is among the game's
// executables. Returns the profile's own spelling.
export function matchProfile(executables: string[], profileExes: string[]): string | null {
  const have = new Set(executables.map(stem))
  return profileExes.find((p) => have.has(stem(p))) ?? null
}

// `processNames` are lowercase, e.g. from the running process list.
export function isRunning(executables: string[], processNames: ReadonlySet<string>): boolean {
  return executables.some((e) => processNames.has(e.toLowerCase()))
}

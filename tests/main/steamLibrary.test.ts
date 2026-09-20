import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseVdf,
  findSteamRoot,
  libraryPaths,
  discoverGames,
  findArtFile,
  matchProfile,
  isRunning,
  isHelperExe,
  realSteamFs,
  type SteamDeps
} from '../../src/main/steamLibrary'

// Fixtures use the real formats seen on a Steam install: libraryfolders.vdf with
// doubled backslashes, appmanifest_<id>.acf, and librarycache/<id>/<hash>/art.

let tmp: string
let steam: string // the Steam root
let lib2: string // a second library on "another drive"

const write = (p: string, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}
const vdfPath = (p: string) => p.replace(/\\/g, '\\\\')

function manifest(library: string, appId: string, name: string, installdir: string, installed = true) {
  write(
    path.join(library, 'steamapps', `appmanifest_${appId}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${installdir}"\n}\n`
  )
  if (installed) fs.mkdirSync(path.join(library, 'steamapps', 'common', installdir), { recursive: true })
}

function deps(over: Partial<SteamDeps> = {}): SteamDeps {
  return { fs: realSteamFs, readRegistry: () => null, env: {}, ...over }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'))
  steam = path.join(tmp, 'Program Files (x86)', 'Steam')
  lib2 = path.join(tmp, 'SteamLibrary')
  write(
    path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(steam)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(lib2)}"\n\t\t"apps"\n\t\t{\n\t\t\t"3164500"\t\t"1"\n\t\t}\n\t}\n}\n`
  )
  fs.mkdirSync(path.join(lib2, 'steamapps'), { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('parseVdf', () => {
  it('parses nested objects and unescapes backslashes in paths', () => {
    const v = parseVdf('"a"\n{\n  "path"  "C:\\\\Games\\\\Steam"\n  "inner" { "k" "v" }\n}')
    expect(v).toEqual({ a: { path: 'C:\\Games\\Steam', inner: { k: 'v' } } })
  })

  it('ignores // comments and tolerates blank lines and tabs', () => {
    expect(parseVdf('// header\n"a"\t"b"\n\n"c" "d" // trailing')).toEqual({ a: 'b', c: 'd' })
  })

  it('keeps a quoted value containing braces and spaces intact', () => {
    expect(parseVdf('"name" "Half {Life} 2"')).toEqual({ name: 'Half {Life} 2' })
  })

  it('does not throw on truncated input', () => {
    expect(() => parseVdf('"a"\n{\n "b" "c"')).not.toThrow()
    expect(parseVdf('')).toEqual({})
  })
})

describe('findSteamRoot', () => {
  it('uses the registry path, normalising its lowercase forward slashes', () => {
    const root = findSteamRoot(deps({ readRegistry: () => steam.toLowerCase().replace(/\\/g, '/') }))
    expect(root?.toLowerCase()).toBe(steam.toLowerCase())
  })

  it('skips a registry path that does not exist and falls back to the next candidate', () => {
    const root = findSteamRoot(
      deps({
        readRegistry: (key) => (key.includes('HKCU') ? path.join(tmp, 'gone') : null),
        env: { 'ProgramFiles(x86)': path.join(tmp, 'Program Files (x86)') }
      })
    )
    expect(root).toBe(steam)
  })

  it('returns null when Steam cannot be found anywhere', () => {
    expect(findSteamRoot(deps())).toBeNull()
  })
})

describe('libraryPaths', () => {
  it('lists the root plus every library in libraryfolders.vdf, without duplicates', () => {
    expect(libraryPaths(deps(), steam)).toEqual([steam, lib2])
  })

  it('still returns the root when libraryfolders.vdf is missing or unreadable', () => {
    fs.rmSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'))
    expect(libraryPaths(deps(), steam)).toEqual([steam])
  })

  it('drops a library whose folder no longer exists (an unplugged drive)', () => {
    fs.rmSync(lib2, { recursive: true })
    expect(libraryPaths(deps(), steam)).toEqual([steam])
  })
})

describe('discoverGames', () => {
  it('finds games across libraries, sorted by name', () => {
    manifest(lib2, '3164500', 'Schedule I', 'Schedule I')
    manifest(steam, '1', 'Zebra', 'Zebra')
    manifest(lib2, '2', 'Aviassembly', 'Aviassembly')
    const games = discoverGames(deps(), steam)
    expect(games.map((g) => g.name)).toEqual(['Aviassembly', 'Schedule I', 'Zebra'])
    expect(games.find((g) => g.appId === '3164500')?.installDir).toBe(
      path.join(lib2, 'steamapps', 'common', 'Schedule I')
    )
  })

  it('ignores a manifest whose install folder is gone (uninstalled)', () => {
    manifest(lib2, '9', 'Gone Game', 'GoneGame', false)
    expect(discoverGames(deps(), steam)).toEqual([])
  })

  it('ignores Steamworks tooling that appears as an app', () => {
    manifest(steam, '228980', 'Steamworks Common Redistributables', 'Steamworks Shared')
    expect(discoverGames(deps(), steam)).toEqual([])
  })

  it('collects executables, including Unreal-style ones several folders down', () => {
    manifest(lib2, '1623730', 'Palworld', 'Palworld')
    const root = path.join(lib2, 'steamapps', 'common', 'Palworld')
    write(path.join(root, 'Palworld.exe'))
    write(path.join(root, 'Pal', 'Binaries', 'Win64', 'Palworld-Win64-Shipping.exe'))
    write(path.join(root, 'Pal', 'Content', 'Paks', 'deep', 'decoy.exe')) // heavy content folder: skipped
    const [g] = discoverGames(deps(), steam)
    expect(g.executables.sort()).toEqual(['Palworld-Win64-Shipping.exe', 'Palworld.exe'])
  })

  it('drops crash handlers and uninstallers but keeps an anti-cheat bootstrap that is a real game exe', () => {
    manifest(lib2, '1245620', 'ELDEN RING', 'ELDEN RING')
    const game = path.join(lib2, 'steamapps', 'common', 'ELDEN RING', 'Game')
    write(path.join(game, 'eldenring.exe'))
    write(path.join(game, 'start_protected_game.exe'))
    write(path.join(game, 'UnityCrashHandler64.exe'))
    write(path.join(game, 'unins000.exe'))
    const [g] = discoverGames(deps(), steam)
    expect(g.executables.sort()).toEqual(['eldenring.exe', 'start_protected_game.exe'])
  })

  it('survives a manifest with no name or installdir', () => {
    write(path.join(steam, 'steamapps', 'appmanifest_5.acf'), '"AppState"\n{\n\t"appid"\t"5"\n}\n')
    expect(discoverGames(deps(), steam)).toEqual([])
  })
})

describe('isHelperExe', () => {
  it.each(['UnityCrashHandler64.exe', 'unins000.exe', 'vc_redist.x64.exe', 'CrashReportClient.exe', 'DXSETUP.exe'])(
    'treats %s as a helper',
    (n) => expect(isHelperExe(n)).toBe(true)
  )
  it.each(['Schedule I.exe', 'start_protected_game.exe', 'Valheim.exe', 'Palworld-Win64-Shipping.exe'])(
    'keeps %s',
    (n) => expect(isHelperExe(n)).toBe(false)
  )
})

describe('findArtFile', () => {
  it('finds art by name inside the per-app hash folder', () => {
    const dir = path.join(steam, 'appcache', 'librarycache', '3164500')
    write(path.join(dir, 'aaa', 'library_600x900.jpg'))
    write(path.join(dir, 'bbb', 'library_hero.jpg'))
    write(path.join(dir, 'ccc', 'logo.png'))
    expect(findArtFile(deps(), steam, '3164500', 'portrait')).toBe(path.join(dir, 'aaa', 'library_600x900.jpg'))
    expect(findArtFile(deps(), steam, '3164500', 'hero')).toBe(path.join(dir, 'bbb', 'library_hero.jpg'))
    expect(findArtFile(deps(), steam, '3164500', 'logo')).toBe(path.join(dir, 'ccc', 'logo.png'))
  })

  it('falls back to the capsule image, which Steam uses for the portrait on many games', () => {
    const dir = path.join(steam, 'appcache', 'librarycache', '892970')
    write(path.join(dir, 'aaa', 'library_capsule.jpg'))
    expect(findArtFile(deps(), steam, '892970', 'portrait')).toBe(path.join(dir, 'aaa', 'library_capsule.jpg'))
  })

  it('prefers the 600x900 image over the capsule when both exist', () => {
    const dir = path.join(steam, 'appcache', 'librarycache', '7')
    write(path.join(dir, 'aaa', 'library_capsule.jpg'))
    write(path.join(dir, 'bbb', 'library_600x900.jpg'))
    expect(findArtFile(deps(), steam, '7', 'portrait')).toBe(path.join(dir, 'bbb', 'library_600x900.jpg'))
  })

  it('finds art that sits directly in the app folder rather than in a hash folder', () => {
    const dir = path.join(steam, 'appcache', 'librarycache', '1623730')
    write(path.join(dir, 'logo.png'))
    expect(findArtFile(deps(), steam, '1623730', 'logo')).toBe(path.join(dir, 'logo.png'))
  })

  it('returns null when the game has no cached art', () => {
    expect(findArtFile(deps(), steam, '42', 'portrait')).toBeNull()
  })

  it('refuses an app id that is not digits, so it cannot escape the cache folder', () => {
    expect(findArtFile(deps(), steam, '..\\..\\Windows', 'portrait')).toBeNull()
  })
})

describe('matchProfile', () => {
  it('matches a profile named for one of the game executables, ignoring case and .exe', () => {
    expect(matchProfile(['eldenring.exe', 'start_protected_game.exe'], ['start_protected_game'])).toBe('start_protected_game')
    expect(matchProfile(['SCHEDULE I.exe'], ['Schedule I'])).toBe('Schedule I')
  })

  it('returns null when nothing matches', () => {
    expect(matchProfile(['a.exe'], ['b'])).toBeNull()
    expect(matchProfile([], ['b'])).toBeNull()
  })
})

describe('isRunning', () => {
  it('is true when any of the game executables is in the process list', () => {
    expect(isRunning(['Palworld.exe', 'Palworld-Win64-Shipping.exe'], new Set(['palworld-win64-shipping.exe']))).toBe(true)
    expect(isRunning(['a.exe'], new Set(['b.exe']))).toBe(false)
  })
})

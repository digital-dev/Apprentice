import fs from 'node:fs'
import path from 'node:path'
import type { StoredCheat } from './store'

// What identifies a build of one module. Size and timestamp come from the
// PE headers already mapped in the target, so a fingerprint costs a couple
// of reads and no file I/O. Version is recorded for the user and is
// deliberately NOT part of the match test — plenty of game DLLs ship with
// no version resource at all, and failing them all as unverified would make
// the flag meaningless.
export interface ModuleFingerprint {
  size: number
  timestamp: number
  version: string | null
}

export interface GameProfile {
  schema: 2
  exe: string
  // Only modules some cheat in this file anchors into, not everything
  // loaded — so an unrelated DLL updating costs nothing.
  modules: Record<string, ModuleFingerprint>
  cheats: StoredCheat[]
}

let gamesDir = path.resolve(__dirname, '../../games')

export function setProfileDir(dir: string): void {
  gamesDir = dir
}

function filePathFor(exeName: string): string {
  return path.join(gamesDir, `${exeName.replace(/\.exe$/i, '')}.json`)
}

// A cheap existsSync-only check, deliberately separate from loadProfile:
// callers that only need to know "is there a profile at all" (e.g. the
// process watcher, polled every couple seconds against every running
// process) can skip the read+parse entirely for the common case of a
// process with no profile file, rather than paying a filesystem read and a
// JSON.parse per process per tick.
export function profileFileExists(exeName: string): boolean {
  return fs.existsSync(filePathFor(exeName))
}

function emptyProfile(exeName: string): GameProfile {
  return { schema: 2, exe: exeName.replace(/\.exe$/i, ''), modules: {}, cheats: [] }
}

export function loadProfile(exeName: string): GameProfile {
  const file = filePathFor(exeName)
  if (!fs.existsSync(file)) return emptyProfile(exeName)
  const raw = fs.readFileSync(file, 'utf-8')
  // An empty file is the same as no file — a truncated write or a
  // half-finished hand-edit leaves one behind, and there is nothing in it
  // to lose by treating it as no cheats.
  if (raw.trim() === '') return emptyProfile(exeName)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // Deliberately NOT recovering by returning an empty profile. Saving
    // loads, appends and rewrites, so swallowing a parse failure would
    // replace a file full of cheats with whichever single one was being
    // saved — silent data loss, and the user's own edit is the likeliest
    // cause of the parse failure in the first place. Throwing is what makes
    // the failure visible; when this file was left empty by an editor, the
    // symptom looked like a broken button rather than a broken file.
    throw new Error(
      `${file} isn't valid JSON (${(err as Error).message}). Fix or delete the file — refusing to overwrite it and lose the cheats it holds.`
    )
  }

  // Schema 1: a bare array of cheats, written before profiles existed. It
  // loads as a profile with no fingerprints, which makes every cheat in it
  // unverified and signature-only — exactly how it behaved before. The file
  // on disk is left alone until something is saved.
  if (Array.isArray(parsed)) {
    return { ...emptyProfile(exeName), cheats: parsed as StoredCheat[] }
  }

  const obj = parsed as Partial<GameProfile>
  if (!Array.isArray(obj.cheats)) {
    throw new Error(`${file} has no cheats array — refusing to overwrite it.`)
  }
  return {
    schema: 2,
    exe: obj.exe ?? exeName.replace(/\.exe$/i, ''),
    modules: obj.modules ?? {},
    cheats: obj.cheats
  }
}

export function saveProfile(exeName: string, profile: GameProfile): void {
  fs.mkdirSync(gamesDir, { recursive: true })
  fs.writeFileSync(filePathFor(exeName), JSON.stringify(profile, null, 2))
}

export function recordModuleFingerprint(
  exeName: string,
  moduleName: string,
  fp: ModuleFingerprint
): void {
  const profile = loadProfile(exeName)
  profile.modules[moduleName] = fp
  saveProfile(exeName, profile)
}

// Which of the profile's remembered modules are loaded right now with the
// same size and timestamp. A cheat anchored to a module outside this set is
// unverified: its recorded RVA is not to be trusted without a byte check.
export function verifiedModules(
  profile: GameProfile,
  loaded: { name: string; size: number; timestamp: number }[]
): Set<string> {
  const byName = new Map(loaded.map((m) => [m.name.toLowerCase(), m]))
  const verified = new Set<string>()
  for (const [name, fp] of Object.entries(profile.modules)) {
    const live = byName.get(name.toLowerCase())
    if (live && live.size === fp.size && live.timestamp === fp.timestamp) verified.add(name)
  }
  return verified
}

// The fingerprint of one loaded module, or null when it isn't loaded (or
// the patch is JIT-anchored and names no module at all). Pure, so the
// decision is testable without the addon or electron.
export function fingerprintOf(
  loaded: { name: string; size: number; timestamp: number; version: string | null }[],
  moduleName: string | null
): ModuleFingerprint | null {
  if (moduleName === null) return null
  const found = loaded.find((m) => m.name.toLowerCase() === moduleName.toLowerCase())
  if (!found) return null
  return { size: found.size, timestamp: found.timestamp, version: found.version }
}

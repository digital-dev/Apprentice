import fs from 'node:fs'
import path from 'node:path'

export type CheatMode = 'freeze' | 'oneshot'
export type DataType = 'int32' | 'float'

// A cheat can write to more than one resolved pointer chain at once. Naive
// memory scanning sometimes finds a chain that only looks static (a false
// positive within the offset-tolerant search) and stops resolving after a
// few seconds even though other candidates from the same scan keep
// working — writing to every selected target on each tick, and treating
// the cheat as broken only when ALL of them fail, makes a saved cheat
// resilient to any single target going stale.
export interface ChainTarget {
  moduleName: string
  baseOffset: string
  offsets: string[]
}

// A target reached through a pointer captured by an injection, rather than
// through a chain found by scanning. Scanned chains walk whatever path
// existed in that session and do not survive a restart of a managed runtime;
// a capture patch relocates by byte pattern and records the object's real
// address every time the game touches it, so a cheat anchored to one keeps
// working across restarts.
export interface AnchorTarget {
  kind: 'anchor'
  patchId: string
  offset: string
}

export type CheatTarget = ChainTarget | AnchorTarget

export function isAnchorTarget(target: CheatTarget): target is AnchorTarget {
  return (target as AnchorTarget).kind === 'anchor'
}

export interface CheatDefinition {
  kind?: 'value'
  id: string
  name: string
  dataType: DataType
  mode: CheatMode
  targets: CheatTarget[]
  value: number
}

// A code patch: NOP out the instruction the game uses to write a value,
// instead of fighting that write by freezing the value. Stored in the same
// per-game array as value cheats and told apart by `kind` — an absent
// `kind` means a value cheat, which keeps every existing games/*.json file
// loading unchanged.
export interface PatchCheat {
  kind: 'patch'
  // How this patch changes the game. Absent means 'nop': every patch saved
  // before injection existed keeps working through the same code path.
  mode?: 'nop' | 'force' | 'capture'
  id: string
  name: string
  originalBytes: string // captured instruction bytes, unspaced lowercase hex
  length: number // bytes to NOP == instruction length
  signature: string // AOB with ?? wildcards, for relocating JIT code
  // How many signature bytes precede the captured instruction. The pattern
  // covers the surrounding method for uniqueness — a short method's own
  // bytes are not distinctive enough on their own — so a scan match is the
  // start of that context and the instruction is at match + this. Absent
  // means 0: every patch saved before signatures grew a lead-in has its
  // instruction at the start of the pattern, and must keep locating exactly
  // as it did.
  signatureOffset?: number
  moduleName: string | null // named module, or null for JIT/anonymous code
  moduleOffset: string | null // hex offset within that module
  // force and capture: which register held the object at capture time.
  baseRegister?: string
  // force only: where the field sits relative to that register, what to
  // write, and how to turn `value` into the 32 bits that get written.
  fieldOffset?: string
  value?: number
  dataType?: DataType
}

export type StoredCheat = CheatDefinition | PatchCheat

export function isPatchCheat(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
}

export function patchMode(patch: PatchCheat): 'nop' | 'force' | 'capture' {
  return patch.mode ?? 'nop'
}

let gamesDir = path.resolve(__dirname, '../../games')

export function setGamesDir(dir: string): void {
  gamesDir = dir
}

function filePathFor(exeName: string): string {
  return path.join(gamesDir, `${exeName.replace(/\.exe$/i, '')}.json`)
}

export function loadCheats(exeName: string): StoredCheat[] {
  const file = filePathFor(exeName)
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8')
  // An empty file is the same as no file — a truncated write or a
  // half-finished hand-edit leaves one behind, and there is nothing in it
  // to lose by treating it as no cheats.
  if (raw.trim() === '') return []
  try {
    return JSON.parse(raw) as StoredCheat[]
  } catch (err) {
    // Deliberately NOT recovering by returning []. saveCheat loads, appends
    // and rewrites, so swallowing a parse failure here would replace a file
    // full of cheats with whichever single one was being saved — silent
    // data loss, and the user's own edit is the likeliest cause of the
    // parse failure in the first place.
    //
    // Throwing is what makes the failure visible. When this file was left
    // empty by an editor, the bare JSON.parse threw here, saveCheat threw
    // with it, and "Create patch" did nothing at all with no message — the
    // symptom looked like a broken button rather than a broken file.
    throw new Error(
      `${file} isn't valid JSON (${(err as Error).message}). Fix or delete the file — refusing to overwrite it and lose the cheats it holds.`
    )
  }
}

export function saveCheat(exeName: string, cheat: StoredCheat): void {
  const cheats = loadCheats(exeName)
  const idx = cheats.findIndex((c) => c.id === cheat.id)
  if (idx >= 0) cheats[idx] = cheat
  else cheats.push(cheat)

  fs.mkdirSync(gamesDir, { recursive: true })
  fs.writeFileSync(filePathFor(exeName), JSON.stringify(cheats, null, 2))
}

export function deleteCheat(exeName: string, cheatId: string): void {
  const cheats = loadCheats(exeName).filter((c) => c.id !== cheatId)
  fs.mkdirSync(gamesDir, { recursive: true })
  fs.writeFileSync(filePathFor(exeName), JSON.stringify(cheats, null, 2))
}

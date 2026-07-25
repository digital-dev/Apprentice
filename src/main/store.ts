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

export interface CheatDefinition {
  kind?: 'value'
  id: string
  name: string
  dataType: DataType
  mode: CheatMode
  targets: ChainTarget[]
  value: number
}

// A code patch: NOP out the instruction the game uses to write a value,
// instead of fighting that write by freezing the value. Stored in the same
// per-game array as value cheats and told apart by `kind` — an absent
// `kind` means a value cheat, which keeps every existing games/*.json file
// loading unchanged.
export interface PatchCheat {
  kind: 'patch'
  id: string
  name: string
  originalBytes: string // captured instruction bytes, unspaced lowercase hex
  length: number // bytes to NOP == instruction length
  signature: string // AOB with ?? wildcards, for relocating JIT code
  moduleName: string | null // named module, or null for JIT/anonymous code
  moduleOffset: string | null // hex offset within that module
}

export type StoredCheat = CheatDefinition | PatchCheat

export function isPatchCheat(cheat: StoredCheat): cheat is PatchCheat {
  return cheat.kind === 'patch'
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
  return JSON.parse(raw) as StoredCheat[]
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

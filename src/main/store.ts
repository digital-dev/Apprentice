import fs from 'node:fs'
import path from 'node:path'

export type CheatMode = 'freeze' | 'oneshot'
export type DataType = 'int32' | 'float'

export interface CheatDefinition {
  id: string
  name: string
  dataType: DataType
  mode: CheatMode
  moduleName: string
  baseOffset: string
  offsets: string[]
  value: number
}

let gamesDir = path.resolve(__dirname, '../../games')

export function setGamesDir(dir: string): void {
  gamesDir = dir
}

function filePathFor(exeName: string): string {
  return path.join(gamesDir, `${exeName.replace(/\.exe$/i, '')}.json`)
}

export function loadCheats(exeName: string): CheatDefinition[] {
  const file = filePathFor(exeName)
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8')
  return JSON.parse(raw) as CheatDefinition[]
}

export function saveCheat(exeName: string, cheat: CheatDefinition): void {
  const cheats = loadCheats(exeName)
  const idx = cheats.findIndex((c) => c.id === cheat.id)
  if (idx >= 0) cheats[idx] = cheat
  else cheats.push(cheat)

  fs.mkdirSync(gamesDir, { recursive: true })
  fs.writeFileSync(filePathFor(exeName), JSON.stringify(cheats, null, 2))
}

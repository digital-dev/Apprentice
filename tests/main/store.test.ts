import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadCheats, saveCheat, setGamesDir } from '../../src/main/store'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-games-'))
  setGamesDir(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('store', () => {
  it('returns an empty list for a game with no file yet', () => {
    expect(loadCheats('valheim.exe')).toEqual([])
  })

  it('saves a cheat and loads it back', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float',
      mode: 'freeze',
      moduleName: 'valheim.exe',
      baseOffset: '0x1000',
      offsets: ['0x8'],
      value: 999
    })
    const cheats = loadCheats('valheim.exe')
    expect(cheats).toHaveLength(1)
    expect(cheats[0].id).toBe('stamina')
  })

  it('replaces an existing cheat with the same id instead of duplicating', () => {
    const base = {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float' as const,
      mode: 'freeze' as const,
      moduleName: 'valheim.exe',
      baseOffset: '0x1000',
      offsets: ['0x8'],
      value: 999
    }
    saveCheat('valheim.exe', base)
    saveCheat('valheim.exe', { ...base, value: 500 })
    const cheats = loadCheats('valheim.exe')
    expect(cheats).toHaveLength(1)
    expect(cheats[0].value).toBe(500)
  })
})

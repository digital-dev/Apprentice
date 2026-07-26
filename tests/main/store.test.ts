import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  loadCheats,
  saveCheat,
  deleteCheat,
  setGamesDir,
  isPatchCheat,
  isAnchorTarget,
  PatchCheat,
  CheatDefinition,
  patchMode
} from '../../src/main/store'

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

  it('saves a cheat with multiple targets and loads it back', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [
        { moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] },
        { moduleName: 'mono-2.0-bdwgc.dll', baseOffset: '0x2000', offsets: ['0x10', '0x4'] }
      ],
      value: 999
    })
    const cheats = loadCheats('valheim.exe')
    expect(cheats).toHaveLength(1)
    expect(cheats[0].id).toBe('stamina')
    expect(cheats[0].targets).toHaveLength(2)
  })

  it('replaces an existing cheat with the same id instead of duplicating', () => {
    const base = {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float' as const,
      mode: 'freeze' as const,
      targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
      value: 999
    }
    saveCheat('valheim.exe', base)
    saveCheat('valheim.exe', { ...base, value: 500 })
    const cheats = loadCheats('valheim.exe')
    expect(cheats).toHaveLength(1)
    expect(cheats[0].value).toBe(500)
  })

  it('deletes a cheat by id', () => {
    const cheat = {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float' as const,
      mode: 'freeze' as const,
      targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
      value: 999
    }
    saveCheat('valheim.exe', cheat)
    expect(loadCheats('valheim.exe')).toHaveLength(1)

    deleteCheat('valheim.exe', 'stamina')
    expect(loadCheats('valheim.exe')).toEqual([])
  })

  it('deleting a nonexistent cheat id is a harmless no-op', () => {
    deleteCheat('valheim.exe', 'does-not-exist')
    expect(loadCheats('valheim.exe')).toEqual([])
  })
})

describe('store — patch cheats', () => {
  const patch: PatchCheat = {
    kind: 'patch',
    id: 'no-stamina-drain',
    name: 'No Stamina Drain',
    originalBytes: 'f30f114110',
    length: 5,
    signature: 'f3 0f 11 41 10',
    moduleName: 'valheim.exe',
    moduleOffset: '0x1234'
  }

  it('saves and loads a patch cheat alongside a value cheat', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
      value: 999
    })
    saveCheat('valheim.exe', patch)

    const cheats = loadCheats('valheim.exe')
    expect(cheats).toHaveLength(2)
    expect(cheats.filter(isPatchCheat)).toHaveLength(1)
    expect(cheats.filter(isPatchCheat)[0].originalBytes).toBe('f30f114110')
  })

  it('treats a cheat with no kind field as a value cheat (backward compatible)', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Unlimited Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
      value: 999
    })
    const cheats = loadCheats('valheim.exe')
    expect(isPatchCheat(cheats[0])).toBe(false)
  })

  it('deletes a patch cheat by id', () => {
    saveCheat('valheim.exe', patch)
    deleteCheat('valheim.exe', 'no-stamina-drain')
    expect(loadCheats('valheim.exe')).toEqual([])
  })

  it('supports a JIT patch with no module (relocated by signature only)', () => {
    saveCheat('valheim.exe', { ...patch, moduleName: null, moduleOffset: null })
    const loaded = loadCheats('valheim.exe').filter(isPatchCheat)[0]
    expect(loaded.moduleName).toBeNull()
    expect(loaded.signature).toBe('f3 0f 11 41 10')
  })
})

describe('store — patch modes', () => {
  const forcePatch: PatchCheat = {
    kind: 'patch',
    mode: 'force',
    id: 'patch-stamina',
    name: 'Stamina',
    originalBytes: 'f30f11af18080000',
    length: 8,
    signature: 'f3 0f 11 af 18 08 00 00',
    moduleName: null,
    moduleOffset: null,
    baseRegister: 'rdi',
    fieldOffset: '0x818',
    value: 350,
    dataType: 'float'
  }

  it('round-trips a force patch with its value and register', () => {
    saveCheat('valheim.exe', forcePatch)
    const loaded = loadCheats('valheim.exe').filter(isPatchCheat)[0]
    expect(loaded.mode).toBe('force')
    expect(loaded.baseRegister).toBe('rdi')
    expect(loaded.value).toBe(350)
    expect(loaded.dataType).toBe('float')
  })

  it('treats a patch with no mode as a NOP patch', () => {
    const legacy: PatchCheat = { ...forcePatch, id: 'patch-legacy' }
    delete (legacy as Partial<PatchCheat>).mode
    saveCheat('valheim.exe', legacy)
    const loaded = loadCheats('valheim.exe').filter(isPatchCheat)
      .find((p) => p.id === 'patch-legacy') as PatchCheat
    expect(patchMode(loaded)).toBe('nop')
  })
})

describe('store — anchored targets', () => {
  it('round-trips a cheat targeting a captured pointer', () => {
    saveCheat('valheim.exe', {
      id: 'stamina',
      name: 'Stamina',
      dataType: 'float',
      mode: 'freeze',
      targets: [{ kind: 'anchor', patchId: 'patch-player', offset: '0x818' }],
      value: 350
    })
    const cheat = loadCheats('valheim.exe').find((c) => c.id === 'stamina') as CheatDefinition
    const target = cheat.targets[0]
    expect(isAnchorTarget(target)).toBe(true)
    if (isAnchorTarget(target)) {
      expect(target.patchId).toBe('patch-player')
      expect(target.offset).toBe('0x818')
    }
  })
})

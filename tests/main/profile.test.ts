import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setGamesDir, loadCheats, saveCheat } from '../../src/main/store'
import {
  loadProfile,
  saveProfile,
  recordModuleFingerprint,
  verifiedModules,
  fingerprintOf
} from '../../src/main/profile'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-profile-'))
  setGamesDir(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// The exact shape of the repo's real games/valheim.json, which must keep
// loading and arming unchanged — that file is a bare array with one guard
// patch and no schema key at all.
const LEGACY = JSON.stringify([
  {
    kind: 'patch',
    mode: 'guard',
    id: 'patch-h3',
    name: 'H3',
    originalBytes: 'f30f1128',
    length: 4,
    signature: '48 8b 47 18 f3 0f 11 28',
    signatureOffset: 4,
    moduleName: null,
    moduleOffset: null,
    baseRegister: 'rax',
    armValue: '0x1c91216cd50'
  }
])

describe('profile', () => {
  it('reads a bare array as schema 1 with no fingerprints', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), LEGACY)
    const profile = loadProfile('valheim')
    expect(profile.schema).toBe(2)
    expect(profile.exe).toBe('valheim')
    expect(profile.modules).toEqual({})
    expect(profile.cheats).toHaveLength(1)
    expect(profile.cheats[0].id).toBe('patch-h3')
  })

  it('leaves a legacy file on disk untouched until something is saved', () => {
    const file = path.join(dir, 'valheim.json')
    fs.writeFileSync(file, LEGACY)
    loadProfile('valheim')
    expect(fs.readFileSync(file, 'utf-8')).toBe(LEGACY)
  })

  it('migrates a legacy file to schema 2 on the next save', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), LEGACY)
    saveCheat('valheim', {
      kind: 'patch',
      id: 'second',
      name: 'Second',
      originalBytes: '9090',
      length: 2,
      signature: '90 90',
      moduleName: null,
      moduleOffset: null
    })
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'valheim.json'), 'utf-8'))
    expect(raw.schema).toBe(2)
    expect(raw.cheats).toHaveLength(2)
    expect(loadCheats('valheim')).toHaveLength(2)
  })

  it('round-trips a schema 2 profile with fingerprints', () => {
    saveProfile('game', {
      schema: 2,
      exe: 'game',
      modules: { 'GameAssembly.dll': { size: 100, timestamp: 200, version: '1.0.0.0' } },
      cheats: []
    })
    const back = loadProfile('game')
    expect(back.modules['GameAssembly.dll']).toEqual({ size: 100, timestamp: 200, version: '1.0.0.0' })
  })

  it('records a fingerprint without disturbing the cheats', () => {
    fs.writeFileSync(path.join(dir, 'valheim.json'), LEGACY)
    recordModuleFingerprint('valheim', 'GameAssembly.dll', { size: 1, timestamp: 2, version: null })
    const back = loadProfile('valheim')
    expect(back.modules['GameAssembly.dll']).toEqual({ size: 1, timestamp: 2, version: null })
    expect(back.cheats).toHaveLength(1)
  })

  it('missing file is an empty profile, not an error', () => {
    expect(loadProfile('never-seen').cheats).toEqual([])
  })

  it('still throws rather than overwriting an unparseable file', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json')
    expect(() => loadProfile('broken')).toThrow(/isn't valid JSON/)
  })

  it('rejects a schema 2 file whose cheats key is not an array', () => {
    fs.writeFileSync(path.join(dir, 'weird.json'), JSON.stringify({ schema: 2, exe: 'weird', modules: {}, cheats: 'nope' }))
    expect(() => loadProfile('weird')).toThrow()
  })

  it('an empty file is the same as no file', () => {
    fs.writeFileSync(path.join(dir, 'empty.json'), '')
    expect(loadProfile('empty').cheats).toEqual([])
  })
})

describe('verifiedModules', () => {
  const profile = {
    schema: 2 as const,
    exe: 'game',
    modules: {
      'GameAssembly.dll': { size: 100, timestamp: 200, version: null },
      'UnityPlayer.dll': { size: 300, timestamp: 400, version: null }
    },
    cheats: []
  }

  it('verifies a module whose size and timestamp both match', () => {
    const v = verifiedModules(profile, [{ name: 'GameAssembly.dll', size: 100, timestamp: 200 }])
    expect(v.has('GameAssembly.dll')).toBe(true)
  })

  it('does not verify a module whose size changed', () => {
    const v = verifiedModules(profile, [{ name: 'GameAssembly.dll', size: 101, timestamp: 200 }])
    expect(v.has('GameAssembly.dll')).toBe(false)
  })

  it('does not verify a module whose timestamp changed', () => {
    const v = verifiedModules(profile, [{ name: 'GameAssembly.dll', size: 100, timestamp: 999 }])
    expect(v.has('GameAssembly.dll')).toBe(false)
  })

  it('does not verify a module that is not loaded', () => {
    const v = verifiedModules(profile, [])
    expect(v.size).toBe(0)
  })

  it('does not verify a loaded module the profile has never seen', () => {
    const v = verifiedModules(profile, [{ name: 'other.dll', size: 1, timestamp: 2 }])
    expect(v.has('other.dll')).toBe(false)
  })

  it('matches module names case-insensitively', () => {
    const v = verifiedModules(profile, [{ name: 'gameassembly.dll', size: 100, timestamp: 200 }])
    expect(v.has('GameAssembly.dll')).toBe(true)
  })
})

describe('fingerprintOf', () => {
  const live = [
    { name: 'game.dll', size: 0x8000, timestamp: 12345, version: '1.2.3.4' },
    { name: 'other.dll', size: 0x1000, timestamp: 999, version: null }
  ]

  it('extracts the fingerprint of a named module', () => {
    expect(fingerprintOf(live, 'game.dll')).toEqual({
      size: 0x8000,
      timestamp: 12345,
      version: '1.2.3.4'
    })
  })

  it('matches the name case-insensitively', () => {
    expect(fingerprintOf(live, 'GAME.DLL')?.size).toBe(0x8000)
  })

  it('returns null for a module that is not loaded', () => {
    expect(fingerprintOf(live, 'missing.dll')).toBeNull()
  })

  it('returns null for a patch with no module', () => {
    expect(fingerprintOf(live, null)).toBeNull()
  })
})

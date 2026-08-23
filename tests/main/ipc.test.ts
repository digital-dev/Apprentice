import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  littleEndianToBigInt,
  hasProfile,
  buildModuleContext,
  applyRelearn,
  checkTableSize,
  MAX_TABLE_BYTES
} from '../../src/main/ipc'
import { setGamesDir } from '../../src/main/store'
import type { GameProfile } from '../../src/main/profile'
import type { PatchCheat } from '../../src/main/store'

// The captured pointer slot holds a raw little-endian 8-byte blob. This is
// the one place a silent, plausible-looking error can hide: parsing the hex
// string directly (big-endian) yields a different, still-valid-looking
// address instead of a visible failure, so the byte-reversal is worth
// pinning down with a worked example independent of any live process.
describe('littleEndianToBigInt', () => {
  it('reverses byte pairs before parsing, not the raw string', () => {
    // Bytes on the wire: 08 07 06 05 04 03 02 01 (little-endian) represent
    // the address 0x0102030405060708.
    expect(littleEndianToBigInt('0807060504030201')).toBe(0x0102030405060708n)
  })

  it('treats an all-zero slot as the numeric value zero', () => {
    expect(littleEndianToBigInt('0000000000000000')).toBe(0n)
  })

  it('round-trips a single non-zero low byte', () => {
    // Little-endian bytes 01 00 00 00 00 00 00 00 -> value 0x01.
    expect(littleEndianToBigInt('0100000000000000')).toBe(0x01n)
  })
})

// hasProfile is wired straight into ProcessWatcher's WatcherDeps, polled
// against every running process every couple of seconds. loadProfile
// deliberately throws on a malformed games/*.json (a correct property for
// the save path); hasProfile must swallow that rather than let it escape
// and crash the watcher's setInterval callback.
// ct:import's local-file-picker path used to have no size cap at all — a
// hostile/corrupt oversized .CT file read straight off disk reached the
// parser unbounded.
// checkTableSize is the pure logic ipc.ts's ct:import handler now runs
// against fs.statSync's result before ever reading the file.
describe('checkTableSize', () => {
  it('allows a file at or under the cap', () => {
    expect(checkTableSize(MAX_TABLE_BYTES)).toBeNull()
    expect(checkTableSize(1024)).toBeNull()
  })

  it('rejects a file over the cap with a descriptive error', () => {
    const oversized = MAX_TABLE_BYTES + 1
    const error = checkTableSize(oversized)
    expect(error).not.toBeNull()
    expect(error).toContain(String(oversized))
    expect(error).toContain(String(MAX_TABLE_BYTES))
  })
})

describe('hasProfile', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-ipc-'))
    setGamesDir(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is false when no profile file exists', () => {
    expect(hasProfile('nogame')).toBe(false)
  })

  it('is true for a profile with at least one cheat', () => {
    fs.writeFileSync(
      path.join(dir, 'valheim.json'),
      JSON.stringify({ schema: 2, exe: 'valheim', modules: {}, cheats: [{ id: 'a' }] })
    )
    expect(hasProfile('valheim')).toBe(true)
  })

  it('is false, not throwing, for a corrupt profile file', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json')
    expect(() => hasProfile('broken')).not.toThrow()
    expect(hasProfile('broken')).toBe(false)
  })
})

// The map/set passed into patchEngine.setAnchorContext, and the
// changedModules list isVerified compares against, must all agree on
// lowercase keys — a live-reported module name that differs only in case
// from what's stored (or from run to run) must still resolve, matching
// profile.ts's verifiedModules, which already compares case-insensitively.
describe('buildModuleContext', () => {
  function profile(modules: GameProfile['modules']): GameProfile {
    return { schema: 2, exe: 'game', modules, cheats: [] }
  }

  it('keys the module map lowercase regardless of live casing', () => {
    const live = [{ name: 'GameAssembly.dll', base: '0x1000', size: 0x2000, timestamp: 111 }]
    const { modules } = buildModuleContext(profile({}), live)
    expect(modules.has('gameassembly.dll')).toBe(true)
    expect(modules.get('gameassembly.dll')?.name).toBe('GameAssembly.dll')
  })

  it('verifies a module whose stored casing differs from the live casing', () => {
    const live = [{ name: 'GameAssembly.dll', base: '0x1000', size: 0x2000, timestamp: 111 }]
    const p = profile({ 'gameassembly.dll': { size: 0x2000, timestamp: 111, version: null } })
    const { verified, changedModules } = buildModuleContext(p, live)
    expect(verified.has('gameassembly.dll')).toBe(true)
    expect(changedModules).toHaveLength(0)
  })

  it('flags a module whose fingerprint no longer matches, case-insensitively', () => {
    const live = [{ name: 'GameAssembly.dll', base: '0x1000', size: 0x2000, timestamp: 999 }]
    const p = profile({ 'GameAssembly.dll': { size: 0x2000, timestamp: 111, version: null } })
    const { verified, changedModules } = buildModuleContext(p, live)
    expect(verified.has('gameassembly.dll')).toBe(false)
    expect(changedModules).toEqual(['gameassembly.dll'])
  })
})

// Relearning only fires when the fingerprint didn't match, but a scan found
// the code anyway. If the fingerprint isn't updated too, the next launch
// hits the same mismatch and re-scans forever instead of using the fast
// arithmetic path — applyRelearn's job (persisting the new offset) is
// tested here; the fingerprint re-record itself happens in the onRelearn
// wiring right after, using the same recordModuleFingerprint/fingerprintOf
// helpers saveCheatWithFingerprint already relies on.
describe('applyRelearn', () => {
  function patch(overrides: Partial<PatchCheat> = {}): PatchCheat {
    return {
      kind: 'patch',
      mode: 'nop',
      id: 'p1',
      name: 'test',
      originalBytes: '90',
      length: 1,
      signature: '90',
      moduleName: 'game.exe',
      moduleOffset: '0x100',
      ...overrides
    }
  }

  it('updates moduleOffset on the matching patch cheat', () => {
    const p = patch()
    const profile: GameProfile = { schema: 2, exe: 'game', modules: {}, cheats: [p] }
    const result = applyRelearn(profile, 'p1', '0x200')
    expect(result?.moduleOffset).toBe('0x200')
    expect(profile.cheats[0]).toBe(result)
  })

  it('returns null for an unknown patch id', () => {
    const profile: GameProfile = { schema: 2, exe: 'game', modules: {}, cheats: [patch()] }
    expect(applyRelearn(profile, 'missing', '0x200')).toBeNull()
  })

  it('returns null for a non-patch cheat id (defensive — ids should not collide)', () => {
    const valueCheat = { id: 'p1', name: 'v', dataType: 'int32', mode: 'freeze', targets: [], value: 1 } as never
    const profile: GameProfile = { schema: 2, exe: 'game', modules: {}, cheats: [valueCheat] }
    expect(applyRelearn(profile, 'p1', '0x200')).toBeNull()
  })
})

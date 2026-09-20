import { describe, it, expect } from 'vitest'
import { exeStem, gameForExe, gamePageState, type LibraryGame } from '../../src/renderer/src/library'

const g = (over: Partial<LibraryGame> = {}): LibraryGame => ({
  appId: '1',
  name: 'Schedule I',
  exe: 'Schedule I',
  cheatCount: 26,
  running: false,
  ...over
})

describe('exeStem', () => {
  it('drops .exe and ignores case', () => {
    expect(exeStem('Schedule I.exe')).toBe('schedule i')
    expect(exeStem('VALHEIM')).toBe('valheim')
  })
})

describe('gameForExe', () => {
  const games = [g(), g({ appId: '2', name: 'Valheim', exe: 'valheim' }), g({ appId: '3', name: 'Other', exe: null })]

  it('finds the game whose profile is named for the process', () => {
    expect(gameForExe(games, 'Valheim.exe')?.appId).toBe('2')
    expect(gameForExe(games, 'schedule i.exe')?.appId).toBe('1')
  })

  it('returns null for an unknown process or no process', () => {
    expect(gameForExe(games, 'notepad.exe')).toBeNull()
    expect(gameForExe(games, null)).toBeNull()
  })
})

describe('gamePageState', () => {
  it('is attached when the attached process is this game', () => {
    expect(gamePageState(g({ running: true }), 'Schedule I.exe')).toBe('attached')
  })

  it('is attach when the game is running but something else (or nothing) is attached', () => {
    expect(gamePageState(g({ running: true }), null)).toBe('attach')
    expect(gamePageState(g({ running: true }), 'Valheim.exe')).toBe('attach')
  })

  it('is waiting when the game has cheats but is not running', () => {
    expect(gamePageState(g({ running: false }), null)).toBe('waiting')
  })

  it('stays waiting for a game that is not running even while another game is attached', () => {
    expect(gamePageState(g({ running: false }), 'Valheim.exe')).toBe('waiting')
  })

  it('is unsupported when there is no profile, running or not', () => {
    expect(gamePageState(g({ exe: null, cheatCount: 0 }), null)).toBe('unsupported')
    expect(gamePageState(g({ exe: null, cheatCount: 0, running: true }), 'x.exe')).toBe('unsupported')
  })
})

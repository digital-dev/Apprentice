import type { DataType } from '../cheatVerify'

// Knowledge for native (non-Unity, no reflection) games. There is no class or
// field metadata to enumerate, so what the factory needs from a human once per
// game is: a signature for each static root (a `mov reg,[rip+rel32]` that loads
// the manager pointer) and the offset chain from that root to each stat. The
// signature keeps the roots build-independent; the chains change only when the
// game rearranges its structs.

export interface NativeRoot {
  id: string
  // Must match exactly once in the main module.
  signature: string
  // Bytes from the match start to the rel32 operand, and to the next instruction.
  rel32At: number
  instrLen: number
}

export interface NativeCheat {
  category: string
  root: string
  // Every chain is a target of the one cheat (e.g. current and max health).
  chains: string[][]
  dataType: DataType
  mode: 'freeze' | 'oneshot'
  value: number
  plausible: [number, number]
  lookFor: string
  offValue?: number
}

export interface NativeGame {
  id: string
  name: string
  roots: NativeRoot[]
  cheats: NativeCheat[]
}

const ER_WORLD_CHR_MAN: NativeRoot = {
  id: 'WorldChrMan',
  signature: '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 0F 48 39 88',
  rel32At: 3,
  instrLen: 7
}

const ER_GAME_DATA_MAN: NativeRoot = {
  id: 'GameDataMan',
  signature: '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 05 48 8B 40 58 C3 C3',
  rel32At: 3,
  instrLen: 7
}

// WorldChrMan -> +0x10EF8 (player) -> +0 -> +0x190 (module bag) -> +0 (stats).
const ER_STATS = ['0x10ef8', '0x0', '0x190', '0x0']
const stat = (offset: string): string[] => [...ER_STATS, offset]

export const NATIVE_GAMES: NativeGame[] = [
  {
    id: 'elden-ring',
    name: 'Elden Ring',
    roots: [ER_WORLD_CHR_MAN, ER_GAME_DATA_MAN],
    cheats: [
      {
        category: 'health',
        root: 'WorldChrMan',
        chains: [stat('0x138'), stat('0x144')], // current, max
        dataType: 'int32',
        mode: 'freeze',
        value: 9999,
        plausible: [1, 100000],
        lookFor: 'Take damage: the health bar stays full.'
      },
      {
        category: 'mana',
        root: 'WorldChrMan',
        chains: [stat('0x148'), stat('0x150')], // FP current, max
        dataType: 'int32',
        mode: 'freeze',
        value: 999,
        plausible: [0, 100000],
        lookFor: 'Cast spells: FP never drains.'
      },
      {
        category: 'stamina',
        root: 'WorldChrMan',
        chains: [stat('0x154'), stat('0x15c')], // current, max
        dataType: 'int32',
        mode: 'freeze',
        value: 999,
        plausible: [0, 100000],
        lookFor: 'Sprint and attack repeatedly: stamina never drains.'
      },
      {
        category: 'money',
        root: 'GameDataMan',
        chains: [['0x8', '0x6c']], // runes
        dataType: 'int32',
        mode: 'freeze',
        value: 999999999,
        plausible: [0, 999999999],
        lookFor: 'The rune count on the HUD jumps to the frozen value.'
      }
    ]
  }
]

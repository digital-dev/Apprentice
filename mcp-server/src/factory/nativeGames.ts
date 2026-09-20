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
  // A root the game may lose in an update without being a different game: its
  // cheats come back unresolved, but the game is still recognised.
  optional?: boolean
}

export interface NativeCheat {
  category: string
  // Shown in the draft; falls back to the shared category's label.
  name?: string
  root: string
  // Every chain is a target of the one cheat (e.g. current and max health).
  chains: string[][]
  dataType: DataType
  // Which bit of the byte the cheat owns (flag words), else the whole value.
  bitIndex?: number
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

// Each flag byte is read by the game in a few places; the signature is the
// first such read, wildcarded, grown until it is unique (mcp-server/scripts/deriveFlagRoot.js).
// Being a movzx r32,[rip+rel32] the operand sits at +3 of a 7-byte instruction.
const flagRoot = (id: string, signature: string): NativeRoot => ({ id, signature, rel32At: 3, instrLen: 7, optional: true })

const ER_FLAG_ONE_SHOT = flagRoot('flag-one-shot', '0f b6 0d ?? ?? ?? ?? e9 ?? ?? ?? ?? 48 8d 4d 98')
const ER_FLAG_NO_AMMO = flagRoot(
  'flag-no-ammo',
  '0f b6 0d ?? ?? ?? ?? e9 ?? ?? ?? ?? 40 57 48 83 ec 30 48 c7 44 24 20 fe ff ff ff 48 89 5c 24 40 48 89 6c 24 48 48 89 74 24 50 49 8b d9'
)
const ER_FLAG_NO_GOODS = flagRoot('flag-no-goods', '0f b6 0d ?? ?? ?? ?? e9 ?? ?? ?? ?? e8 ?? ?? ?? ?? 90 e9 ?? ?? ?? ?? 90 49 8d 77 30')
const ER_FLAG_NO_ASH_COST = flagRoot('flag-no-ash-cost', '0f b6 0d ?? ?? ?? ?? e9 ?? ?? ?? ?? eb 89')

// WorldChrMan -> +0x10EF8 (player) -> +0 -> +0x190 (module bag) -> +0 (stats).
const ER_STATS = ['0x10ef8', '0x0', '0x190', '0x0']
const stat = (offset: string): string[] => [...ER_STATS, offset]

export const NATIVE_GAMES: NativeGame[] = [
  {
    id: 'elden-ring',
    name: 'Elden Ring',
    roots: [ER_WORLD_CHR_MAN, ER_GAME_DATA_MAN, ER_FLAG_ONE_SHOT, ER_FLAG_NO_AMMO, ER_FLAG_NO_ASH_COST, ER_FLAG_NO_GOODS],
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
      },
      {
        category: 'nofpcost',
        name: 'No FP Consumption',
        root: 'WorldChrMan',
        chains: [stat('0x19b')],
        dataType: 'int8',
        bitIndex: 2,
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        lookFor: 'Cast a spell: FP does not drop.'
      },
      {
        category: 'nostaminacost',
        name: 'No Stamina Consumption',
        root: 'WorldChrMan',
        chains: [stat('0x19b')],
        dataType: 'int8',
        bitIndex: 3,
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        lookFor: 'Sprint and attack: the stamina bar does not drain.'
      },
      {
        category: 'nodamage',
        name: 'No Damage (immunity)',
        root: 'WorldChrMan',
        chains: [stat('0x19b')],
        dataType: 'int8',
        bitIndex: 1,
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        // Static analysis only. The getter for this bit (test [ChrData+0x19b],2 || debug flag ab)
        // guards the damage-application routine at RVA 0x44845a: when true it skips the HP arithmetic.
        lookFor: 'Inferred from code, not run in-game: enemy hits stop reducing HP.'
      },
      {
        category: 'nogoods',
        name: 'No Item Consumption',
        root: 'flag-no-goods',
        chains: [[]],
        dataType: 'int8',
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        // Static analysis only. Debug flag a3 sits between exterminate (a2) and stamina (a4) in the
        // engine's usual debug-flag order, and is passed as the "don't consume" argument of the
        // item-use routine at RVA 0x653367.
        lookFor: 'Inferred from code and flag order, not run in-game: using a consumable does not use it up.'
      },
      {
        category: 'oneshot',
        name: 'One-Shot Kill',
        root: 'flag-one-shot',
        chains: [[]],
        dataType: 'int8',
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        lookFor: 'Hit an enemy once: it dies.'
      },
      {
        category: 'noammo',
        name: 'No Arrow/Ammo Consumption',
        root: 'flag-no-ammo',
        chains: [[]],
        dataType: 'int8',
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        lookFor: 'Fire a bow: the ammo count does not drop.'
      },
      {
        category: 'noashcost',
        name: 'No Ash of War FP Cost',
        root: 'flag-no-ash-cost',
        chains: [[]],
        dataType: 'int8',
        mode: 'freeze',
        value: 1,
        plausible: [0, 255],
        offValue: 0,
        lookFor: 'Use a weapon skill: FP does not drop.'
      }
    ]
  }
]

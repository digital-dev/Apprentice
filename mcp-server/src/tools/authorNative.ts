import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { NATIVE_GAMES } from '../factory/nativeGames'
import { buildNativeFactory, resolveRoot, type NativeOps } from '../factory/nativeBuild'
import { writeDraft, type ProfileModules } from '../factory/draftFile'

// Native (non-Unity) path of author_cheats: known games only. Finds the game
// whose every root signature resolves, verifies each chain live, and writes the
// draft profile. Reads memory only.
export async function authorNative(args: { handle: number; wishlist: string[]; profilePath: string }) {
  const { handle } = args
  const modules = addon.listModules(handle)
  const main = modules[0]
  const moduleEnd = '0x' + (BigInt(main.base) + BigInt(main.size)).toString(16)
  const ops: NativeOps = {
    scanAob: (signature) => addon.scanAob(handle, signature, main.base, moduleEnd),
    readBytes: (address, length) => addon.tryReadBytes(handle, address, length),
    readValue: (base, offsets, dataType) => addon.tryReadValue(handle, base, offsets, dataType)
  }

  let game = null
  for (const candidate of NATIVE_GAMES) {
    const resolved = await Promise.all(candidate.roots.map((r) => resolveRoot(r, ops, main)))
    if (resolved.every((r) => r.ok)) {
      game = candidate
      break
    }
  }
  if (game === null) {
    return err(
      `no known native game matched ${main.name} (known: ${NATIVE_GAMES.map((g) => g.id).join(', ')}). ` +
        'Add its root signatures and offset chains to src/factory/nativeGames.ts; see the authoring-tamper-cheats skill.'
    )
  }

  const result = await buildNativeFactory(args.wishlist, game, ops, main)
  let draftPath: string | null = null
  if (result.drafts.length > 0) {
    const profileModules: ProfileModules = {
      [main.name]: { size: main.size, timestamp: main.timestamp, version: main.version }
    }
    draftPath = writeDraft(args.profilePath, result.drafts, profileModules)
  }
  return ok({ engine: 'native', game: game.id, draftPath, ...result })
}

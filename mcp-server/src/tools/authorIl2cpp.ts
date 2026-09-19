import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { CATEGORIES } from '../factory/categories'
import { findClassTable, type BootstrapCall, type BootstrapOps } from '../factory/il2cppBootstrap'
import { enumerateIl2cpp } from '../factory/il2cppEnumerator'
import { chooseHookSite, type HookOps } from '../factory/hookSite'
import { buildIl2cppFactory } from '../factory/il2cppBuild'
import { writeDraft, type ProfileModules } from '../factory/draftFile'
import { toHex } from '../factory/il2cppLayout'

const EXPORTS: Record<BootstrapCall, string> = {
  domain_get: 'il2cpp_domain_get',
  assembly_open: 'il2cpp_domain_assembly_open',
  assembly_get_image: 'il2cpp_assembly_get_image',
  image_class_count: 'il2cpp_image_get_class_count',
  image_get_class: 'il2cpp_image_get_class'
}

const GAME_ASSEMBLY = 'GameAssembly.dll'
const PROFILE_MODULES = new Set([GAME_ASSEMBLY.toLowerCase(), 'unityplayer.dll'])

// Unity/IL2CPP path of author_cheats. Native effects are limited to a few
// il2cpp_* calls through one scratch buffer (see il2cppBootstrap.ts) and
// then memory reads; the only file written is the draft profile.
export async function authorIl2cpp(
  args: { handle: number; wishlist: string[]; profilePath: string },
  gameAssemblyBase: string
) {
  const { handle } = args
  const modules = addon.listModules(handle)
  const gameAssembly = modules.find((m) => m.name.toLowerCase() === GAME_ASSEMBLY.toLowerCase())
  if (gameAssembly === undefined) return err(`${GAME_ASSEMBLY} is not loaded in the target`)

  const addresses = {} as Record<BootstrapCall, string>
  for (const [key, exportName] of Object.entries(EXPORTS) as [BootstrapCall, string][]) {
    const address = addon.resolveExport(handle, gameAssemblyBase, exportName)
    if (address === null) return err(`${GAME_ASSEMBLY} does not export ${exportName}; cannot enumerate this game`)
    addresses[key] = address
  }

  const wanted = CATEGORIES.filter((c) => args.wishlist.includes(c.id))
  if (wanted.length === 0) {
    return err(`no known category in the wishlist (known: ${CATEGORIES.map((c) => c.id).join(', ')})`)
  }

  const scratch = addon.allocateCave(handle, gameAssemblyBase)
  if (scratch === null) return err('could not allocate a scratch buffer in the target')

  try {
    const bootstrapOps: BootstrapOps = {
      call: (fn, callArgs) => addon.callRemoteFunction(handle, addresses[fn], callArgs),
      writeString: (text) => {
        const hex = Buffer.from(text + '\0', 'utf8').toString('hex')
        if (!addon.writeBytes(handle, scratch, hex)) throw new Error('scratch write failed')
        return scratch
      },
      scanQword: async (value) => (await addon.scanFirst(handle, 'int64', Number(value))).map((c) => c.address),
      readBytes: (address, length) => addon.tryReadBytes(handle, address, length)
    }

    const classPointers = await findClassTable(bootstrapOps)
    const readBytes = (address: string, length: number) => addon.tryReadBytes(handle, address, length)
    const enumeration = enumerateIl2cpp({ readBytes }, classPointers, wanted.flatMap((c) => c.classHints))
    if (enumeration.classesScanned === 0) {
      return err(`no class names matched the wishlist's hints among ${enumeration.classesTotal} classes`)
    }

    const moduleEnd = toHex(BigInt(gameAssembly.base) + BigInt(gameAssembly.size))
    const hookOps: HookOps = {
      readBytes,
      disasm: (hex, address) => addon.disassembleBuffer(Buffer.from(hex, 'hex'), address, 32),
      scanAob: (signature) => addon.scanAob(handle, signature, gameAssembly.base, moduleEnd)
    }
    const result = await buildIl2cppFactory(args.wishlist, enumeration, {
      moduleName: gameAssembly.name,
      readBytes,
      chooseHook: (methods) => chooseHookSite(methods, hookOps, { base: gameAssembly.base, size: gameAssembly.size })
    })

    let draftPath: string | null = null
    if (result.cheats.length > 0) {
      const profileModules: ProfileModules = {}
      for (const m of modules.filter((x) => PROFILE_MODULES.has(x.name.toLowerCase()))) {
        profileModules[m.name] = { size: m.size, timestamp: m.timestamp, version: m.version }
      }
      draftPath = writeDraft(args.profilePath, [...result.patches, ...result.cheats], profileModules)
    }

    return ok({
      engine: 'unity-il2cpp',
      draftPath,
      classesTotal: enumeration.classesTotal,
      classesScanned: enumeration.classesScanned,
      roots: enumeration.roots,
      skipped: enumeration.skipped,
      ...result
    })
  } catch (e) {
    return err(`IL2CPP enumeration failed: ${(e as Error).message}`)
  } finally {
    addon.freeMemory(handle, scratch)
  }
}

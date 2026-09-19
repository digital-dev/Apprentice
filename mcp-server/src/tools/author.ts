import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { classifyEngine } from '../engineFingerprint'
import { resolveMonoTargetAddress, buildTargetStatus } from '../cheatVerify'
import { CATEGORIES } from '../factory/categories'
import { enumerateMono, type MonoEnumOps } from '../factory/monoEnumerator'
import { buildFactory, type VerifyFn } from '../factory/build'
import { monoOpsFor } from './verify'

function enumOpsFor(handle: number, monoDllBase: string): MonoEnumOps {
  return {
    listAssemblyNames: () => addon.monoListAssemblyNames(handle, monoDllBase),
    listClassesInImage: (image) => addon.monoListClassesInImage(handle, monoDllBase, image),
    listFieldNames: (classHandle) => addon.monoListFieldNames(handle, monoDllBase, classHandle),
    staticFieldAddress: (classHandle, field) => addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, field),
    readBytes: (address, length) => addon.tryReadBytes(handle, address, length)
  }
}

function draftPathFor(profilePath: string): string {
  return profilePath.replace(/\.json$/i, '') + '.draft.json'
}

function exeFor(profilePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as { exe?: string }
    if (typeof parsed.exe === 'string') return parsed.exe
  } catch {
    // no readable profile yet -- fall through to the filename
  }
  return path.basename(profilePath).replace(/\.json$/i, '')
}

export function registerAuthorTools(server: McpServer): void {
  server.registerTool(
    'author_cheats',
    {
      description:
        `Unity/Mono only. Turn a wishlist of cheat categories (${CATEGORIES.map((c) => c.id).join(', ')}) into draft, read-verified value cheats: enumerates Mono classes/fields, ranks them by name against each category, finds the live singleton root (e.g. Player.m_localPlayer -- the player must be in a world), tries each candidate through the real pointer chain, and keeps the first whose live value is plausible. Writes drafts to <profile>.draft.json (never the live profile, never game memory) and returns a checklist to confirm in-game. Landmine categories (hunger, speed) come back under "manual" with the reason and no draft.`,
      inputSchema: {
        handle: z.number().int(),
        wishlist: z.array(z.string()).min(1),
        profilePath: z.string(),
        monoDllBase: z.string().optional()
      }
    },
    async (args: { handle: number; wishlist: string[]; profilePath: string; monoDllBase?: string }) => {
      const classification = classifyEngine(addon.listModules(args.handle))
      let monoDllBase = args.monoDllBase ?? null
      if (monoDllBase === null) {
        if (classification.engine !== 'unity-mono') {
          return err(
            `author_cheats supports Unity/Mono only (detected: ${classification.engine}). Run fingerprint_process for that engine's playbook.`
          )
        }
        monoDllBase = classification.monoDllBase
      }

      const wanted = CATEGORIES.filter((c) => args.wishlist.includes(c.id))
      const classHints = wanted.flatMap((c) => c.classHints)
      const enumeration = await enumerateMono(enumOpsFor(args.handle, monoDllBase), classHints)

      if (enumeration.roots.length === 0) {
        const dead = enumeration.deadRoots.map((r) => `${r.className}.${r.staticFieldName}`)
        return err(
          dead.length > 0
            ? `found singleton handle(s) ${dead.join(', ')} but they are null -- load into a save/world first, then retry`
            : `no singleton handle found on ${enumeration.classesScanned} scanned class(es); this game needs a manual root (see the authoring-tamper-cheats skill)`
        )
      }

      const handle = args.handle
      const base = monoDllBase
      const verify: VerifyFn = async (target, dataType, cheatValue) => {
        const address = await resolveMonoTargetAddress(target, handle, base, monoOpsFor(handle))
        return buildTargetStatus(
          address,
          (addr) => addon.tryReadValue(handle, addr, [], dataType),
          target,
          cheatValue,
          dataType
        )
      }

      const result = await buildFactory(args.wishlist, enumeration, verify)

      let draftPath: string | null = null
      if (result.drafts.length > 0) {
        draftPath = draftPathFor(args.profilePath)
        fs.writeFileSync(
          draftPath,
          JSON.stringify({ schema: 2, exe: exeFor(args.profilePath), modules: {}, cheats: result.drafts }, null, 2)
        )
      }

      return ok({
        roots: enumeration.roots,
        classesScanned: enumeration.classesScanned,
        draftPath,
        ...result
      })
    }
  )
}

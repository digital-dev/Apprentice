import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { chunkedRead } from '../factory/chunkedRead'
import type { BootstrapCall } from '../factory/il2cppBootstrap'
import { findLiveInstances, type LiveInstanceOps } from '../factory/liveInstances'
import { chasePointerFields } from '../factory/pointerChase'
import { findInjectedHooks } from '../factory/findHooks'

const GAME_ASSEMBLY = 'GameAssembly.dll'

const BOOTSTRAP_EXPORTS: Record<BootstrapCall, string> = {
  domain_get: 'il2cpp_domain_get',
  assembly_open: 'il2cpp_domain_assembly_open',
  assembly_get_image: 'il2cpp_assembly_get_image',
  image_class_count: 'il2cpp_image_get_class_count',
  image_get_class: 'il2cpp_image_get_class'
}

// Three tools promoted from ad hoc scratchpad scripts (engineInstances.js,
// chasePointers.js, findHooks.js — see il2cpp-engine-instance-discovery.md,
// the session memory these formalize) into the real, tested toolset, so the
// next obfuscated-IL2CPP game doesn't have to reinvent them from scratch.
export function registerIl2cppInvestigateTools(server: McpServer): void {
  server.registerTool(
    'find_live_instances',
    {
      description:
        'Find every LIVE instance of a UnityEngine.Object-derived IL2CPP class (a MonoBehaviour, ScriptableObject, ' +
        'Component, ...) by calling the engine\'s own UnityEngine.Object.FindObjectsOfType(Type) through the generic ' +
        'remote-call primitives — far more reliable than scanning the heap for the class pointer, which also matches ' +
        'hundreds of IL2CPP metadata self-references (MethodInfo.klass records, RGCTX tables) that read as garbage ' +
        "data. Returns [] (not an error) for a class Unity's object system doesn't track (a plain C# class/struct); " +
        'fall back to a different anchor (a known singleton field, or a capture patch on a method that touches it) for those.',
      inputSchema: { handle: z.number().int(), assemblyName: z.string(), className: z.string() }
    },
    async (args: { handle: number; assemblyName: string; className: string }) => {
      const { handle } = args
      const modules = addon.listModules(handle)
      const gameAssembly = modules.find((m) => m.name.toLowerCase() === GAME_ASSEMBLY.toLowerCase())
      if (gameAssembly === undefined) return err(`${GAME_ASSEMBLY} is not loaded in the target`)

      const addresses = {} as Record<BootstrapCall, string>
      for (const [key, exportName] of Object.entries(BOOTSTRAP_EXPORTS) as [BootstrapCall, string][]) {
        const address = addon.resolveExport(handle, gameAssembly.base, exportName)
        if (address === null) return err(`${GAME_ASSEMBLY} does not export ${exportName}; cannot enumerate this game`)
        addresses[key] = address
      }

      const scratch = addon.allocateCave(handle, gameAssembly.base)
      if (scratch === null) return err('could not allocate a scratch buffer in the target')

      try {
        const readBytes = (address: string, length: number) =>
          chunkedRead((a, n) => addon.tryReadBytes(handle, a, n), address, length)

        const ops: LiveInstanceOps = {
          call: (fn, callArgs) => addon.callRemoteFunction(handle, addresses[fn], callArgs),
          writeString: (text) => {
            const hex = Buffer.from(text + '\0', 'utf8').toString('hex')
            if (!addon.writeBytes(handle, scratch, hex)) throw new Error('scratch write failed')
            return scratch
          },
          scanQword: async (value: bigint) =>
            (await addon.scanFirst(handle, 'int64', Number(value))).map((c) => c.address),
          readBytes,
          resolveExport: (name) => addon.resolveExport(handle, gameAssembly.base, name),
          callRemote: (functionAddress, callArgs) => addon.callRemoteFunction(handle, functionAddress, callArgs)
        }

        const result = await findLiveInstances(ops, args.assemblyName, args.className)
        return 'error' in result ? err(result.error) : ok(result)
      } catch (e) {
        return err(`find_live_instances failed: ${(e as Error).message}`)
      } finally {
        addon.freeMemory(handle, scratch)
      }
    }
  )

  server.registerTool(
    'chase_pointer_fields',
    {
      description:
        'Chase one level of pointer-sized fields off a known object address, resolving each target\'s own IL2CPP class ' +
        'name (from the runtime\'s own metadata, not a guess) and scanning its first bytes for small integers in a ' +
        "given range (candidate enum values — a C# enum field often decodes as an opaque valuetype, not a plain int, " +
        'so this is usually the only way to spot one). Use this to identify what an unlabeled/obfuscated pointer field ' +
        'actually points at: a real class name on the resolved target is strong evidence, a garbage/unreadable name ' +
        'means that offset is not really a pointer (or the field layout assumption is wrong).',
      inputSchema: {
        handle: z.number().int(),
        baseAddress: z.string(),
        offsets: z.array(z.string()).min(1),
        scanBytes: z.number().int().optional(),
        intMin: z.number().int().optional(),
        intMax: z.number().int().optional()
      }
    },
    async (args: {
      handle: number
      baseAddress: string
      offsets: string[]
      scanBytes?: number
      intMin?: number
      intMax?: number
    }) => {
      const ops = { readBytes: (a: string, n: number) => addon.tryReadBytes(args.handle, a, n) }
      const result = chasePointerFields(ops, args.baseAddress, args.offsets, {
        scanBytes: args.scanBytes,
        intMin: args.intMin,
        intMax: args.intMax
      })
      return ok({ fields: result })
    }
  )

  server.registerTool(
    'find_injected_hooks',
    {
      description:
        'Disassemble a method body and flag any jmp/call whose target falls outside a given module\'s address range — ' +
        'a cheap, read-only way to spot an already-installed hook (your own capture patch, another trainer running ' +
        'concurrently, or unexpected code) before assuming a function is unmodified. moduleName/moduleBase/moduleSize ' +
        'default to the target\'s own GameAssembly.dll when omitted.',
      inputSchema: {
        handle: z.number().int(),
        address: z.string(),
        lengthBytes: z.number().int().positive(),
        moduleName: z.string().optional()
      }
    },
    async (args: { handle: number; address: string; lengthBytes: number; moduleName?: string }) => {
      const modules = addon.listModules(args.handle)
      const moduleName = args.moduleName ?? GAME_ASSEMBLY
      const mod = modules.find((m) => m.name.toLowerCase() === moduleName.toLowerCase())
      if (mod === undefined) return err(`${moduleName} is not loaded in the target`)

      const ops = {
        readBytes: (a: string, n: number) => addon.tryReadBytes(args.handle, a, n),
        disasm: (bufferHex: string, baseAddress: string, maxCount?: number) =>
          addon.disassembleBuffer(Buffer.from(bufferHex, 'hex'), baseAddress, maxCount)
      }
      const result = findInjectedHooks(ops, args.address, args.lengthBytes, mod.base, mod.size)
      return 'error' in result ? err(result.error) : ok({ hooks: result })
    }
  )
}

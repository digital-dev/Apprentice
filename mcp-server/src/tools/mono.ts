import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'

export function registerMonoTools(server: McpServer): void {
  server.registerTool(
    'mono_resolve_class',
    {
      description:
        'Resolve a MonoClass* by namespace + class name (e.g. namespace "" className "Player"). Returns a class handle for the other mono_* tools, or an error if not found.',
      inputSchema: {
        handle: z.number().int(),
        monoDllBase: z.string(),
        namespaceName: z.string(),
        className: z.string()
      }
    },
    async (args: { handle: number; monoDllBase: string; namespaceName: string; className: string }) => {
      const classHandle = await addon.monoResolveClass(
        args.handle,
        args.monoDllBase,
        args.namespaceName,
        args.className
      )
      return classHandle === null
        ? err(`class not found: ${args.namespaceName}.${args.className}`)
        : ok({ classHandle })
    }
  )

  server.registerTool(
    'mono_resolve_field',
    {
      description: 'Resolve an instance field\'s byte offset within a class, by class handle + field name.',
      inputSchema: {
        handle: z.number().int(),
        monoDllBase: z.string(),
        classHandle: z.string(),
        fieldName: z.string()
      }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string; fieldName: string }) => {
      const field = await addon.monoResolveField(args.handle, args.monoDllBase, args.classHandle, args.fieldName)
      return field === null ? err(`field not found: ${args.fieldName}`) : ok(field)
    }
  )

  server.registerTool(
    'mono_static_field_address',
    {
      description: 'Resolve a static field\'s live storage address, by class handle + field name.',
      inputSchema: {
        handle: z.number().int(),
        monoDllBase: z.string(),
        classHandle: z.string(),
        fieldName: z.string()
      }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string; fieldName: string }) => {
      const address = await addon.monoStaticFieldAddress(
        args.handle,
        args.monoDllBase,
        args.classHandle,
        args.fieldName
      )
      return address === null ? err(`static field not found: ${args.fieldName}`) : ok({ address })
    }
  )

  server.registerTool(
    'mono_list_field_names',
    {
      description: 'List every field name declared on a mono class, by class handle.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string(), classHandle: z.string() }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string }) =>
      ok(await addon.monoListFieldNames(args.handle, args.monoDllBase, args.classHandle))
  )

  server.registerTool(
    'mono_list_method_names',
    {
      description: 'List every method name declared on a mono class, by class handle.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string(), classHandle: z.string() }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string }) =>
      ok(await addon.monoListMethodNames(args.handle, args.monoDllBase, args.classHandle))
  )
}

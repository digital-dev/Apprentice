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

  server.registerTool(
    'mono_list_assemblies',
    {
      description:
        'List every loaded assembly\'s raw handle in a live process\'s Mono runtime. These handles are opaque — prefer mono_list_assembly_names, which pairs each one with a human-readable name.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string() }
    },
    async (args: { handle: number; monoDllBase: string }) =>
      ok(await addon.monoListAssemblies(args.handle, args.monoDllBase))
  )

  server.registerTool(
    'mono_list_assembly_names',
    {
      description:
        'List every loaded assembly in a live process\'s Mono runtime as (image handle, human-readable name) pairs — the starting point for class discovery when you don\'t already know an exact namespace/class name. Each result\'s `image` field is the `imageHandle` mono_list_classes_in_image needs to enumerate that assembly\'s classes.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string() }
    },
    async (args: { handle: number; monoDllBase: string }) =>
      ok(await addon.monoListAssemblyNames(args.handle, args.monoDllBase))
  )

  server.registerTool(
    'mono_list_classes_in_image',
    {
      description:
        'List every namespace/class name (plus each class\'s resolved handle) declared in one assembly image, by the `imageHandle` mono_list_assembly_names returns as its `image` field. Use this to discover class names in a live process without already knowing them; the returned classHandle can be used directly with mono_list_field_names/mono_list_method_names, skipping a separate mono_resolve_class call.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string(), imageHandle: z.string() }
    },
    async (args: { handle: number; monoDllBase: string; imageHandle: string }) =>
      ok(await addon.monoListClassesInImage(args.handle, args.monoDllBase, args.imageHandle))
  )
}

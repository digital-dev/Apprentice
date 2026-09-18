import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { decodeFName, walkProperties, resolveField, resolveClass, type FNamePoolConfig, type UObjectArrayConfig } from '../ueReflect'

const poolConfigSchema = z.object({
  gNamesBase: z.string(),
  blockOffsetBits: z.number().int(),
  nameEntryStride: z.number().int(),
  stringOffset: z.number().int(),
  headerOffset: z.number().int(),
  lengthShiftCount: z.number().int()
})

const arrayConfigSchema = z.object({
  chunksArrayBase: z.string(),
  numElementsPerChunk: z.number().int(),
  itemStride: z.number().int(),
  itemInitialOffset: z.number().int()
})

function readBytesFor(handle: number) {
  return (address: string, length: number) => addon.tryReadBytes(handle, address, length)
}

export function registerUeTools(server: McpServer): void {
  server.registerTool(
    'ue_decode_name',
    {
      description:
        "Decode a UE FName (by its comparisonIndex) to a string, given an already-calibrated GNames pool config -- see docs/superpowers/specs/2026-09-17-ue-reflection-decode-design.md for how to find that config's four numbers for a specific game (a one-time manual calibration, not automated here). Read-only.",
      inputSchema: { handle: z.number().int(), poolConfig: poolConfigSchema, comparisonIndex: z.number().int() }
    },
    (args: { handle: number; poolConfig: FNamePoolConfig; comparisonIndex: number }) => {
      const name = decodeFName(readBytesFor(args.handle), args.poolConfig, args.comparisonIndex)
      return name === null ? err(`could not decode FName ${args.comparisonIndex}`) : ok({ name })
    }
  )

  server.registerTool(
    'ue_list_field_names',
    {
      description:
        "List every FProperty name declared on a UStruct/UClass, by its address -- walks ChildProperties, decoding each name via the given GNames pool config. Read-only.",
      inputSchema: { handle: z.number().int(), poolConfig: poolConfigSchema, classAddress: z.string() }
    },
    (args: { handle: number; poolConfig: FNamePoolConfig; classAddress: string }) => {
      const readBytes = readBytesFor(args.handle)
      const entries = walkProperties(readBytes, args.classAddress)
      const names = entries.map((entry) => decodeFName(readBytes, args.poolConfig, entry.name.comparisonIndex))
      return ok({ names })
    }
  )

  server.registerTool(
    'ue_resolve_field',
    {
      description:
        "Resolve an FProperty's byte offset within a UStruct/UClass, by class address + field name. Read-only.",
      inputSchema: {
        handle: z.number().int(),
        poolConfig: poolConfigSchema,
        classAddress: z.string(),
        fieldName: z.string()
      }
    },
    (args: { handle: number; poolConfig: FNamePoolConfig; classAddress: string; fieldName: string }) => {
      const result = resolveField(readBytesFor(args.handle), args.poolConfig, args.classAddress, args.fieldName)
      return result === null ? err(`field not found: ${args.fieldName}`) : ok(result)
    }
  )

  server.registerTool(
    'ue_resolve_class',
    {
      description:
        "Resolve a UClass address by name, by walking GUObjectArray (given an already-calibrated array + GNames config -- see the design doc's calibration recipe). maxObjectsToScan is required, not defaulted: a misconfigured arrayConfig makes it easy to loop over a lot of memory harmlessly-but-uselessly. Read-only.",
      inputSchema: {
        handle: z.number().int(),
        arrayConfig: arrayConfigSchema,
        poolConfig: poolConfigSchema,
        className: z.string(),
        maxObjectsToScan: z.number().int()
      }
    },
    (args: {
      handle: number
      arrayConfig: UObjectArrayConfig
      poolConfig: FNamePoolConfig
      className: string
      maxObjectsToScan: number
    }) => {
      const classAddress = resolveClass(
        readBytesFor(args.handle),
        args.arrayConfig,
        args.poolConfig,
        args.className,
        args.maxObjectsToScan
      )
      return classAddress === null ? err(`class not found: ${args.className}`) : ok({ classAddress })
    }
  )
}

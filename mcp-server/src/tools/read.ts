import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import type { DataType } from '../addon'
import { ok, err } from '../toolResult'

const dataTypeSchema = z.enum(['int8', 'int16', 'int32', 'int64', 'float', 'double'])

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'read_bytes',
    {
      description: 'Read raw bytes at an address in an attached process. Returns unspaced lowercase hex.',
      inputSchema: { handle: z.number().int(), address: z.string(), length: z.number().int().positive() }
    },
    async ({ handle, address, length }: { handle: number; address: string; length: number }) => {
      const bytes = addon.tryReadBytes(handle, address, length)
      return bytes === null ? err(`unreadable: ${address}`) : ok(bytes)
    }
  )

  server.registerTool(
    'read_value',
    {
      description:
        'Read a typed value at a base address, optionally walking a pointer chain of hex offsets first.',
      inputSchema: {
        handle: z.number().int(),
        baseAddress: z.string(),
        offsets: z.array(z.string()),
        dataType: dataTypeSchema
      }
    },
    async (args: { handle: number; baseAddress: string; offsets: string[]; dataType: DataType }) => {
      const value = addon.tryReadValue(args.handle, args.baseAddress, args.offsets, args.dataType)
      return value === null ? err(`unreadable or unresolvable chain at: ${args.baseAddress}`) : ok({ value })
    }
  )
}

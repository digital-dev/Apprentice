import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import type { DataType } from '../addon'
import { ok } from '../toolResult'

const dataTypeSchema = z.enum(['int8', 'int16', 'int32', 'int64', 'float', 'double'])
const candidateSchema = z.object({ address: z.string(), value: z.number() })
const filterSchema = z.union([
  z.object({ mode: z.literal('exact'), value: z.number() }),
  z.object({ mode: z.enum(['changed', 'unchanged', 'increased', 'decreased']) })
])

export function registerScanTools(server: McpServer): void {
  server.registerTool(
    'scan_first',
    {
      description:
        'First-pass memory scan for a value of the given data type. Returns matching addresses. ' +
        'Optionally bounded to an address range (rangeStart/rangeEnd, same convention as scan_aob) — ' +
        'narrowing to a known module or heap segment avoids sweeping a whole process, which matters most ' +
        'on a GC-heavy Mono/Unity target where an unbounded sweep can return thousands of noise hits.',
      inputSchema: {
        handle: z.number().int(),
        dataType: dataTypeSchema,
        value: z.number(),
        rangeStart: z.string().optional(),
        rangeEnd: z.string().optional()
      }
    },
    async ({
      handle,
      dataType,
      value,
      rangeStart,
      rangeEnd
    }: {
      handle: number
      dataType: DataType
      value: number
      rangeStart?: string
      rangeEnd?: string
    }) => ok(await addon.scanFirst(handle, dataType, value, rangeStart, rangeEnd))
  )

  server.registerTool(
    'scan_next',
    {
      description:
        'Narrow a previous scan_first result set by an exact value or a relative change (changed/unchanged/increased/decreased).',
      inputSchema: {
        handle: z.number().int(),
        candidates: z.array(candidateSchema),
        dataType: dataTypeSchema,
        filter: filterSchema
      }
    },
    async (args: {
      handle: number
      candidates: { address: string; value: number }[]
      dataType: DataType
      filter: { mode: 'exact'; value: number } | { mode: 'changed' | 'unchanged' | 'increased' | 'decreased' }
    }) => ok(await addon.scanNext(args.handle, args.candidates, args.dataType, args.filter))
  )

  server.registerTool(
    'scan_aob',
    {
      description:
        'Scan for a byte-pattern signature (hex bytes with ?? wildcards, e.g. "48 8b ?? 10") across an attached process\'s memory, optionally bounded to an address range. Returns every matching address.',
      inputSchema: {
        handle: z.number().int(),
        signature: z.string(),
        rangeStart: z.string().optional(),
        rangeEnd: z.string().optional()
      }
    },
    async ({
      handle,
      signature,
      rangeStart,
      rangeEnd
    }: {
      handle: number
      signature: string
      rangeStart?: string
      rangeEnd?: string
    }) => ok(await addon.scanAob(handle, signature, rangeStart, rangeEnd))
  )
}

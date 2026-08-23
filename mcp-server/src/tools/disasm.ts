import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok } from '../toolResult'

export function registerDisasmTools(server: McpServer): void {
  server.registerTool(
    'disassemble_buffer',
    {
      description:
        'Disassemble a hex-encoded byte buffer as x86-64 instructions, without touching a live process — for inspecting bytes already fetched via read_bytes.',
      inputSchema: {
        bufferHex: z.string(),
        baseAddress: z.string(),
        maxCount: z.number().int().positive().optional()
      }
    },
    async ({
      bufferHex,
      baseAddress,
      maxCount
    }: {
      bufferHex: string
      baseAddress: string
      maxCount?: number
    }) => ok(addon.disassembleBuffer(Buffer.from(bufferHex, 'hex'), baseAddress, maxCount))
  )
}

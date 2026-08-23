import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'

// Buffer.from(str, 'hex') does NOT throw on invalid input — it silently
// stops at the first invalid character and returns only the valid prefix
// (e.g. Buffer.from('48 8b zz10', 'hex') returns just one byte, 0x48).
// scan_aob's own output convention is SPACED hex ("48 8b ?? 10" style
// signatures), while read_bytes returns UNSPACED hex — so this validates
// (accepting and stripping whitespace either way) rather than either
// rejecting spaces outright or silently truncating on a stray character.
const HEX_PATTERN = /^[0-9a-fA-F]*$/

export function registerDisasmTools(server: McpServer): void {
  server.registerTool(
    'disassemble_buffer',
    {
      description:
        'Disassemble a hex-encoded byte buffer as x86-64 instructions, without touching a live process — for inspecting bytes already fetched via read_bytes or scan_aob. bufferHex may be unspaced ("488b") or space-separated ("48 8b"), matching either tool\'s convention.',
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
    }) => {
      const stripped = bufferHex.replace(/\s+/g, '')
      if (!HEX_PATTERN.test(stripped) || stripped.length % 2 !== 0) {
        return err(
          'bufferHex must be an even-length hex string (spaces are stripped automatically, but every remaining character must be a hex digit)'
        )
      }
      return ok(addon.disassembleBuffer(Buffer.from(stripped, 'hex'), baseAddress, maxCount))
    }
  )
}

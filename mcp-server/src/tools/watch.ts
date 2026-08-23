import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'

export function registerWatchTools(server: McpServer): void {
  server.registerTool(
    'start_write_watch',
    {
      description:
        'Watch an address for writes and capture the instruction that performs them. ' +
        'EXCLUSIVE: only one debugger can attach to a process at a time (Windows ' +
        'DebugActiveProcess) — this fails if the Tamper app\'s own "find what writes" ' +
        'feature (or another instance of this tool) is already watching the same process.',
      inputSchema: { pid: z.number().int(), address: z.string() }
    },
    async ({ pid, address }: { pid: number; address: string }) => {
      try {
        addon.startWriteWatch(pid, address)
        return ok({ watching: true })
      } catch (e) {
        return err(`failed to start write-watch: ${(e as Error).message}`)
      }
    }
  )

  server.registerTool(
    'poll_write_watch',
    { description: 'Poll for instructions caught writing to the watched address since the last poll.' },
    async () => ok(addon.pollWriteWatch())
  )

  server.registerTool(
    'stop_write_watch',
    { description: 'Stop watching and detach the debugger, returning any final caught instructions.' },
    async () => ok(addon.stopWriteWatch())
  )
}

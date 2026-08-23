import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'

export function registerProcessTools(server: McpServer): void {
  server.registerTool(
    'list_processes',
    { description: 'List running processes (pid + name) on the local machine.' },
    async () => ok(addon.listProcesses())
  )

  server.registerTool(
    'attach',
    {
      description:
        'Attach to a process by pid for reading. Returns a handle to pass to every other tool, and the process\'s base address.',
      inputSchema: { pid: z.number().int() }
    },
    async ({ pid }: { pid: number }) => {
      try {
        return ok(addon.attach(pid))
      } catch (e) {
        return err(`failed to attach to pid ${pid}: ${(e as Error).message}`)
      }
    }
  )

  server.registerTool(
    'list_modules',
    {
      description: 'List every module (DLL/EXE) loaded in an attached process, with base address and size.',
      inputSchema: { handle: z.number().int() }
    },
    async ({ handle }: { handle: number }) => ok(addon.listModules(handle))
  )
}

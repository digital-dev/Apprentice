import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerProcessTools } from './tools/process'
import { registerScanTools } from './tools/scan'
import { registerMonoTools } from './tools/mono'
import { registerReadTools } from './tools/read'
import { registerDisasmTools } from './tools/disasm'
import { registerWatchTools } from './tools/watch'

export function createServer(): McpServer {
  const server = new McpServer({ name: 'game-memory', version: '0.1.0' })
  registerProcessTools(server)
  registerScanTools(server)
  registerMonoTools(server)
  registerReadTools(server)
  registerDisasmTools(server)
  registerWatchTools(server)
  return server
}

// @modelcontextprotocol/sdk is pinned to an exact version (see
// mcp-server/package.json) to work around a confirmed upstream
// TS2589/OOM regression at registerTool call sites in 1.23.0+ — see
// mcp-server/README.md's "Dependency notes" section before bumping it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerProcessTools } from './tools/process'
import { registerScanTools } from './tools/scan'
import { registerMonoTools } from './tools/mono'
import { registerReadTools } from './tools/read'
import { registerDisasmTools } from './tools/disasm'
import { registerWatchTools } from './tools/watch'
import { registerRemoteTools } from './tools/remote'
import { registerFingerprintTools } from './tools/fingerprint'
import { registerVerifyTools } from './tools/verify'
import { registerUeTools } from './tools/ue'
import { registerAuthorTools } from './tools/author'
import { registerIl2cppInvestigateTools } from './tools/il2cppInvestigate'

export function createServer(): McpServer {
  const server = new McpServer({ name: 'game-memory', version: '0.1.0' })
  registerProcessTools(server)
  registerScanTools(server)
  registerMonoTools(server)
  registerReadTools(server)
  registerDisasmTools(server)
  registerWatchTools(server)
  registerRemoteTools(server)
  registerFingerprintTools(server)
  registerVerifyTools(server)
  registerUeTools(server)
  registerAuthorTools(server)
  registerIl2cppInvestigateTools(server)
  return server
}

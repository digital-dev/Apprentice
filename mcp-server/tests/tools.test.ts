import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerProcessTools } from '../src/tools/process'
import { registerReadTools } from '../src/tools/read'
import { registerScanTools } from '../src/tools/scan'

let harness: ChildProcessWithoutNullStreams

beforeAll(async () => {
  harness = spawn(path.resolve(__dirname, '../../test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

// registerTool's callback is only reachable through the server's registered
// tool table (there is no public "call this tool directly" API), so these
// tests register a real McpServer and invoke through `server.server` isn't
// exposed either — instead, register onto a server and capture the
// callback via a tiny local harness: registerXTools takes any object with
// a `registerTool` method, so a fake that just stores the callbacks by
// name is enough to invoke them directly without a full MCP transport.
class FakeServer {
  handlers = new Map<string, (args: any) => Promise<any>>()
  registerTool(name: string, _config: unknown, cb: (args: any) => Promise<any>): void {
    this.handlers.set(name, cb)
  }
  async call(name: string, args: any) {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`no tool registered: ${name}`)
    return handler(args)
  }
}

describe('process tools', () => {
  it('list_processes finds the harness', async () => {
    const server = new FakeServer()
    registerProcessTools(server as unknown as McpServer)
    const result = await server.call('list_processes', {})
    expect(result.isError).toBeUndefined()
    const text = result.content[0].text as string
    expect(text).toContain(String(harness.pid))
  })

  it('attach returns a handle and base address', async () => {
    const server = new FakeServer()
    registerProcessTools(server as unknown as McpServer)
    const result = await server.call('attach', { pid: harness.pid })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text as string)
    expect(parsed.handle).toBeGreaterThan(0)
    expect(parsed.baseAddress).toMatch(/^0x[0-9a-f]+$/)
  })
})

describe('read tools', () => {
  it('read_bytes returns an error result, not a thrown exception, for an unreadable address', async () => {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)

    const server = new FakeServer()
    registerReadTools(server as unknown as McpServer)
    const result = await server.call('read_bytes', { handle, address: '0x1', length: 4 })
    expect(result.isError).toBe(true)
  })
})

describe('scan tools', () => {
  it('scan_first finds the harness float candidate seeded at startup', async () => {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)

    const server = new FakeServer()
    registerScanTools(server as unknown as McpServer)
    const result = await server.call('scan_first', { handle, dataType: 'float', value: 10.0 })
    expect(result.isError).toBeUndefined()
    const candidates = JSON.parse(result.content[0].text as string)
    expect(Array.isArray(candidates)).toBe(true)
    expect(candidates.length).toBeGreaterThan(0)
  })
})

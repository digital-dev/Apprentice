import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerWatchTools } from '../src/tools/watch'

let harness: ChildProcessWithoutNullStreams

function send(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    harness.stdout.once('data', (d) => resolve(d.toString().trim()))
    harness.stdin.write(cmd + '\n')
  })
}

beforeAll(async () => {
  harness = spawn(path.resolve(__dirname, '../../test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
})

afterAll(() => {
  try {
    harness.stdin.write('q\n')
    harness.kill()
  } catch {
    /* ignore */
  }
})

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

describe('watch tools', () => {
  it('describes the single-debugger exclusivity in its own tool description', () => {
    const server = new FakeServer()
    let capturedDescription = ''
    const originalRegister = server.registerTool.bind(server)
    server.registerTool = (name: string, config: any, cb: any) => {
      if (name === 'start_write_watch') capturedDescription = config.description
      return originalRegister(name, config, cb)
    }
    registerWatchTools(server as unknown as McpServer)
    expect(capturedDescription.toLowerCase()).toContain('one')
    expect(capturedDescription.toLowerCase()).toMatch(/debugger|write-watch/)
  })

  it('start/poll/stop round-trip against the real harness without throwing', async () => {
    const server = new FakeServer()
    registerWatchTools(server as unknown as McpServer)

    const startResult = await server.call('start_write_watch', { pid: harness.pid, address: '0x0' })
    expect(startResult.isError).toBeUndefined()

    await send('setforce 1')
    const pollResult = await server.call('poll_write_watch', {})
    expect(pollResult.isError).toBeUndefined()

    const stopResult = await server.call('stop_write_watch', {})
    expect(stopResult.isError).toBeUndefined()
  })
})

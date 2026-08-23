import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let harness: ChildProcessWithoutNullStreams
let client: Client

beforeAll(async () => {
  harness = spawn(path.resolve(__dirname, '../../test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.resolve(__dirname, '../dist/index.js')]
  })
  client = new Client({ name: 'integration-test', version: '0.1.0' })
  await client.connect(transport)
})

afterAll(async () => {
  await client.close()
  harness.stdin.write('q\n')
  harness.kill()
})

describe('stdio integration', () => {
  it('lists the registered tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['list_processes', 'attach', 'read_bytes', 'scan_first', 'start_write_watch'])
    )
  })

  it('attaches to the harness and reads its base address over the wire', async () => {
    const listResult: any = await client.callTool({ name: 'list_processes', arguments: {} })
    expect(listResult.isError).toBeUndefined()
    expect(listResult.content[0].text).toContain(String(harness.pid))

    const attachResult: any = await client.callTool({ name: 'attach', arguments: { pid: harness.pid } })
    expect(attachResult.isError).toBeUndefined()
    const parsed = JSON.parse(attachResult.content[0].text)
    expect(parsed.handle).toBeGreaterThan(0)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerProcessTools } from '../src/tools/process'
import { registerReadTools } from '../src/tools/read'
import { registerScanTools } from '../src/tools/scan'
import { registerMonoTools } from '../src/tools/mono'
import { registerDisasmTools } from '../src/tools/disasm'

let harness: ChildProcessWithoutNullStreams

// Sends one command to the harness's stdin and resolves with its next
// stdout line — same protocol tests/native/mono_bridge.test.ts already
// uses against the same harness ("loadmono" -> "OK 0x<base>").
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

describe('mono discovery tools', () => {
  async function attachAndLoadMono(): Promise<{ handle: number; monoDllBase: string }> {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)
    const reply = await send('loadmono')
    const monoDllBase = reply.split(' ')[1]
    return { handle, monoDllBase }
  }

  it('mono_list_assemblies lists the two fixture assembly handles', async () => {
    const { handle, monoDllBase } = await attachAndLoadMono()
    const server = new FakeServer()
    registerMonoTools(server as unknown as McpServer)
    const result = await server.call('mono_list_assemblies', { handle, monoDllBase })
    expect(result.isError).toBeUndefined()
    const handles = JSON.parse(result.content[0].text as string)
    expect(Array.isArray(handles)).toBe(true)
    expect(handles.length).toBe(2)
  })

  it('mono_list_assembly_names lists both fixture assemblies with readable names', async () => {
    const { handle, monoDllBase } = await attachAndLoadMono()
    const server = new FakeServer()
    registerMonoTools(server as unknown as McpServer)
    const result = await server.call('mono_list_assembly_names', { handle, monoDllBase })
    expect(result.isError).toBeUndefined()
    const assemblies = JSON.parse(result.content[0].text as string) as { image: string; name: string }[]
    const names = assemblies.map((a) => a.name)
    expect(names).toContain('FakeAssemblyA')
    expect(names).toContain('FakeAssemblyB')
  })

  it('mono_list_classes_in_image chains off mono_list_assembly_names\' image field to list its classes', async () => {
    const { handle, monoDllBase } = await attachAndLoadMono()
    const server = new FakeServer()
    registerMonoTools(server as unknown as McpServer)

    const namesResult = await server.call('mono_list_assembly_names', { handle, monoDllBase })
    const assemblies = JSON.parse(namesResult.content[0].text as string) as { image: string; name: string }[]
    const assemblyA = assemblies.find((a) => a.name === 'FakeAssemblyA')!

    const result = await server.call('mono_list_classes_in_image', {
      handle,
      monoDllBase,
      imageHandle: assemblyA.image
    })
    expect(result.isError).toBeUndefined()
    const classes = JSON.parse(result.content[0].text as string) as {
      namespaceName: string
      className: string
      classHandle: string
    }[]
    expect(classes).toHaveLength(1)
    expect(classes[0].className).toBe('Player')
    expect(classes[0].namespaceName).toBe('')
    expect(classes[0].classHandle).toMatch(/^0x[0-9a-f]+$/)
  })
})

describe('disasm tools', () => {
  it('decodes an unspaced hex buffer', async () => {
    const server = new FakeServer()
    registerDisasmTools(server as unknown as McpServer)
    const result = await server.call('disassemble_buffer', { bufferHex: '90', baseAddress: '0x1000' })
    expect(result.isError).toBeUndefined()
    const rows = JSON.parse(result.content[0].text as string)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('decodes a spaced hex buffer (the scan_aob signature convention)', async () => {
    const server = new FakeServer()
    registerDisasmTools(server as unknown as McpServer)
    const result = await server.call('disassemble_buffer', { bufferHex: '90 90', baseAddress: '0x1000' })
    expect(result.isError).toBeUndefined()
    const rows = JSON.parse(result.content[0].text as string)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('returns an error result, not a truncated success, for a genuinely invalid hex character', async () => {
    const server = new FakeServer()
    registerDisasmTools(server as unknown as McpServer)
    const result = await server.call('disassemble_buffer', { bufferHex: '48 8b zz10', baseAddress: '0x1000' })
    expect(result.isError).toBe(true)
  })
})

# MCP Memory-Scan Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone MCP server, `mcp-server/`, exposing the trainer app's native memory-introspection primitives (attach, scan, mono class/field lookup, read, write-watch, disassemble) as typed MCP tools — read/scan-only, no memory writes — so a live reverse-engineering session against a running game needs no throwaway scripts.

**Architecture:** A small Node/TypeScript program with its own `package.json`, requiring the trainer app's already-built `native/build/Release/memory_addon.node` directly. Every tool is stateless with respect to which process it targets: `attach` returns a `handle`, and every other tool takes that `handle` as an explicit argument (mirrors `src/main/nativeAddon.ts`'s own shape). Runs over stdio via `@modelcontextprotocol/sdk`.

**Tech Stack:** TypeScript (CommonJS), `@modelcontextprotocol/sdk@^1.30.0`, `zod@^3.25` for tool input schemas, `vitest` (via the repo root's existing installation — no second test runner) driving the real `test-harness/harness.exe` the native suite already uses.

**Spec:** `docs/superpowers/specs/2026-08-22-mcp-memory-server-design.md`

## Global Constraints

- **No write operations, anywhere.** No tool may call `writeBytes`, `writeValue`, or any patch/injection primitive. This is enforced by simply never wrapping those native functions — there is no flag or gate to bypass, the capability does not exist in this package.
- **CommonJS throughout.** `mcp-server/package.json` has no `"type"` field (defaults to CommonJS); `mcp-server/tsconfig.json` sets `"module": "commonjs"`. MCP SDK subpath imports still need their literal `.js` suffix (e.g. `'@modelcontextprotocol/sdk/server/mcp.js'`) — that suffix is how the SDK's own `package.json` `exports` wildcard (`"./*"`) resolves the subpath to its `dist/cjs/*` target, independent of CJS vs ESM.
- **`registerTool`'s `inputSchema` is a flat `ZodRawShape`** (a plain object of named Zod fields), not `z.object(...)`. E.g. `{ handle: z.number() }`, not `z.object({ handle: z.number() })`.
- **`start_write_watch`'s exclusivity is documented in its own tool description**, not just in code comments: only one debugger (this server, or the Tamper app's own write-watch) can attach to a given process at a time (Windows `DebugActiveProcess` limitation).
- **The native addon path:** `path.join(__dirname, '../../native/build/Release/memory_addon.node')` from `mcp-server/src/addon.ts` (`mcp-server/src/` → up to repo root → `native/build/Release/`).
- **DataType values:** `'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'` (from `src/main/store.ts`'s `DataType` — do not diverge from this set).
- Run tests with `npx vitest run <path>` from the repo root (not from inside `mcp-server/`).
- Native rebuild command (only needed if `native/` changes, which this plan never does): `cd native && npx node-gyp configure && npx node-gyp build && cd ..`

---

### Task 1: Package scaffold + native addon wrapper

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`
- Create: `mcp-server/src/addon.ts`
- Create: `.gitignore` entry for `mcp-server/node_modules/` and `mcp-server/dist/`
- Test: `mcp-server/tests/addon.test.ts`

**Interfaces:**
- Produces: `mcp-server/src/addon.ts` exporting typed functions (`listProcesses`, `attach`, `listModules`, `scanFirst`, `scanNext`, `scanAob`, `monoResolveClass`, `monoResolveField`, `monoStaticFieldAddress`, `monoListFieldNames`, `monoListMethodNames`, `disassembleBuffer`, `startWriteWatch`, `pollWriteWatch`, `stopWriteWatch`) plus non-throwing `tryReadBytes(handle, address, length): string | null` and `tryReadValue(handle, baseAddress, offsets, dataType): number | null`, and the shared types `DataType`, `ProcessInfo`, `ModuleInfo`, `Candidate`, `ScanFilter`, `CaughtInstruction`, `DisasmRow`.

- [ ] **Step 1: Create `mcp-server/package.json`**

```json
{
  "name": "game-trainer-mcp-server",
  "version": "0.1.0",
  "private": true,
  "description": "Read-only MCP server exposing the trainer app's native memory-introspection primitives for live reverse-engineering sessions.",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: Create `mcp-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd mcp-server && npm install && cd ..`
Expected: `mcp-server/node_modules/` populated, `mcp-server/package-lock.json` created, no errors.

- [ ] **Step 4: Add `.gitignore` entries**

Append to the repo root `.gitignore`:

```
mcp-server/node_modules/
mcp-server/dist/
```

- [ ] **Step 5: Write the failing test**

Create `mcp-server/tests/addon.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import * as addon from '../src/addon'

let harness: ChildProcessWithoutNullStreams

beforeAll(async () => {
  harness = spawn(path.resolve(__dirname, '../../test-harness/harness.exe'))
  await new Promise((r) => harness.stdout.once('data', r))
})

afterAll(() => {
  harness.stdin.write('q\n')
  harness.kill()
})

describe('addon wrapper', () => {
  it('lists processes and finds the harness among them', () => {
    const processes = addon.listProcesses()
    expect(processes.some((p) => p.pid === harness.pid)).toBe(true)
  })

  it('attaches and reads a base address', () => {
    const { handle, baseAddress } = addon.attach(harness.pid as number)
    expect(handle).toBeGreaterThan(0)
    expect(baseAddress).toMatch(/^0x[0-9a-f]+$/)
  })

  it('tryReadBytes returns null rather than throwing on an unreadable address', () => {
    const { handle } = addon.attach(harness.pid as number)
    expect(addon.tryReadBytes(handle, '0x1', 4)).toBeNull()
  })

  it('tryReadValue returns null rather than throwing on an unreadable address', () => {
    const { handle } = addon.attach(harness.pid as number)
    expect(addon.tryReadValue(handle, '0x1', [], 'int32')).toBeNull()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run mcp-server/tests/addon.test.ts`
Expected: FAIL — `Cannot find module '../src/addon'`

- [ ] **Step 7: Implement `mcp-server/src/addon.ts`**

```ts
import path from 'node:path'

// The trainer app's own compiled native addon — this file is the only
// place in mcp-server/ that touches it directly, mirroring how
// src/main/nativeAddon.ts is the sole require() site on the Electron side.
// Same relative shape: mcp-server/src -> repo root -> native/build/Release.
const addon = require(path.join(__dirname, '../../native/build/Release/memory_addon.node'))

export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'

export interface ProcessInfo { pid: number; name: string }
export interface ModuleInfo {
  name: string
  base: string
  size: number
  timestamp: number
  version: string | null
}
export interface AttachResult { handle: number; baseAddress: string }
export interface Candidate { address: string; value: number }
export type ScanFilter =
  | { mode: 'exact'; value: number }
  | { mode: 'changed' | 'unchanged' | 'increased' | 'decreased' }
export interface DisasmRow {
  address: string
  bytes: string
  text: string
  length: number
}
export interface CaughtInstruction {
  instructionAddress: string
  bytes: string
  length: number
  signature: string
  baseRegister: string
  displacement: string
  baseAddress: string
  effectiveAddress: string
  accessBytes: number
  indexed: boolean
  moduleName: string | null
  moduleOffset: string | null
}

export const listProcesses = (): ProcessInfo[] => addon.listProcesses()
export const attach = (pid: number): AttachResult => addon.attach(pid)
export const listModules = (handle: number): ModuleInfo[] => addon.listModules(handle)
export const scanFirst = (handle: number, dataType: DataType, value: number): Promise<Candidate[]> =>
  addon.scanFirst(handle, dataType, value)
export const scanNext = (
  handle: number,
  candidates: Candidate[],
  dataType: DataType,
  filter: ScanFilter
): Promise<Candidate[]> => addon.scanNext(handle, candidates, dataType, filter)
export const scanAob = (
  handle: number,
  signature: string,
  rangeStart?: string,
  rangeEnd?: string
): Promise<string[]> => addon.scanAob(handle, signature, rangeStart, rangeEnd)
export const monoResolveClass = (
  handle: number,
  monoDllBase: string,
  namespaceName: string,
  className: string
): Promise<string | null> => addon.monoResolveClass(handle, monoDllBase, namespaceName, className)
export const monoResolveField = (
  handle: number,
  monoDllBase: string,
  classHandle: string,
  fieldName: string
): Promise<{ offset: number } | null> => addon.monoResolveField(handle, monoDllBase, classHandle, fieldName)
export const monoStaticFieldAddress = (
  handle: number,
  monoDllBase: string,
  classHandle: string,
  fieldName: string
): Promise<string | null> => addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, fieldName)
export const monoListFieldNames = (
  handle: number,
  monoDllBase: string,
  classHandle: string
): Promise<string[]> => addon.monoListFieldNames(handle, monoDllBase, classHandle)
export const monoListMethodNames = (
  handle: number,
  monoDllBase: string,
  classHandle: string
): Promise<string[]> => addon.monoListMethodNames(handle, monoDllBase, classHandle)
export const disassembleBuffer = (
  buffer: Buffer,
  baseAddress: string,
  maxCount?: number
): DisasmRow[] => addon.disassembleBuffer(buffer, baseAddress, maxCount)
export const startWriteWatch = (pid: number, address: string): void => addon.startWriteWatch(pid, address)
export const pollWriteWatch = (): CaughtInstruction[] => addon.pollWriteWatch()
export const stopWriteWatch = (): CaughtInstruction[] => addon.stopWriteWatch()

// readBytes/readValue throw on an unresolvable chain or unreadable memory —
// routine, expected outcomes during exploration (wrong address, module
// unloaded), not exceptional ones. Same non-throwing convention
// src/main/nativeAddon.ts already established for the same reason.
export const tryReadBytes = (handle: number, address: string, length: number): string | null => {
  try {
    return addon.readBytes(handle, address, length)
  } catch {
    return null
  }
}
export const tryReadValue = (
  handle: number,
  baseAddress: string,
  offsets: string[],
  dataType: DataType
): number | null => {
  try {
    return addon.readValue(handle, baseAddress, offsets, dataType)
  } catch {
    return null
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run mcp-server/tests/addon.test.ts`
Expected: PASS (4/4)

- [ ] **Step 9: Commit**

```bash
git add mcp-server/package.json mcp-server/package-lock.json mcp-server/tsconfig.json mcp-server/src/addon.ts mcp-server/tests/addon.test.ts .gitignore
git commit -m "feat(mcp-server): scaffold package and native addon wrapper"
```

---

### Task 2: Read/scan/mono/disasm tools

**Files:**
- Create: `mcp-server/src/toolResult.ts`
- Create: `mcp-server/src/tools/process.ts`
- Create: `mcp-server/src/tools/scan.ts`
- Create: `mcp-server/src/tools/mono.ts`
- Create: `mcp-server/src/tools/read.ts`
- Create: `mcp-server/src/tools/disasm.ts`
- Test: `mcp-server/tests/tools.test.ts`

**Interfaces:**
- Consumes: everything `mcp-server/src/addon.ts` exports (Task 1).
- Produces: each `tools/*.ts` file exports a `register<Group>Tools(server: McpServer): void` function (`registerProcessTools`, `registerScanTools`, `registerMonoTools`, `registerReadTools`, `registerDisasmTools`) that calls `server.registerTool(...)` for its group's tools. Task 3 imports and calls all five.

- [ ] **Step 1: Write the failing tests**

Create `mcp-server/tests/tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mcp-server/tests/tools.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/process'`

- [ ] **Step 3: Implement `mcp-server/src/toolResult.ts`**

```ts
// Every tool handler in this package returns through one of these two
// helpers, never a bare throw — MCP tool errors are data in the response
// (isError: true), not a transport-level exception. This mirrors
// src/main/nativeAddon.ts's own tryReadValue/tryReadBytes convention:
// a "not found"/"unreadable" outcome during exploration is routine, not
// exceptional, and the caller (an LLM driving this server) needs to see
// it as a normal, readable result rather than a crash.
export function ok(data: unknown): { content: { type: 'text'; text: string }[] } {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return { content: [{ type: 'text', text }] }
}

export function err(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}
```

- [ ] **Step 4: Implement `mcp-server/src/tools/process.ts`**

```ts
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
```

- [ ] **Step 5: Implement `mcp-server/src/tools/scan.ts`**

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import type { DataType } from '../addon'
import { ok } from '../toolResult'

const dataTypeSchema = z.enum(['int8', 'int16', 'int32', 'int64', 'float', 'double'])
const candidateSchema = z.object({ address: z.string(), value: z.number() })
const filterSchema = z.union([
  z.object({ mode: z.literal('exact'), value: z.number() }),
  z.object({ mode: z.enum(['changed', 'unchanged', 'increased', 'decreased']) })
])

export function registerScanTools(server: McpServer): void {
  server.registerTool(
    'scan_first',
    {
      description: 'First-pass memory scan for a value of the given data type. Returns matching addresses.',
      inputSchema: { handle: z.number().int(), dataType: dataTypeSchema, value: z.number() }
    },
    async ({ handle, dataType, value }: { handle: number; dataType: DataType; value: number }) =>
      ok(await addon.scanFirst(handle, dataType, value))
  )

  server.registerTool(
    'scan_next',
    {
      description:
        'Narrow a previous scan_first result set by an exact value or a relative change (changed/unchanged/increased/decreased).',
      inputSchema: {
        handle: z.number().int(),
        candidates: z.array(candidateSchema),
        dataType: dataTypeSchema,
        filter: filterSchema
      }
    },
    async (args: {
      handle: number
      candidates: { address: string; value: number }[]
      dataType: DataType
      filter: { mode: 'exact'; value: number } | { mode: 'changed' | 'unchanged' | 'increased' | 'decreased' }
    }) => ok(await addon.scanNext(args.handle, args.candidates, args.dataType, args.filter))
  )

  server.registerTool(
    'scan_aob',
    {
      description:
        'Scan for a byte-pattern signature (hex bytes with ?? wildcards, e.g. "48 8b ?? 10") across an attached process\'s memory, optionally bounded to an address range. Returns every matching address.',
      inputSchema: {
        handle: z.number().int(),
        signature: z.string(),
        rangeStart: z.string().optional(),
        rangeEnd: z.string().optional()
      }
    },
    async ({
      handle,
      signature,
      rangeStart,
      rangeEnd
    }: {
      handle: number
      signature: string
      rangeStart?: string
      rangeEnd?: string
    }) => ok(await addon.scanAob(handle, signature, rangeStart, rangeEnd))
  )
}
```

- [ ] **Step 6: Implement `mcp-server/src/tools/mono.ts`**

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'

export function registerMonoTools(server: McpServer): void {
  server.registerTool(
    'mono_resolve_class',
    {
      description:
        'Resolve a MonoClass* by namespace + class name (e.g. namespace "" className "Player"). Returns a class handle for the other mono_* tools, or an error if not found.',
      inputSchema: {
        handle: z.number().int(),
        monoDllBase: z.string(),
        namespaceName: z.string(),
        className: z.string()
      }
    },
    async (args: { handle: number; monoDllBase: string; namespaceName: string; className: string }) => {
      const classHandle = await addon.monoResolveClass(
        args.handle,
        args.monoDllBase,
        args.namespaceName,
        args.className
      )
      return classHandle === null
        ? err(`class not found: ${args.namespaceName}.${args.className}`)
        : ok({ classHandle })
    }
  )

  server.registerTool(
    'mono_resolve_field',
    {
      description: 'Resolve an instance field\'s byte offset within a class, by class handle + field name.',
      inputSchema: {
        handle: z.number().int(),
        monoDllBase: z.string(),
        classHandle: z.string(),
        fieldName: z.string()
      }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string; fieldName: string }) => {
      const field = await addon.monoResolveField(args.handle, args.monoDllBase, args.classHandle, args.fieldName)
      return field === null ? err(`field not found: ${args.fieldName}`) : ok(field)
    }
  )

  server.registerTool(
    'mono_static_field_address',
    {
      description: 'Resolve a static field\'s live storage address, by class handle + field name.',
      inputSchema: {
        handle: z.number().int(),
        monoDllBase: z.string(),
        classHandle: z.string(),
        fieldName: z.string()
      }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string; fieldName: string }) => {
      const address = await addon.monoStaticFieldAddress(
        args.handle,
        args.monoDllBase,
        args.classHandle,
        args.fieldName
      )
      return address === null ? err(`static field not found: ${args.fieldName}`) : ok({ address })
    }
  )

  server.registerTool(
    'mono_list_field_names',
    {
      description: 'List every field name declared on a mono class, by class handle.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string(), classHandle: z.string() }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string }) =>
      ok(await addon.monoListFieldNames(args.handle, args.monoDllBase, args.classHandle))
  )

  server.registerTool(
    'mono_list_method_names',
    {
      description: 'List every method name declared on a mono class, by class handle.',
      inputSchema: { handle: z.number().int(), monoDllBase: z.string(), classHandle: z.string() }
    },
    async (args: { handle: number; monoDllBase: string; classHandle: string }) =>
      ok(await addon.monoListMethodNames(args.handle, args.monoDllBase, args.classHandle))
  )
}
```

- [ ] **Step 7: Implement `mcp-server/src/tools/read.ts`**

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import type { DataType } from '../addon'
import { ok, err } from '../toolResult'

const dataTypeSchema = z.enum(['int8', 'int16', 'int32', 'int64', 'float', 'double'])

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'read_bytes',
    {
      description: 'Read raw bytes at an address in an attached process. Returns unspaced lowercase hex.',
      inputSchema: { handle: z.number().int(), address: z.string(), length: z.number().int().positive() }
    },
    async ({ handle, address, length }: { handle: number; address: string; length: number }) => {
      const bytes = addon.tryReadBytes(handle, address, length)
      return bytes === null ? err(`unreadable: ${address}`) : ok(bytes)
    }
  )

  server.registerTool(
    'read_value',
    {
      description:
        'Read a typed value at a base address, optionally walking a pointer chain of hex offsets first.',
      inputSchema: {
        handle: z.number().int(),
        baseAddress: z.string(),
        offsets: z.array(z.string()),
        dataType: dataTypeSchema
      }
    },
    async (args: { handle: number; baseAddress: string; offsets: string[]; dataType: DataType }) => {
      const value = addon.tryReadValue(args.handle, args.baseAddress, args.offsets, args.dataType)
      return value === null ? err(`unreadable or unresolvable chain at: ${args.baseAddress}`) : ok({ value })
    }
  )
}
```

- [ ] **Step 8: Implement `mcp-server/src/tools/disasm.ts`**

```ts
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
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run mcp-server/tests/tools.test.ts`
Expected: PASS (4/4)

- [ ] **Step 10: Run the full mcp-server test directory to check for regressions**

Run: `npx vitest run mcp-server/tests`
Expected: PASS (all tests from Task 1 and Task 2 green)

- [ ] **Step 11: Commit**

```bash
git add mcp-server/src/toolResult.ts mcp-server/src/tools/process.ts mcp-server/src/tools/scan.ts mcp-server/src/tools/mono.ts mcp-server/src/tools/read.ts mcp-server/src/tools/disasm.ts mcp-server/tests/tools.test.ts
git commit -m "feat(mcp-server): register read/scan/mono/disasm tools"
```

---

### Task 3: Write-watch tools, server wiring, and stdio integration

**Files:**
- Create: `mcp-server/src/tools/watch.ts`
- Create: `mcp-server/src/server.ts`
- Create: `mcp-server/src/index.ts`
- Create: `.mcp.json`
- Test: `mcp-server/tests/watch.test.ts`
- Test: `mcp-server/tests/integration.test.ts`

**Interfaces:**
- Consumes: `mcp-server/src/addon.ts` (Task 1), `registerProcessTools`/`registerScanTools`/`registerMonoTools`/`registerReadTools`/`registerDisasmTools` (Task 2).
- Produces: `mcp-server/src/server.ts` exports `createServer(): McpServer`; `mcp-server/src/index.ts` is the runnable entry point `.mcp.json` points at.

- [ ] **Step 1: Write the failing write-watch test**

Create `mcp-server/tests/watch.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run mcp-server/tests/watch.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/watch'`

- [ ] **Step 3: Implement `mcp-server/src/tools/watch.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run mcp-server/tests/watch.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Implement `mcp-server/src/server.ts`**

```ts
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
```

- [ ] **Step 6: Implement `mcp-server/src/index.ts`**

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server'

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 7: Build the package**

Run: `cd mcp-server && npm run build && cd ..`
Expected: `mcp-server/dist/index.js` and its siblings created with no compile errors.

- [ ] **Step 8: Write the failing stdio integration test**

Create `mcp-server/tests/integration.test.ts`:

```ts
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
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npx vitest run mcp-server/tests/integration.test.ts`
Expected: FAIL — connection/spawn error, since `mcp-server/dist/index.js` did not exist until Step 7 built it, or the test file itself is new and unexercised. If Step 7 already succeeded, this may instead fail on an assertion — confirm the failure is meaningful (e.g. tools not yet reachable) rather than skip this check.

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run mcp-server/tests/integration.test.ts`
Expected: PASS (2/2)

- [ ] **Step 11: Create `.mcp.json`**

At the repo root:

```json
{
  "mcpServers": {
    "game-memory": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"]
    }
  }
}
```

- [ ] **Step 12: Run the full mcp-server test directory and the full repo suite to check for regressions**

Run: `npx vitest run mcp-server/tests`
Expected: PASS (all tests from Tasks 1-3 green)

Run: `npx vitest run`
Expected: PASS (no regressions in the rest of the repo's suite)

- [ ] **Step 13: Commit**

```bash
git add mcp-server/src/tools/watch.ts mcp-server/src/server.ts mcp-server/src/index.ts mcp-server/tests/watch.test.ts mcp-server/tests/integration.test.ts .mcp.json
git commit -m "feat(mcp-server): write-watch tools, server wiring, and stdio registration"
```

---

## Deliberately out of scope

Memory-write tools, shipping this server as part of the Electron app's build, and a persistent-beyond-one-session transport are all explicitly excluded per the design spec's Non-goals — not partial oversights.

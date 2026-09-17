# Read-only Cheat Verification Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `verify_cheat` MCP tool that resolves a `games/*.json` profile's cheat by id and reports each target's live status (resolves? current value? matches expected?) read-only, without the caller manually re-deriving any address.

**Architecture:** Pure TS, no new native code. A pure `resolveTarget`-family of functions (one per target kind: mono, chain, anchor) does the read-only resolution, unit-tested directly against fake ops; the `verify_cheat` tool handler loads the profile JSON, finds the cheat, and calls the right resolver per target kind, matching `ipc.ts`'s existing `valueMatches`/bit-extraction semantics exactly so results agree with what the app itself would report.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, zod, vitest, Node's `fs` (existing `mcp-server` toolchain — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-16-verify-cheat-design.md`

## Global Constraints

- No writes to game memory anywhere in this tool — read-only, full stop.
- `anchor`-kind targets are never resolved — always report `supported: false` with the exact reason string from the spec.
- No cross-package import of `src/main/*` (transitively pulls in `electron`, which throws in `mcp-server`'s plain Node process) — all resolution logic is self-contained in `mcp-server`.
- Float/double matching tolerance is `< 1.0` absolute difference; every other `DataType` is exact equality — matches `ipc.ts:359-362`'s `valueMatches` exactly.
- Only `CheatDefinition` entries (`kind` absent or `'value'`) are supported — `PatchCheat`/`ScriptCheat` entries are rejected with a named error.

## Global Types (shared across tasks)

These mirror `src/main/store.ts`'s existing types exactly (field-for-field), reimplemented locally in `mcp-server` since importing `store.ts` would pull in nothing Electron-specific itself but isn't part of this package's dependency graph today — kept as plain local interfaces to avoid a cross-package build dependency for a handful of fields:

```ts
export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'

export interface MonoTarget {
  kind: 'mono'
  className: string
  staticFieldName: string
  instanceFieldName?: string
  instanceClassName?: string
  pointerFieldOffset?: string
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export interface AnchorTarget {
  kind: 'anchor'
  patchId: string
  offset: string
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export interface ChainTarget {
  moduleName: string
  baseOffset: string
  offsets: string[]
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export type CheatTarget = MonoTarget | AnchorTarget | ChainTarget

export interface CheatDefinition {
  kind?: 'value'
  id: string
  name: string
  dataType: DataType
  targets: CheatTarget[]
  value: number
}
```

---

### Task 1: pure target resolvers + value matching, unit-tested

**Files:**
- Create: `mcp-server/src/cheatVerify.ts`
- Test: `mcp-server/tests/cheatVerify.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (this is the foundation task).
- Produces (used by Task 2):
  ```ts
  export interface MonoResolveOps {
    resolveClass(handle: number, monoDllBase: string, namespaceName: string, className: string): Promise<string | null>
    resolveField(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<{ offset: number } | null>
    staticFieldAddress(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<string | null>
    readBytes(address: string, length: number): string | null
  }

  export async function resolveMonoTargetAddress(
    target: MonoTarget,
    handle: number,
    monoDllBase: string,
    ops: MonoResolveOps
  ): Promise<string | null>

  export interface TargetStatus {
    supported: boolean
    alive: boolean | null
    value: number | null
    expected: number | null
    matches: boolean | null
    reason?: string
  }

  export function valueMatches(read: number, expected: number, dataType: DataType): boolean
  export function extractBit(raw: number, bitIndex: number | undefined): number
  export function buildTargetStatus(
    resolvedAddress: string | null,
    readValue: (address: string) => number | null,
    target: MonoTarget | ChainTarget,
    cheatValue: number,
    cheatDataType: DataType
  ): TargetStatus
  export function unsupportedAnchorStatus(): TargetStatus
  ```
  Also exports the `DataType`/`MonoTarget`/`AnchorTarget`/`ChainTarget`/`CheatTarget`/`CheatDefinition` types from the plan's "Global Types" section above.

`resolveMonoTargetAddress` is a direct, faithful port of
`src/main/monoTargetResolve.ts:22-69`'s algorithm (read that file for
the exact reference — same five steps: resolve class, resolve static
field address, return it directly if no instance hop, else resolve the
instance field's offset, dereference the static address as a
little-endian pointer via `Buffer.from(hex, 'hex').readBigUInt64LE(0)`
(zero means "not set this session yet", return `null`, not an error),
add the field offset, and repeat once more if `pointerFieldOffset` is
set).

`buildTargetStatus`: given a resolved address (or `null`) and a
value-reading callback, returns `{ supported: true, alive, value,
expected, matches }` — `alive`/`value`/`matches` are all `null` when
`resolvedAddress` is `null` or `readValue` returns `null`; otherwise
`value` is `extractBit(rawReadValue, target.bitIndex)`, `expected` is
`target.value ?? cheatValue`, `alive: true`, and `matches` is
`valueMatches(value, expected, target.dataType ?? cheatDataType)`.

`unsupportedAnchorStatus`: always returns `{ supported: false, alive: null, value: null, expected: null, matches: null, reason: 'anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only' }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import {
  resolveMonoTargetAddress,
  valueMatches,
  extractBit,
  buildTargetStatus,
  unsupportedAnchorStatus,
  type MonoResolveOps,
  type MonoTarget,
  type ChainTarget
} from '../src/cheatVerify'

describe('valueMatches', () => {
  it('matches floats within 1.0 tolerance', () => {
    expect(valueMatches(99.5, 100, 'float')).toBe(true)
    expect(valueMatches(98.9, 100, 'float')).toBe(false)
  })
  it('matches ints exactly', () => {
    expect(valueMatches(100, 100, 'int32')).toBe(true)
    expect(valueMatches(99, 100, 'int32')).toBe(false)
  })
})

describe('extractBit', () => {
  it('returns the raw value when bitIndex is undefined', () => {
    expect(extractBit(5, undefined)).toBe(5)
  })
  it('extracts a single bit when bitIndex is set', () => {
    expect(extractBit(0b0110, 1)).toBe(1)
    expect(extractBit(0b0110, 0)).toBe(0)
  })
})

describe('resolveMonoTargetAddress', () => {
  function ops(overrides: Partial<MonoResolveOps> = {}): MonoResolveOps {
    return {
      resolveClass: async () => '0xc1a55',
      resolveField: async () => ({ offset: 0x10 }),
      staticFieldAddress: async () => '0xf1e1d0',
      readBytes: () => '0000000000000000',
      ...overrides
    }
  }

  it('resolves a plain static field with no instance hop', async () => {
    const target: MonoTarget = { kind: 'mono', className: 'Player', staticFieldName: 'm_godMode' }
    const address = await resolveMonoTargetAddress(target, 1, '0x1000', ops())
    expect(address).toBe('0xf1e1d0')
  })

  it('returns null when the class does not resolve', async () => {
    const target: MonoTarget = { kind: 'mono', className: 'Nope', staticFieldName: 'x' }
    const address = await resolveMonoTargetAddress(target, 1, '0x1000', ops({ resolveClass: async () => null }))
    expect(address).toBeNull()
  })

  it('dereferences the static field and adds the instance field offset when instanceFieldName is set', async () => {
    // pointer 0x2000 encoded little-endian
    const pointerHex = '0020000000000000'
    const target: MonoTarget = {
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_health'
    }
    const address = await resolveMonoTargetAddress(
      target,
      1,
      '0x1000',
      ops({ readBytes: () => pointerHex, resolveField: async () => ({ offset: 0x18 }) })
    )
    expect(address).toBe('0x2018')
  })

  it('returns null when the dereferenced pointer is zero (not touched this session)', async () => {
    const target: MonoTarget = {
      kind: 'mono',
      className: 'Player',
      staticFieldName: 'm_localPlayer',
      instanceFieldName: 'm_health'
    }
    const address = await resolveMonoTargetAddress(
      target,
      1,
      '0x1000',
      ops({ readBytes: () => '0000000000000000' })
    )
    expect(address).toBeNull()
  })
})

describe('buildTargetStatus', () => {
  const chainTarget: ChainTarget = { moduleName: 'game.exe', baseOffset: '0x100', offsets: [] }

  it('reports unresolved when the address is null', () => {
    const status = buildTargetStatus(null, () => 5, chainTarget, 100, 'int32')
    expect(status).toEqual({ supported: true, alive: false, value: null, expected: null, matches: null })
  })

  it('reports a matching value', () => {
    const status = buildTargetStatus('0x2000', () => 100, chainTarget, 100, 'int32')
    expect(status).toEqual({ supported: true, alive: true, value: 100, expected: 100, matches: true })
  })

  it('reports a non-matching value', () => {
    const status = buildTargetStatus('0x2000', () => 5, chainTarget, 100, 'int32')
    expect(status).toEqual({ supported: true, alive: true, value: 5, expected: 100, matches: false })
  })

  it("prefers the target's own value/dataType override over the cheat's", () => {
    const overriddenTarget: ChainTarget = { ...chainTarget, value: 7, dataType: 'int8' }
    const status = buildTargetStatus('0x2000', () => 7, overriddenTarget, 100, 'int32')
    expect(status.expected).toBe(7)
    expect(status.matches).toBe(true)
  })
})

describe('unsupportedAnchorStatus', () => {
  it('always reports unsupported with the fixed reason', () => {
    expect(unsupportedAnchorStatus()).toEqual({
      supported: false,
      alive: null,
      value: null,
      expected: null,
      matches: null,
      reason:
        'anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only'
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/cheatVerify.test.ts`
Expected: FAIL — `Cannot find module '../src/cheatVerify'`

- [ ] **Step 3: Write the implementation**

```ts
export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'

export interface MonoTarget {
  kind: 'mono'
  className: string
  staticFieldName: string
  instanceFieldName?: string
  instanceClassName?: string
  pointerFieldOffset?: string
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export interface AnchorTarget {
  kind: 'anchor'
  patchId: string
  offset: string
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export interface ChainTarget {
  moduleName: string
  baseOffset: string
  offsets: string[]
  value?: number
  dataType?: DataType
  bitIndex?: number
}

export type CheatTarget = MonoTarget | AnchorTarget | ChainTarget

export interface CheatDefinition {
  kind?: 'value'
  id: string
  name: string
  dataType: DataType
  targets: CheatTarget[]
  value: number
}

export function isAnchorTarget(target: CheatTarget): target is AnchorTarget {
  return (target as AnchorTarget).kind === 'anchor'
}

export function isMonoTarget(target: CheatTarget): target is MonoTarget {
  return (target as MonoTarget).kind === 'mono'
}

export interface MonoResolveOps {
  resolveClass(handle: number, monoDllBase: string, namespaceName: string, className: string): Promise<string | null>
  resolveField(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<{ offset: number } | null>
  staticFieldAddress(handle: number, monoDllBase: string, classHandle: string, fieldName: string): Promise<string | null>
  readBytes(address: string, length: number): string | null
}

function addHex(address: string, delta: bigint): string {
  return '0x' + (BigInt(address) + delta).toString(16)
}

function littleEndianPointer(hex: string): bigint {
  return Buffer.from(hex, 'hex').readBigUInt64LE(0)
}

// Direct port of src/main/monoTargetResolve.ts's resolveMonoTargetAddress
// -- kept as a separate, self-contained copy rather than a cross-package
// import because that file transitively imports 'electron' via ipc.ts,
// which throws outside the Electron process.
export async function resolveMonoTargetAddress(
  target: MonoTarget,
  handle: number,
  monoDllBase: string,
  ops: MonoResolveOps
): Promise<string | null> {
  const classHandle = await ops.resolveClass(handle, monoDllBase, '', target.className)
  if (classHandle === null) return null

  const staticAddress = await ops.staticFieldAddress(handle, monoDllBase, classHandle, target.staticFieldName)
  if (staticAddress === null) return null

  if (target.instanceFieldName === undefined) return staticAddress

  const fieldClassHandle =
    target.instanceClassName === undefined
      ? classHandle
      : await ops.resolveClass(handle, monoDllBase, '', target.instanceClassName)
  if (fieldClassHandle === null) return null

  const field = await ops.resolveField(handle, monoDllBase, fieldClassHandle, target.instanceFieldName)
  if (field === null) return null

  const pointerHex = ops.readBytes(staticAddress, 8)
  if (pointerHex === null) return null
  const objectPointer = littleEndianPointer(pointerHex)
  if (objectPointer === 0n) return null

  const firstHopAddress = addHex('0x' + objectPointer.toString(16), BigInt(field.offset))
  if (target.pointerFieldOffset === undefined) return firstHopAddress

  const secondPointerHex = ops.readBytes(firstHopAddress, 8)
  if (secondPointerHex === null) return null
  const secondObjectPointer = littleEndianPointer(secondPointerHex)
  if (secondObjectPointer === 0n) return null

  return addHex('0x' + secondObjectPointer.toString(16), BigInt(target.pointerFieldOffset))
}

export function valueMatches(read: number, expected: number, dataType: DataType): boolean {
  if (dataType === 'float' || dataType === 'double') return Math.abs(read - expected) < 1.0
  return read === expected
}

export function extractBit(raw: number, bitIndex: number | undefined): number {
  return bitIndex !== undefined ? (raw >> bitIndex) & 1 : raw
}

export interface TargetStatus {
  supported: boolean
  alive: boolean | null
  value: number | null
  expected: number | null
  matches: boolean | null
  reason?: string
}

export function buildTargetStatus(
  resolvedAddress: string | null,
  readValue: (address: string) => number | null,
  target: MonoTarget | ChainTarget,
  cheatValue: number,
  cheatDataType: DataType
): TargetStatus {
  if (resolvedAddress === null) {
    return { supported: true, alive: false, value: null, expected: null, matches: null }
  }
  const raw = readValue(resolvedAddress)
  if (raw === null) {
    return { supported: true, alive: false, value: null, expected: null, matches: null }
  }
  const value = extractBit(raw, target.bitIndex)
  const expected = target.value ?? cheatValue
  const dataType = target.dataType ?? cheatDataType
  return { supported: true, alive: true, value, expected, matches: valueMatches(value, expected, dataType) }
}

export function unsupportedAnchorStatus(): TargetStatus {
  return {
    supported: false,
    alive: null,
    value: null,
    expected: null,
    matches: null,
    reason:
      'anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only'
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-server && npx vitest run tests/cheatVerify.test.ts`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
cd mcp-server
git add src/cheatVerify.ts tests/cheatVerify.test.ts
git commit -m "$(cat <<'EOF'
feat: add pure cheat-target resolvers for verify_cheat

Direct port of monoTargetResolve.ts's algorithm (can't cross-package
import it -- it transitively pulls in electron via ipc.ts) plus
ipc.ts's valueMatches/bit-extraction semantics, kept pure and
unit-tested against fake ops so the MCP tool wrapper (next commit) has
nothing left to get wrong beyond wiring.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `verify_cheat` MCP tool

**Files:**
- Create: `mcp-server/src/tools/verify.ts`
- Modify: `mcp-server/src/server.ts` (register the new tool)
- Test: `mcp-server/tests/tools.test.ts` (add a `verify_cheat tool` describe block)
- Test fixture: `mcp-server/tests/fixtures/verify-chain.json` (new)

**Interfaces:**
- Consumes: everything exported from `../cheatVerify` (Task 1); `classifyEngine` from `../engineFingerprint` (Task 1 of the engine-fingerprint plan, already shipped); `addon.listModules`, `addon.monoResolveClass`, `addon.monoResolveField`, `addon.monoStaticFieldAddress`, `addon.tryReadBytes`, `addon.tryReadValue` from `../addon`; `ok`/`err` from `../toolResult`.
- Produces: the `verify_cheat` MCP tool, registered via `registerVerifyTools(server)`, called from `server.ts`.

Result JSON shape (matches the spec exactly):
```json
{
  "cheatId": "string",
  "name": "string",
  "targets": [ /* one TargetStatus per cheat.targets entry, in order, plus a "kind" field */ ]
}
```
Each entry in `targets` is a `TargetStatus` (from Task 1) with an added `"kind": "mono" | "chain" | "anchor"` field so the caller can tell target kinds apart in the flat result array.

- [ ] **Step 1: Write the test fixture and failing test**

Create `mcp-server/tests/fixtures/verify-chain.json`:

```json
{
  "schema": 2,
  "exe": "harness",
  "modules": {},
  "cheats": [
    {
      "id": "harness-fixture-cheat",
      "name": "Harness Fixture Cheat",
      "dataType": "float",
      "targets": [
        {
          "moduleName": "harness.exe",
          "baseOffset": "0x0",
          "offsets": []
        }
      ],
      "value": 10.0
    }
  ]
}
```

This targets offset `0x0` off the harness's own main module — reads
whatever raw bytes sit at the harness's image base, a real address the
harness process (spawned by `tests/tools.test.ts`) definitely has
mapped, so `tryReadValue` succeeds (returns *some* float, not
necessarily `10.0` — the test only asserts the target resolves and
reports a status, not that it matches, since a PE header's bytes
decoded as a float are unpredictable, not a meaningful mismatch to
assert on).

Add to `mcp-server/tests/tools.test.ts`:

```ts
import { registerVerifyTools } from '../src/tools/verify'
import path from 'node:path'

describe('verify_cheat tool', () => {
  it('resolves a chain target against the real harness process', async () => {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)

    const server = new FakeServer()
    registerVerifyTools(server as unknown as McpServer)
    const fixturePath = path.resolve(__dirname, 'fixtures/verify-chain.json')
    const result = await server.call('verify_cheat', {
      handle,
      profilePath: fixturePath,
      cheatId: 'harness-fixture-cheat'
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text as string)
    expect(parsed.cheatId).toBe('harness-fixture-cheat')
    expect(parsed.targets).toHaveLength(1)
    expect(parsed.targets[0].kind).toBe('chain')
    expect(parsed.targets[0].supported).toBe(true)
    expect(parsed.targets[0].alive).toBe(true)
    expect(typeof parsed.targets[0].value).toBe('number')
  })

  it('reports unsupported for an anchor target without attempting resolution', async () => {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)

    const fixturePath = path.resolve(__dirname, 'fixtures/verify-anchor.json')
    const server = new FakeServer()
    registerVerifyTools(server as unknown as McpServer)
    const result = await server.call('verify_cheat', { handle, profilePath: fixturePath, cheatId: 'anchor-fixture-cheat' })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text as string)
    expect(parsed.targets[0].kind).toBe('anchor')
    expect(parsed.targets[0].supported).toBe(false)
    expect(parsed.targets[0].reason).toContain('capture patch')
  })

  it('errors when the cheat id is not found', async () => {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)

    const fixturePath = path.resolve(__dirname, 'fixtures/verify-chain.json')
    const server = new FakeServer()
    registerVerifyTools(server as unknown as McpServer)
    const result = await server.call('verify_cheat', { handle, profilePath: fixturePath, cheatId: 'does-not-exist' })
    expect(result.isError).toBe(true)
  })
})
```

Also create the second fixture, `mcp-server/tests/fixtures/verify-anchor.json`:

```json
{
  "schema": 2,
  "exe": "harness",
  "modules": {},
  "cheats": [
    {
      "id": "anchor-fixture-cheat",
      "name": "Anchor Fixture Cheat",
      "dataType": "int32",
      "targets": [
        {
          "kind": "anchor",
          "patchId": "some-capture-patch",
          "offset": "0x10"
        }
      ],
      "value": 1
    }
  ]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/tools.test.ts -t "verify_cheat"`
Expected: FAIL — `Cannot find module '../src/tools/verify'`

- [ ] **Step 3: Write the implementation**

`mcp-server/src/tools/verify.ts`:

```ts
import fs from 'node:fs'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'
import { classifyEngine } from '../engineFingerprint'
import {
  resolveMonoTargetAddress,
  buildTargetStatus,
  unsupportedAnchorStatus,
  isAnchorTarget,
  isMonoTarget,
  type CheatDefinition,
  type CheatTarget,
  type MonoResolveOps,
  type TargetStatus
} from '../cheatVerify'

function loadCheat(profilePath: string, cheatId: string): CheatDefinition | { error: string } {
  let raw: string
  try {
    raw = fs.readFileSync(profilePath, 'utf-8')
  } catch (e) {
    return { error: `could not read profile at ${profilePath}: ${(e as Error).message}` }
  }
  let parsed: { cheats?: unknown[] }
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { error: `profile at ${profilePath} is not valid JSON: ${(e as Error).message}` }
  }
  const cheat = (parsed.cheats ?? []).find((c: any) => c.id === cheatId) as CheatDefinition | undefined
  if (!cheat) return { error: `no cheat with id "${cheatId}" in ${profilePath}` }
  if (cheat.kind !== undefined && cheat.kind !== 'value') {
    return { error: `cheat "${cheatId}" is a "${cheat.kind}" cheat, not a value cheat -- verify_cheat only supports value cheats` }
  }
  return cheat
}

function monoOpsFor(handle: number): MonoResolveOps {
  return {
    resolveClass: (h, base, ns, cls) => addon.monoResolveClass(h, base, ns, cls),
    resolveField: (h, base, cls, field) => addon.monoResolveField(h, base, cls, field),
    staticFieldAddress: (h, base, cls, field) => addon.monoStaticFieldAddress(h, base, cls, field),
    readBytes: (address, length) => addon.tryReadBytes(handle, address, length)
  }
}

export function registerVerifyTools(server: McpServer): void {
  server.registerTool(
    'verify_cheat',
    {
      description:
        'Read-only: resolve a value cheat from a games/*.json profile by id and report each target\'s live status (resolves? current value? matches the expected value?) without writing anything. mono/chain targets resolve fully standalone; anchor targets always report unsupported (their address only exists in the running app\'s own capture-patch bookkeeping).',
      inputSchema: {
        handle: z.number().int(),
        profilePath: z.string(),
        cheatId: z.string(),
        monoDllBase: z.string().optional()
      }
    },
    async (args: { handle: number; profilePath: string; cheatId: string; monoDllBase?: string }) => {
      const cheat = loadCheat(args.profilePath, args.cheatId)
      if ('error' in cheat) return err(cheat.error)

      const modules = addon.listModules(args.handle)
      let monoDllBase = args.monoDllBase ?? null
      if (monoDllBase === null) {
        const classification = classifyEngine(modules)
        if (classification.engine === 'unity-mono') monoDllBase = classification.monoDllBase
      }

      const targets: (TargetStatus & { kind: 'mono' | 'chain' | 'anchor' })[] = []
      for (const target of cheat.targets) {
        targets.push(await resolveOneTarget(args.handle, target, cheat, monoDllBase))
      }

      return ok({ cheatId: cheat.id, name: cheat.name, targets })
    }
  )
}

async function resolveOneTarget(
  handle: number,
  target: CheatTarget,
  cheat: CheatDefinition,
  monoDllBase: string | null
): Promise<TargetStatus & { kind: 'mono' | 'chain' | 'anchor' }> {
  if (isAnchorTarget(target)) {
    return { ...unsupportedAnchorStatus(), kind: 'anchor' }
  }
  if (isMonoTarget(target)) {
    if (monoDllBase === null) {
      return {
        supported: true,
        alive: false,
        value: null,
        expected: null,
        matches: null,
        kind: 'mono'
      }
    }
    const address = await resolveMonoTargetAddress(target, handle, monoDllBase, monoOpsFor(handle))
    const status = buildTargetStatus(
      address,
      (addr) => addon.tryReadValue(handle, addr, [], target.dataType ?? cheat.dataType),
      target,
      cheat.value,
      cheat.dataType
    )
    return { ...status, kind: 'mono' }
  }
  // ChainTarget
  const moduleInfo = addon.listModules(handle).find((m) => m.name.toLowerCase() === target.moduleName.toLowerCase())
  const address = moduleInfo === undefined ? null : moduleInfo.base
  const status = buildTargetStatus(
    address,
    () => addon.tryReadValue(handle, address as string, [target.baseOffset, ...target.offsets], target.dataType ?? cheat.dataType),
    target,
    cheat.value,
    cheat.dataType
  )
  return { ...status, kind: 'chain' }
}
```

Modify `mcp-server/src/server.ts`: add the import and registration call:

```ts
import { registerVerifyTools } from './tools/verify'
```
and inside `createServer()`:
```ts
registerVerifyTools(server)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-server && npx vitest run tests/tools.test.ts`
Expected: PASS, including all three new `verify_cheat tool` tests and every pre-existing test in the file (the 3 pre-existing `mono discovery tools` failures noted in the engine-fingerprint plan's execution are a separate, unrelated stale-native-addon issue — confirm they're still the ONLY failures, not a new one from this change).

- [ ] **Step 5: Commit**

```bash
cd mcp-server
git add src/tools/verify.ts src/server.ts tests/tools.test.ts tests/fixtures/verify-chain.json tests/fixtures/verify-anchor.json
git commit -m "$(cat <<'EOF'
feat: add verify_cheat MCP tool

Resolves a value cheat's targets from a games/*.json profile and
reports live status per target, read-only. mono/chain targets resolve
fully; anchor targets always report unsupported -- their address only
exists in the running app's own capture-patch bookkeeping, not
reachable from a static profile read-only. Cuts the
"manually re-derive the address" step every shipped-cheat doc in this
project has needed so far.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

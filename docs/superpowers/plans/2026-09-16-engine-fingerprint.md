# Engine Fingerprint Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `fingerprint_process` MCP tool that identifies a live process's engine/runtime (Unity/Mono, Unity/IL2CPP, Unreal, or unknown) and returns whatever key addresses are cheaply resolvable up front, so a new-game RE session starts with routing info instead of manual module-list triage.

**Architecture:** Pure TS orchestration, no new native code. A pure, directly-testable `classifyEngine(modules: ModuleInfo[])` function does branch selection from a module list; the `fingerprint_process` tool handler calls `addon.listModules`, runs it through `classifyEngine`, and — only for the IL2CPP branch — calls `addon.resolveExport` five times against `GameAssembly.dll`'s base to pre-resolve the recipe's known exports.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, zod, vitest (existing `mcp-server` toolchain — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-16-engine-fingerprint-design.md`

## Global Constraints

- No new native/C++ code — only `addon.listModules` and `addon.resolveExport`, both already exposed, are used.
- No remote calls (`call_remote_function`) — detection must be static/safe to run immediately on attach.
- Every branch in `classifyEngine` must return a valid result — no thrown errors for "no match," only the native-unknown fallback.
- Follow the existing `tools/*.ts` pattern exactly: `registerTool` config object with `description` + `inputSchema` (zod), handler returns via `ok()`/`err()` from `../toolResult`.

---

### Task 1: `classifyEngine` pure function + unit tests

**Files:**
- Create: `mcp-server/src/engineFingerprint.ts`
- Test: `mcp-server/tests/engineFingerprint.test.ts`

**Interfaces:**
- Consumes: `ModuleInfo` type from `mcp-server/src/addon.ts` (`{ name: string; base: string; size: number; timestamp: number; version: string | null }`).
- Produces (used by Task 2):
  ```ts
  export type EngineClassification =
    | { engine: 'unity-mono'; confidence: 'high'; monoDllBase: string }
    | { engine: 'unity-il2cpp'; confidence: 'high'; gameAssemblyBase: string }
    | { engine: 'unreal'; confidence: 'heuristic'; exeBase: string }
    | { engine: 'native-unknown'; confidence: 'low'; mainModuleBase: string; moduleCount: number }

  export function classifyEngine(modules: ModuleInfo[]): EngineClassification
  ```
  Detection order (first match wins):
  1. A module whose `name` (case-insensitive) is `mono.dll` or `mono-2.0-bdwgc.dll` → `unity-mono`, `monoDllBase` = that module's `base`.
  2. Else a module whose `name` (case-insensitive) is `GameAssembly.dll` → `unity-il2cpp`, `gameAssemblyBase` = that module's `base`.
  3. Else the first module in the list whose `name` (case-insensitive) ends with `-win64-shipping.exe` → `unreal`, `exeBase` = that module's `base`.
  4. Else → `native-unknown`, `mainModuleBase` = `modules[0].base` (the first module in the list — `list_modules`' own convention, matching how `attach`'s `baseAddress` and `list_modules`' first entry already correspond to the main executable elsewhere in this codebase), `moduleCount` = `modules.length`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { classifyEngine } from '../src/engineFingerprint'
import type { ModuleInfo } from '../src/addon'

function mod(name: string, base: string): ModuleInfo {
  return { name, base, size: 0x1000, timestamp: 0, version: null }
}

describe('classifyEngine', () => {
  it('detects Unity/Mono via mono.dll', () => {
    const result = classifyEngine([mod('game.exe', '0x1000'), mod('mono.dll', '0x2000')])
    expect(result).toEqual({ engine: 'unity-mono', confidence: 'high', monoDllBase: '0x2000' })
  })

  it('detects Unity/Mono via mono-2.0-bdwgc.dll, case-insensitively', () => {
    const result = classifyEngine([mod('game.exe', '0x1000'), mod('MONO-2.0-BDWGC.DLL', '0x3000')])
    expect(result).toEqual({ engine: 'unity-mono', confidence: 'high', monoDllBase: '0x3000' })
  })

  it('detects Unity/IL2CPP via GameAssembly.dll when no mono module is present', () => {
    const result = classifyEngine([mod('game.exe', '0x1000'), mod('GameAssembly.dll', '0x4000')])
    expect(result).toEqual({ engine: 'unity-il2cpp', confidence: 'high', gameAssemblyBase: '0x4000' })
  })

  it('prefers Mono over IL2CPP if both modules are somehow present', () => {
    const result = classifyEngine([
      mod('game.exe', '0x1000'),
      mod('GameAssembly.dll', '0x4000'),
      mod('mono.dll', '0x2000')
    ])
    expect(result.engine).toBe('unity-mono')
  })

  it('detects Unreal via *-Win64-Shipping.exe filename convention', () => {
    const result = classifyEngine([mod('Palworld-Win64-Shipping.exe', '0x5000'), mod('ntdll.dll', '0x9000')])
    expect(result).toEqual({ engine: 'unreal', confidence: 'heuristic', exeBase: '0x5000' })
  })

  it('matches the Unreal filename convention case-insensitively', () => {
    const result = classifyEngine([mod('SomeGame-WIN64-SHIPPING.EXE', '0x5000')])
    expect(result.engine).toBe('unreal')
  })

  it('falls back to native-unknown when nothing matches', () => {
    const modules = [mod('game.exe', '0x1000'), mod('kernel32.dll', '0x7000'), mod('ntdll.dll', '0x9000')]
    const result = classifyEngine(modules)
    expect(result).toEqual({
      engine: 'native-unknown',
      confidence: 'low',
      mainModuleBase: '0x1000',
      moduleCount: 3
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/engineFingerprint.test.ts`
Expected: FAIL — `Cannot find module '../src/engineFingerprint'`

- [ ] **Step 3: Write the implementation**

```ts
import type { ModuleInfo } from './addon'

export type EngineClassification =
  | { engine: 'unity-mono'; confidence: 'high'; monoDllBase: string }
  | { engine: 'unity-il2cpp'; confidence: 'high'; gameAssemblyBase: string }
  | { engine: 'unreal'; confidence: 'heuristic'; exeBase: string }
  | { engine: 'native-unknown'; confidence: 'low'; mainModuleBase: string; moduleCount: number }

const MONO_NAMES = new Set(['mono.dll', 'mono-2.0-bdwgc.dll'])

export function classifyEngine(modules: ModuleInfo[]): EngineClassification {
  const monoModule = modules.find((m) => MONO_NAMES.has(m.name.toLowerCase()))
  if (monoModule) return { engine: 'unity-mono', confidence: 'high', monoDllBase: monoModule.base }

  const gameAssemblyModule = modules.find((m) => m.name.toLowerCase() === 'gameassembly.dll')
  if (gameAssemblyModule) {
    return { engine: 'unity-il2cpp', confidence: 'high', gameAssemblyBase: gameAssemblyModule.base }
  }

  const unrealModule = modules.find((m) => m.name.toLowerCase().endsWith('-win64-shipping.exe'))
  if (unrealModule) return { engine: 'unreal', confidence: 'heuristic', exeBase: unrealModule.base }

  return {
    engine: 'native-unknown',
    confidence: 'low',
    mainModuleBase: modules[0].base,
    moduleCount: modules.length
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-server && npx vitest run tests/engineFingerprint.test.ts`
Expected: PASS, all 7 tests

- [ ] **Step 5: Commit**

```bash
cd mcp-server
git add src/engineFingerprint.ts tests/engineFingerprint.test.ts
git commit -m "$(cat <<'EOF'
feat: add classifyEngine for engine-fingerprint tool

Pure branch-selection logic (Mono/IL2CPP/Unreal/unknown) from a module
list, unit-tested directly with synthetic module lists -- no live
process or mocking needed for this half of the tool.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `fingerprint_process` MCP tool

**Files:**
- Create: `mcp-server/src/tools/fingerprint.ts`
- Modify: `mcp-server/src/server.ts` (register the new tool)
- Test: `mcp-server/tests/tools.test.ts` (add a `fingerprint tool` describe block)

**Interfaces:**
- Consumes: `classifyEngine` and `EngineClassification` from `../engineFingerprint` (Task 1); `addon.listModules`, `addon.resolveExport` from `../addon`; `ok`/`err` from `../toolResult`.
- Produces: the `fingerprint_process` MCP tool, registered via `registerFingerprintTools(server)`, called from `server.ts`.

The five IL2CPP exports to pre-resolve (constant list in this file):
`il2cpp_domain_get`, `il2cpp_domain_assembly_open`, `il2cpp_assembly_get_image`, `il2cpp_class_from_name`, `il2cpp_class_get_methods`.

Result JSON shapes returned via `ok(...)` (exactly one per branch, matching the spec):
```
unity-mono:      { engine, confidence, monoDllBase, playbook, note }
unity-il2cpp:    { engine, confidence, gameAssemblyBase, exports: { <name>: string | null, ... }, playbook, note }
unreal:          { engine, confidence, exeBase, playbook, note }
native-unknown:  { engine, confidence, mainModuleBase, moduleCount, playbook, note }
```

- [ ] **Step 1: Write the failing test**

Add to `mcp-server/tests/tools.test.ts` (new `describe` block, using the existing `FakeServer` class and `harness` process already set up in that file — the harness process has no mono/GameAssembly/Shipping-named modules, so it exercises the native-unknown branch end-to-end against a real attached process):

```ts
import { registerFingerprintTools } from '../src/tools/fingerprint'

describe('fingerprint tool', () => {
  it('fingerprint_process falls back to native-unknown for the plain test harness', async () => {
    const processServer = new FakeServer()
    registerProcessTools(processServer as unknown as McpServer)
    const attachResult = await processServer.call('attach', { pid: harness.pid })
    const { handle } = JSON.parse(attachResult.content[0].text as string)

    const server = new FakeServer()
    registerFingerprintTools(server as unknown as McpServer)
    const result = await server.call('fingerprint_process', { handle })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text as string)
    expect(parsed.engine).toBe('native-unknown')
    expect(parsed.mainModuleBase).toMatch(/^0x[0-9a-f]+$/)
    expect(parsed.moduleCount).toBeGreaterThan(0)
    expect(parsed.playbook).toContain('authoring-tamper-cheats')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/tools.test.ts -t "fingerprint_process falls back"`
Expected: FAIL — `Cannot find module '../src/tools/fingerprint'`

- [ ] **Step 3: Write the implementation**

`mcp-server/src/tools/fingerprint.ts`:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok } from '../toolResult'
import { classifyEngine } from '../engineFingerprint'

const IL2CPP_EXPORTS = [
  'il2cpp_domain_get',
  'il2cpp_domain_assembly_open',
  'il2cpp_assembly_get_image',
  'il2cpp_class_from_name',
  'il2cpp_class_get_methods'
] as const

export function registerFingerprintTools(server: McpServer): void {
  server.registerTool(
    'fingerprint_process',
    {
      description:
        'Identify an attached process\'s engine/runtime (Unity/Mono, Unity/IL2CPP, Unreal, or unknown) from its loaded modules, and return whatever key addresses are cheaply resolvable up front (module bases, and for IL2CPP the five exports its symbol-resolution recipe needs) plus a pointer to the matching playbook doc. Static only -- no remote calls, safe to run immediately on attach.',
      inputSchema: { handle: z.number().int() }
    },
    async (args: { handle: number }) => {
      const modules = addon.listModules(args.handle)
      const classification = classifyEngine(modules)

      switch (classification.engine) {
        case 'unity-mono':
          return ok({
            ...classification,
            playbook: 'docs/superpowers/specs/2026-07-30-mono-resolver-design.md',
            note: 'monoDllBase is ready to pass directly as every mono_* tool\'s monoDllBase param.'
          })

        case 'unity-il2cpp': {
          const exports: Record<string, string | null> = {}
          for (const name of IL2CPP_EXPORTS) {
            exports[name] = addon.resolveExport(args.handle, classification.gameAssemblyBase, name)
          }
          return ok({
            ...classification,
            exports,
            playbook: 'docs/superpowers/specs/2026-09-07-il2cpp-symbol-resolution-design.md',
            note: 'Recipe step 1 (resolve exports) is already done above -- start at step 2 (call il2cpp_domain_get).'
          })
        }

        case 'unreal':
          return ok({
            ...classification,
            playbook: 'docs/superpowers/specs/2026-09-03-ue5-reflection-design.md',
            note:
              'Detected by filename convention only (*-Win64-Shipping.exe); no live reflection bridge exists yet (Phase 1 not built). Use the five-recipe framework in that doc -- plain value-scan / write-watch RE, not name-based class resolution.'
          })

        case 'native-unknown':
          return ok({
            ...classification,
            playbook: '.claude/skills/authoring-tamper-cheats/SKILL.md',
            note: 'No known engine signature matched. Proceed with generic value-scan / write-watch / scan_aob discovery per the authoring-tamper-cheats skill.'
          })
      }
    }
  )
}
```

Modify `mcp-server/src/server.ts`: add the import and registration call, following the exact pattern of the other six:

```ts
import { registerFingerprintTools } from './tools/fingerprint'
```
and inside `createServer()`, alongside the other `register*Tools(server)` calls:
```ts
registerFingerprintTools(server)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-server && npx vitest run tests/tools.test.ts`
Expected: PASS, including the new `fingerprint tool` block and all pre-existing tests in the file (confirms the `server.ts` wiring didn't break anything else).

- [ ] **Step 5: Commit**

```bash
cd mcp-server
git add src/tools/fingerprint.ts src/server.ts tests/tools.test.ts
git commit -m "$(cat <<'EOF'
feat: add fingerprint_process MCP tool

Wires classifyEngine into a real MCP tool: lists modules, classifies,
and for the IL2CPP branch pre-resolves the five exports its symbol
resolution recipe needs (plain export-table lookups, no remote calls).
Routes every branch to its matching playbook doc.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: point `authoring-tamper-cheats` skill at the new tool

**Files:**
- Modify: `.claude/skills/authoring-tamper-cheats/SKILL.md`

**Interfaces:**
- Consumes: nothing code-level — this is a doc-only pointer to Task 2's shipped tool name (`fingerprint_process`).
- Produces: nothing consumed by later tasks (this is the last task in this plan).

- [ ] **Step 1: Add a pointer at the top of the skill's Overview section**

In `.claude/skills/authoring-tamper-cheats/SKILL.md`, immediately after the `## Overview` heading and before the existing "Live memory RE for this project..." paragraph, insert:

```markdown
**Start every new game by calling `fingerprint_process(handle)`** (right
after `attach`) — it identifies the engine/runtime from the module list
and hands back whatever key addresses are cheaply resolvable up front
(module bases, and for IL2CPP the five exports its resolution recipe
needs), plus which playbook doc below applies. Skip straight to that
playbook's recipe instead of manually checking `list_modules` for
`mono.dll`/`GameAssembly.dll`/a `*-Win64-Shipping.exe` name.

```

- [ ] **Step 2: Verify the file still parses as valid markdown with correct heading structure**

Run: `cd .claude/skills/authoring-tamper-cheats && head -30 SKILL.md`
Expected: the new paragraph appears right after `## Overview`, before the existing "Live memory RE for this project..." text, with no broken heading levels.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/authoring-tamper-cheats/SKILL.md
git commit -m "$(cat <<'EOF'
docs: point authoring-tamper-cheats at fingerprint_process

Skip manual list_modules triage now that fingerprint_process exists --
call it right after attach and go straight to the playbook it names.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

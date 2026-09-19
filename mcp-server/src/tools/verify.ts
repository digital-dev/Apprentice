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
    return {
      error: `cheat "${cheatId}" is a "${cheat.kind}" cheat, not a value cheat -- verify_cheat only supports value cheats`
    }
  }
  return cheat
}

export function monoOpsFor(handle: number): MonoResolveOps {
  return {
    resolveClass: (h, base, ns, cls) => addon.monoResolveClass(h, base, ns, cls),
    resolveField: (h, base, cls, field) => addon.monoResolveField(h, base, cls, field),
    staticFieldAddress: (h, base, cls, field) => addon.monoStaticFieldAddress(h, base, cls, field),
    readBytes: (address, length) => addon.tryReadBytes(handle, address, length)
  }
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
      return { supported: true, alive: false, value: null, expected: null, matches: null, kind: 'mono' }
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
    () =>
      addon.tryReadValue(
        handle,
        address as string,
        [target.baseOffset, ...target.offsets],
        target.dataType ?? cheat.dataType
      ),
    target,
    cheat.value,
    cheat.dataType
  )
  return { ...status, kind: 'chain' }
}

export function registerVerifyTools(server: McpServer): void {
  server.registerTool(
    'verify_cheat',
    {
      description:
        "Read-only: resolve a value cheat from a games/*.json profile by id and report each target's live status (resolves? current value? matches the expected value?) without writing anything. mono/chain targets resolve fully standalone; anchor targets always report unsupported (their address only exists in the running app's own capture-patch bookkeeping).",
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

      let monoDllBase = args.monoDllBase ?? null
      if (monoDllBase === null) {
        const classification = classifyEngine(addon.listModules(args.handle))
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

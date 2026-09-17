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

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as addon from '../addon'
import { ok, err } from '../toolResult'

// Generic remote-execution primitives for an attached process: resolve an
// exported function's address, allocate/write/free a small scratch buffer
// (for string args a remote call needs), and call an arbitrary function
// with up to 4 pointer-sized args on a throwaway remote thread.
//
// Built for IL2CPP symbol resolution — IL2CPP has no live reflection API
// the way Mono's mono_* exports give the mono_* tools in this same server,
// but its own il2cpp_* functions (il2cpp_domain_get, il2cpp_class_from_name,
// il2cpp_class_get_methods, ...) are ordinary exports in GameAssembly.dll,
// callable through these same primitives. Kept generic (not IL2CPP-specific
// tool names) since they're just as useful for calling any other exported
// function in a target process.
//
// A remote call is not free: each one spins up a real thread in the target
// process. Space out calls in a tight resolution loop rather than firing
// many in a burst — see mono_call.cc's own note on thread-churn crashes.
export function registerRemoteTools(server: McpServer): void {
  server.registerTool(
    'resolve_export',
    {
      description:
        "Resolve an exported function's address in a loaded module, by module base address + export name (e.g. a GameAssembly.dll il2cpp_* function). Returns null if the module has no such export.",
      inputSchema: { handle: z.number().int(), moduleBase: z.string(), name: z.string() }
    },
    async (args: { handle: number; moduleBase: string; name: string }) => {
      const address = addon.resolveExport(args.handle, args.moduleBase, args.name)
      return address === null ? err(`export not found: ${args.name}`) : ok({ address })
    }
  )

  server.registerTool(
    'alloc_scratch',
    {
      description:
        'Allocate a small (4KB) read/write/execute scratch buffer near an address in an attached process — for a string argument or small stub a remote call needs. Free it with free_scratch when done.',
      inputSchema: { handle: z.number().int(), near: z.string() }
    },
    async (args: { handle: number; near: string }) => {
      const address = addon.allocateCave(args.handle, args.near)
      return address === null ? err('allocation failed') : ok({ address })
    }
  )

  server.registerTool(
    'write_scratch',
    {
      description:
        'Write raw bytes (unspaced hex, e.g. from a UTF-8 string encoded to hex with a trailing 00) to an address in an attached process — meant for a buffer from alloc_scratch, not for patching arbitrary game memory.',
      inputSchema: { handle: z.number().int(), address: z.string(), hex: z.string() }
    },
    async (args: { handle: number; address: string; hex: string }) => {
      const wrote = addon.writeBytes(args.handle, args.address, args.hex)
      return wrote ? ok({ wrote: true }) : err(`write failed at ${args.address}`)
    }
  )

  server.registerTool(
    'free_scratch',
    {
      description: 'Free a scratch buffer previously returned by alloc_scratch.',
      inputSchema: { handle: z.number().int(), address: z.string() }
    },
    async (args: { handle: number; address: string }) => ok({ freed: addon.freeMemory(args.handle, args.address) })
  )

  server.registerTool(
    'call_remote_function',
    {
      description:
        'Call an exported/resolved function in an attached process on a throwaway remote thread, with up to 4 pointer-sized args (hex strings — use write_scratch first for a string arg). Returns the function\'s integer/pointer return value (RAX) as a hex string, or null on failure. Space successive calls out rather than firing many in a burst — each one is a real thread in the target process.',
      inputSchema: { handle: z.number().int(), functionAddress: z.string(), args: z.array(z.string()).max(4) }
    },
    async (args: { handle: number; functionAddress: string; args: string[] }) => {
      const result = await addon.callRemoteFunction(args.handle, args.functionAddress, args.args)
      return result === null ? err('remote call failed or timed out') : ok({ result })
    }
  )

  server.registerTool(
    'call_remote_function_float',
    {
      description:
        "Same as call_remote_function, but reads the called function's XMM0 register as a 32-bit float instead of RAX — for a function that returns float/double (RAX holds no meaningful value for those).",
      inputSchema: { handle: z.number().int(), functionAddress: z.string(), args: z.array(z.string()).max(4) }
    },
    async (args: { handle: number; functionAddress: string; args: string[] }) => {
      const result = await addon.callRemoteFunctionFloat(args.handle, args.functionAddress, args.args)
      return result === null ? err('remote call failed or timed out') : ok({ result })
    }
  )
}

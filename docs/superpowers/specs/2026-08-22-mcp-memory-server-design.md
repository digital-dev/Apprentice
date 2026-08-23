# MCP memory-scan server design

## Motivation

Building a cheat for a new field or code site currently means live
reverse-engineering against the running game: attaching, scanning for a
value, walking mono class/field names, watching what writes an address,
disassembling a hit. This session did exactly that for Valheim's damage
system by hand-writing throwaway Node scripts that `require()` the trainer's
own compiled native addon and call its exports directly (`attach`,
`monoListFieldNames`, `readBytes`, etc.) — it worked, but each script was
written from scratch, left no reusable interface, and had no schema to catch
a wrong argument before it ran against a live process.

An MCP server exposing the same native operations as typed tools removes the
script-per-session churn: attach once, get a `handle`, then call read/scan/
mono/disassemble tools directly instead of writing and running a new `.js`
file for each question.

## Non-goals

- **No write operations.** No `writeBytes`, `writeValue`, or patch
  injection. This server is for looking, not modifying — an explicit choice
  to keep it low-risk. Actual cheat writes continue through the existing,
  reviewed patch-engine flow (`src/main/patchEngine.ts`) once a site is
  found.
- **Not shipped in the trainer app.** This is a standalone dev-tool
  companion for RE sessions, not a feature of the Electron app end users
  run. It lives in its own top-level folder with its own `package.json`.
- **No persistent-beyond-one-session server.** It runs over stdio, spawned
  per Claude Code session by the MCP client, same lifecycle as any other
  local MCP server. Re-attaching each session is cheap; a long-lived
  background process able to survive a session restart is not worth the
  added lifecycle complexity (orphan handles, restart semantics) this
  project doesn't currently need.

## Constraint discovered during design

`native/src/write_watch.cc`'s `startWriteWatch` attaches via Windows
`DebugActiveProcess`, which allows only **one** debugger per process. This
server's `start_write_watch` tool and the Tamper app's own write-watch
feature (`Scanner.tsx`'s "find what writes" flow) cannot both be active
against the *same game process* at the same time — whichever attaches
second fails. Every other tool (`attach`, `read_bytes`, `scan_first`, the
mono introspection calls) uses plain `OpenProcess`, which has no such
limit and coexists fine with the Tamper app running normally. The
`start_write_watch` tool's description documents this exclusivity so it
surfaces at the point of use, not just here.

## Architecture

A standalone Node/TypeScript process at `mcp-server/` (repo root, sibling to
`native/` and `src/`), with its own `package.json` depending on
`@modelcontextprotocol/sdk`. It talks MCP over stdio — the standard local
transport — and is registered for this repo via a root-level `.mcp.json`
pointing at its entry point.

It requires the trainer app's own already-built native addon directly:

```ts
const addon = require(path.join(__dirname, '../../native/build/Release/memory_addon.node'))
```

— the same relative shape `src/main/nativeAddon.ts` already uses, and
confirmed working as a plain Node process during this session's live
exploration (no Electron ABI rebuild needed; `node-gyp build`'s default
output already links against plain Node).

**State model:** explicit, not global. `attach(pid)` returns `{ handle,
baseAddress }`; every other tool takes `handle` as an argument, exactly the
shape `nativeAddon.ts`'s own functions already have. This is deliberately
unlike `src/main/ipc.ts`'s Electron-side code, which holds one implicit
"currently attached" handle in module state — that shape fits a single-user
GUI with one attached game at a time, but a tool-calling session has no such
constraint and gains from being able to name which attachment a call applies
to (e.g. comparing two processes, or re-attaching after a game restart
without losing the ability to reference what came before in conversation).

## Components

**`mcp-server/src/addon.ts`** — the single `require()` of the native addon
and a thin, typed re-export of exactly the functions this server uses. Not
a copy of `src/main/nativeAddon.ts` (different process, different
build/runtime boundary — importing across the `src/main` Electron-main
boundary would couple two independent runtimes for no benefit); a small
duplication of the relevant type signatures is the right call here per
YAGNI — extracting a shared package for ~10 function signatures is not
worth the indirection.

**`mcp-server/src/tools/*.ts`** — one file per tool group, each exporting
its MCP tool definitions (name, JSON schema, handler):
- `process.ts`: `list_processes`, `attach`, `list_modules`
- `scan.ts`: `scan_first`, `scan_next`, `scan_aob`
- `mono.ts`: `mono_resolve_class`, `mono_resolve_field`,
  `mono_static_field_address`, `mono_list_field_names`,
  `mono_list_method_names`, `mono_list_assemblies`,
  `mono_list_classes_in_image` (plus `mono_list_assembly_names`, added
  during implementation: `mono_list_assemblies` alone returns only opaque
  handles, not useful for discovery on its own, so a name-pairing variant
  was needed to make the other two usable)
- `read.ts`: `read_bytes`, `read_value`
- `watch.ts`: `start_write_watch`, `poll_write_watch`, `stop_write_watch`
- `disasm.ts`: `disassemble_buffer`

**`mcp-server/src/server.ts`** — wires the tool groups into one
`@modelcontextprotocol/sdk` `Server`, connects it to a stdio transport, and
is the file `mcp-server/src/index.ts` (the package's `bin`/entry) runs.

## Error handling

Every tool handler wraps its native call and returns an MCP tool error
result (`isError: true` with a message) rather than letting an exception
cross the protocol boundary — for both real failures (bad handle, unmapped
address) and the addon's own "normal, expected" outcomes it already
represents as null/empty rather than a throw (unresolved mono class,
no AOB match, unreadable memory). This mirrors `nativeAddon.ts`'s existing
`tryReadValue`/`tryReadBytes` convention: routine "not found" is data the
caller (me) needs to see clearly, not a crash to recover from.

## Testing

- Unit tests call each tool group's handler functions directly (not over
  stdio) against the real `test-harness/harness.exe` the native suite
  already spawns and reads real values from — same pattern
  `tests/native/cave_ops.test.ts` uses, avoiding a second fake/mock layer
  for behavior the native tests already exercise honestly.
- One thin integration test drives the assembled server over an actual
  stdio JSON-RPC round trip (list tools, call `attach`, call `read_bytes`)
  to catch wiring mistakes the direct-handler tests can't see (schema
  registration, transport framing).

## Packaging

`mcp-server/package.json` is independent of the root `package.json` — this
is a separate Node program, not part of the Electron app's build. A root
`.mcp.json` registers it for this repo:

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

built via `mcp-server`'s own `tsc` (or run directly with `tsx` during
development — the plan decides which, and whether `dist/` is committed or
gitignored and built on demand).

# game-trainer-mcp-server

A standalone, read-only MCP server exposing the trainer app's native
memory-introspection primitives (attach / scan / mono-introspect / read /
disassemble / write-watch) as MCP tools over stdio, for live
reverse-engineering sessions against a running game. No write operations —
see `docs/superpowers/specs/2026-08-22-mcp-memory-server-design.md` at the
repo root for the full design rationale.

## Prerequisites

- Windows (the native addon it wraps is Windows-only).
- Node.js (matching the repo root's supported version).
- The trainer app's native addon already built at
  `native/build/Release/memory_addon.node`, relative to the repo root — this
  package `require()`s it directly (see `src/addon.ts`) rather than
  shipping its own copy. Build it with the native build step already
  documented in the repo root's `CODEBASE_MAP.md` ("Build and run" section):
  ```bash
  cd native && npx node-gyp configure && npx node-gyp build && cd ..
  ```

## Setup

```bash
cd mcp-server
npm install
```

`npm install` also builds `dist/` automatically, via the `prepare` script
(a standard npm lifecycle hook that runs after install) — no separate
`npm run build` call is needed for a fresh checkout. `.mcp.json` at the repo
root registers this server by pointing at `mcp-server/dist/index.js`, and
both `dist/` and `node_modules/` are gitignored, so this setup step must be
run once after cloning before the server (or the repo-wide test suite,
which spawns `dist/index.js` from `tests/integration.test.ts`) will work.

## Dependency notes

`package.json` pins `@modelcontextprotocol/sdk` to an exact version
(`1.22.0`, no `^`/`~`) rather than a range. This is deliberate, not
oversight: `@modelcontextprotocol/sdk` 1.23.0 introduced dual Zod v3/v4
generics in `registerTool`'s type signature that blow TypeScript's
instantiation-depth budget on this package's tool registration call sites —
symptom is `TS2589` (or an outright OOM) on a default Node heap. This
regression is still present as of the current latest release, 1.30.0, and
is tracked upstream at `modelcontextprotocol/typescript-sdk#1180`
(unresolved).

**Before bumping this pin past `1.22.x`**, run `npm run build` on a default
Node heap and confirm it exits 0 quickly — a clean build of this package
takes about 1-2 seconds. If it hangs or OOMs instead, the regression is
still present and the bump should not go in.

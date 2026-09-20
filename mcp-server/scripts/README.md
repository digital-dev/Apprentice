# Live-analysis scripts

Small, read-mostly Node scripts for working out *how a game actually does
something* before writing a cheat. They drive the built server code
(`../dist`), so run `npm run build` in `mcp-server/` first, and attach to a
running game by pid (`list_processes` gives it). None writes game memory; the
IL2CPP ones make a handful of `il2cpp_*` calls through one scratch buffer to
find the class table (see the IL2CPP spec), then only read.

All take the game's pid first and match classes by regex against the class
name (no namespace). They assume Unity IL2CPP with the layout in
`docs/superpowers/specs/2026-09-19-il2cpp-cheat-factory-design.md`.

| Script | Question it answers |
|---|---|
| `survey.js` | What fields (type, offset), statics and methods do these classes have? Writes a text file; grep it. |
| `disasm.js` | What does this method actually do? (`CLASSES`, `ROWS`, `BYTES` env vars.) Reads a getter to see which field it returns. |
| `callTree.js` | What does this method call? Names each `call`/`jmp` target; virtual calls stay raw. |
| `findCallers.js` | Who calls these methods? Shows when a getter is never called because callers inline the field read. |
| `findFieldReaders.js` | Which methods touch this field offset directly (inlined reads and writes)? The follow-up when `findCallers` finds nothing. |
| `makeReplace.js` | Build a persistent patch entry for an instruction span (`MINLEN`, `BYTES`, `ROWS` env vars; `AT=<address>` to pick an exact instruction). Grows the signature until it matches exactly once. Emits `replace` mode; change `mode` to `scale` and add `sourceRegister` and `value` for a scale patch. |
| `makeCapture.js` | Build a `capture` patch on a class's best hook site, as the factory would. |
| `watchBehaviours.js` | Example live watcher: poll fields while the game does something and log only changes. Written for one NPC class; adapt the class and offsets. |
| `recordSnapshot.js` | Record a game's executable memory (plus the readable margins around each region) to a local `.snap` for offline replay: `node recordSnapshot.js <pid> <game> <build> <out.snap> [id:address:length ...]`. Read-only; refuses to write game code inside the repo except `fixtures/snapshots/`. See "Fixture replay" in the top-level README. Loads the addon directly, so no `npm run build` needed. |
| `authorLive.js` | Run `author_cheats` for a category list without the MCP server attached. |

## Method (what these are for)

1. **Survey** the classes the wishlist item touches.
2. **Read the code** (`disasm`, `callTree`, `findCallers`): which field does the
   game really read, and which function do all routes share?
3. **Watch the real event** (`watchBehaviours` style) when the code is not
   enough. Reading code can name the wrong gate; a watcher that shows a live
   state change (an NPC switching behaviour) names the real route.
4. **Build the patch** (`makeReplace` / `makeCapture`), then have the user try
   it and **read memory** to see whether the bytes are applied and what
   changed.

Caveats: linear disassembly stops at function padding (3+ `int3`); a scan can
hit destroyed Unity objects (their native pointer at `+0x10` is 0); offsets are
per Unity version, so re-verify on another game.

## authorNativeLive.js

`node authorNativeLive.js <pid> <profilePath> <category,...>` runs the native (non-Unity) `author_cheats` path against an
attached game without the MCP server. Needs `npm run build` first. Known games are in `src/factory/nativeGames.ts`.

## Mono scripts

`surveyMono.js <pid> <out> [classRegex]` lists game classes with a live singleton, their fields, offsets and current values.
`monoReaders.js <pid> "<classRegex>" <offset,...>` compiles those classes' methods inside the game and prints instructions that
touch the offsets (`CONTEXT=n` adds preceding instructions so you can see where the base register came from). Offsets collide
across objects, so read the context before crediting a hit to a field. `authorMonoLive.js` runs `author_cheats` without the MCP server.

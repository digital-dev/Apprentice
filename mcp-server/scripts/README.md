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
| `findCallers.js` | Who calls these methods? The check that shows a getter is never called because callers inline the field read. |
| `makeReplace.js` | Build a persistent `replace` patch for an instruction span (`MINLEN` env var). Grows the signature until it matches exactly once. |
| `makeCapture.js` | Build a `capture` patch on a class's best hook site, as the factory would. |
| `watchBehaviours.js` | Example of a live watcher: poll fields while the game does something and log only changes. Adapt the class and offsets. |
| `authorLive.js` | Run `author_cheats` for a category list without the MCP server attached. |

## Method (what these are for)

1. **Survey** the classes the wishlist item touches.
2. **Read the code** (`disasm`, `callTree`, `findCallers`): which field does the
   game really read, and which function do all routes share?
3. **Watch the real event** (`watchBehaviours` style) when the code is not
   enough. Reading code found the wrong gate twice for police body searches; a
   watcher showed a checkpoint officer switching behaviour, which named the
   real route.
4. **Build the patch** (`makeReplace` / `makeCapture`), then have the user try
   it and **read memory** to see whether the bytes are applied and what
   changed.

Caveats: linear disassembly stops at function padding (3+ `int3`); a scan can
hit destroyed Unity objects (their native pointer at `+0x10` is 0); offsets are
per Unity version, so re-verify on another game.

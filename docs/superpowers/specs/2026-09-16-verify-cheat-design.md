# Read-only cheat verification tool — design

## Problem

Confirming a shipped cheat actually resolves and holds the right value is
currently manual: re-derive the target's live address by hand (module
base + offset math, or Mono class/field lookups) and read it with
`read_bytes`/`read_value`, one target at a time. Every design doc in this
project that shipped a cheat ends with "not yet verified through the app"
or "needs a live Tamper session" — this is a repeated, mechanical step
worth automating.

## Constraint discovered during design — no write path, and anchors are out of reach

This project has an established, deliberate safety boundary: **all
writes to live game memory go through the Electron app (`Tamper`)**,
wrapped in its own safety layers (thread-suspend, protect-write-restore,
byte-verify-before-install). `mcp-server`'s existing write primitives
(`write_scratch`, `write_bytes` used internally by
`call_remote_function`'s scratch buffers) are explicitly scoped to a
small MCP-owned scratch allocation, never arbitrary game memory. This
tool keeps that boundary intact — it is read-only, full stop.

That constraint has a real consequence for what's actually verifiable.
`CheatDefinition.targets` (`src/main/store.ts`) has three kinds:

- **`mono` (`MonoTarget`)** — resolved via live Mono reflection
  (class/field lookup + optional instance-pointer hops). Fully
  resolvable from raw game memory alone — no app state needed. `mcp-
  server` already exposes every primitive this needs
  (`mono_resolve_class`-equivalent addon calls, `tryReadBytes`).
- **`ChainTarget`** (no `kind` field — a plain scanned pointer chain:
  `moduleName` + `baseOffset` + `offsets`) — also fully resolvable
  standalone: module base (from `list_modules`) plus a fixed offset
  chain, read directly.
- **`anchor` (`AnchorTarget`)** — resolved via `patchEngine.slotAddress
  (target.patchId)` (`src/main/ipc.ts`), which only exists because the
  *running Electron app* has installed a `capture`-mode patch this
  session (a native hook that writes a captured register value into a
  scratch cave the app itself allocated). That slot address is
  in-process bookkeeping inside the Electron app's `PatchEngine`
  instance — it is not derivable from the game's own memory by an
  outside, unprivileged reader, and installing the capture patch
  yourself would be exactly the write this tool isn't allowed to do.

**Consequence**: this tool verifies `mono` and `chain` targets fully; for
`anchor` targets it reports an honest "unsupported — needs a live app
session with the capture patch installed" rather than a wrong answer.
Games that lean on Mono reflection (most Unity/Mono titles — anchor
patches exist specifically as an IL2CPP/native workaround, see
`2026-09-07-il2cpp-symbol-resolution-design.md`) get full automated
verification; anchor-heavy profiles (e.g. the current
`Palworld-Win64-Shipping.json`, entirely anchor-based) mostly won't,
until/unless a future bridge into the running app's live state is built
(a separate, bigger design decision, deliberately out of scope here —
see that doc's rejected "bridge to the app" option).

## Goal

One MCP tool, `verify_cheat`, that takes an attached handle, a
`games/*.json` profile path, and a cheat id, and returns per-target
live status (resolves? current value? matches the cheat's expected
value?) — without requiring the caller to manually re-derive any
address.

## Non-goals

- No writing to game memory, anywhere in this tool.
- No support for `anchor`-kind targets beyond an honest "unsupported"
  result (see above).
- No support for `PatchCheat`/`ScriptCheat` entries (code patches, Lua
  scripts) — this tool only verifies plain value `CheatDefinition`
  entries (`kind` absent or `'value'`), which is what has a `targets`
  array of resolvable-or-not addresses in the first place. A patch's
  "did it install" question is a different shape of check (byte
  comparison at the patch site, not a value read) and is not this
  tool's job.
- No new native code — everything needed already exists in
  `mcp-server/src/addon.ts` (`listModules`, `monoResolveClass`,
  `monoResolveField`, `monoStaticFieldAddress`, `tryReadBytes`,
  `tryReadValue`).

## Design

New file `mcp-server/src/tools/verify.ts`, registered in `server.ts`.
One tool:

```
verify_cheat(handle: number, profilePath: string, cheatId: string, monoDllBase?: string) -> VerifyCheatResult
```

`monoDllBase` is optional — if the profile's cheat has any `mono`
targets and `monoDllBase` isn't given, the tool calls `list_modules`
itself and looks for `mono.dll`/`mono-2.0-bdwgc.dll` (same detection
`fingerprint_process` already does — reuses `classifyEngine` from
`mcp-server/src/engineFingerprint.ts` rather than duplicating the
module-name check).

### Loading the cheat

Read `profilePath` with `fs.readFileSync` + `JSON.parse` (no need to
reuse the Electron app's `profile.ts` loader — profiles are plain JSON,
and this tool only ever reads, never writes, the file). Find the entry
in the parsed `cheats` array whose `id === cheatId` and whose `kind` is
absent or `'value'` (i.e., not a `PatchCheat`/`ScriptCheat`) — error
(`err(...)`) if not found or if it's the wrong kind, naming which.

### Per-target resolution

Ported logic (new, self-contained functions in `verify.ts` — not a
cross-package import of `src/main/monoTargetResolve.ts`, which
transitively pulls in `electron` through its own import of `ipc.ts` and
would throw in `mcp-server`'s plain Node process):

**`mono` targets** — reimplements `resolveMonoTargetAddress`'s algorithm
(`src/main/monoTargetResolve.ts:22-69`) against `mcp-server`'s own addon
calls:
1. `addon.monoResolveClass(handle, monoDllBase, '', target.className)`
2. `addon.monoStaticFieldAddress(handle, monoDllBase, classHandle, target.staticFieldName)`
3. If no `instanceFieldName`: that address is the target.
4. Else: resolve `instanceClassName ?? className`, resolve
   `instanceFieldName`'s offset via `addon.monoResolveField`, read 8
   bytes at the static address via `addon.tryReadBytes` and decode as a
   little-endian pointer (`Buffer.from(hex, 'hex').readBigUInt64LE(0)`
   — zero means "not touched yet this session", not an error), add the
   field's offset.
5. If `pointerFieldOffset` is also set: one more hop, same pattern
   (dereference the first-hop address, add the raw offset).

**`ChainTarget`** (no `kind`): `addon.listModules(handle)`, find the
module named `target.moduleName`, resolve via `addon.tryReadValue
(handle, moduleBase, [target.baseOffset, ...target.offsets],
dataType)` — this single call already walks the whole pointer chain and
reads the final value (existing addon behavior, same as every other
chain-resolving tool in this codebase).

**`anchor`**: no resolution attempted — always reports
`{ supported: false, reason: 'anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only' }`.

### Value matching

Mirrors `ipc.ts`'s `valueMatches` (`src/main/ipc.ts:359-362`) exactly:
float/double within `1.0` of expected, everything else exact equality.
Mirrors the per-target `value`/`dataType` override convention (target's
own `value`/`dataType` wins over the cheat's, exactly as `store.ts`
documents on `MonoTarget`/`AnchorTarget`/`ChainTarget`). `bitIndex`
targets extract just that bit before comparing, matching `ipc.ts`'s
`extract` helper (`src/main/ipc.ts:385-386`) — reporting the raw byte
for a bit-owning target would show a nonsensical value.

### Result shape

```json
{
  "cheatId": "example-id",
  "name": "Example Cheat",
  "targets": [
    {
      "kind": "mono",
      "supported": true,
      "alive": true,
      "value": 99999,
      "expected": 99999,
      "matches": true
    },
    {
      "kind": "anchor",
      "supported": false,
      "reason": "anchor targets require a capture patch installed by the running app; not resolvable from a static profile read-only"
    }
  ]
}
```

`alive`/`value`/`matches` are `null` when `supported` is `false`, or
when a supported target simply doesn't resolve right now (Mono runtime
not loaded, object pointer not set yet this session — routine, not an
error, matching every other resolver in this codebase's "can't resolve
right now" convention).

### Error handling

- Profile file doesn't exist / isn't valid JSON → `err(...)`, not a
  thrown exception.
- Cheat id not found, or found but wrong kind (patch/script) →
  `err(...)` naming the problem.
- Every per-target resolution failure is represented in the result
  shape (`alive: false` / `supported: false`), never a thrown error —
  matching `mono_resolve_class` and friends' existing "not found is
  data, not an exception" convention.

### Testing

Same approach as `engineFingerprint.test.ts`: the resolution algorithms
(mono target address resolution, chain resolution, value matching, bit
extraction) are pure enough to unit-test directly against a fake
`MonoResolverOps`-shaped set of callbacks (no live process needed for
the algorithm itself) — mirroring how `monoTargetResolve.ts`'s own
design separates the algorithm from its `ops`. The full
`verify_cheat` tool is additionally exercised once against the real
test harness process (`tests/tools.test.ts`, same `FakeServer` +
`harness.exe` pattern as every other tool test in that file) for a
`chain`-kind target (resolvable without a live Mono runtime, unlike
`mono`, and without the harness needing to fake a capture patch, unlike
`anchor`) written into a small temp profile JSON fixture.

## Follow-on note (not in this spec's scope)

If anchor-target verification becomes valuable enough to build later,
the honest way to do it is a bridge into the running app's live
`PatchEngine` state (a new local endpoint on the Electron app,
read-only), not a workaround inside `mcp-server` — that's a distinct
architecture decision with its own trade-offs, not a natural extension
of this tool.

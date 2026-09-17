# Engine fingerprint tool — design

## Problem

Every new game starts the same way: attach, then manually figure out
which of the existing playbooks applies — check `list_modules` for
`mono.dll` (Mono resolver), or its absence plus `GameAssembly.dll`
(IL2CPP symbol resolution), or a `*-Win64-Shipping.exe` name (Unreal,
five-recipe framework) — before any real RE starts. This is a fixed,
mechanical first step repeated per game, and part of it (resolving the
IL2CPP recipe's five exports) is also a fixed first step *within* the
IL2CPP playbook itself.

## Goal

One MCP tool, `fingerprint_process`, that takes an attached handle and
returns: which engine/runtime this is, and whatever key addresses are
cheaply resolvable up front — so the first message in a new-game
session is "here's your engine and starting addresses," not several
tool calls of manual triage.

## Non-goals

- No new native (C++) code. Everything needed already exists:
  `addon.listModules` and `addon.resolveExport` (both already
  MCP-exposed via `list_modules` / `resolve_export`) are sufficient.
- No engines beyond what this project already has a playbook for:
  Unity/Mono, Unity/IL2CPP, Unreal (heuristic only — Phase 1 reflection
  bridge isn't built), and an honest native/unknown fallback. Godot,
  older Unreal, generic custom-engine games are not specifically
  detected; they fall into the fallback bucket without a false-positive
  guess.
- No live/remote calls (no `call_remote_function`). Detection and
  address resolution here must be static (module list + export table
  parsing) — the tool has to be safe to run immediately on attach with
  zero risk of crashing the target, which a remote call always carries
  (per the IL2CPP design doc's landmine).

## Design

New file `mcp-server/src/tools/fingerprint.ts`, registered in
`server.ts` alongside the other `register*Tools` calls. One tool:

```
fingerprint_process(handle: number) -> FingerprintResult
```

Implementation is pure orchestration over already-exposed addon calls
— `addon.listModules(handle)` then, for the IL2CPP branch only,
`addon.resolveExport(handle, moduleBase, name)` per export. No new
addon/native binding required.

### Detection order and per-branch result shape

Checked in this order (first match wins):

**1. Unity/Mono** — a module named `mono.dll` or
`mono-2.0-bdwgc.dll` is present.

```json
{
  "engine": "unity-mono",
  "confidence": "high",
  "monoDllBase": "0x7ffabc120000",
  "playbook": "docs/superpowers/specs/2026-07-30-mono-resolver-design.md",
  "note": "monoDllBase is ready to pass directly as every mono_* tool's monoDllBase param."
}
```

**2. Unity/IL2CPP** — no `mono*.dll`, but `GameAssembly.dll` is
present. Resolve the five exports the IL2CPP recipe's step 1 needs,
via `resolveExport` against `GameAssembly.dll`'s base — these are
plain PE export-table lookups, not remote calls, so this carries none
of the remote-call risk:

- `il2cpp_domain_get`
- `il2cpp_domain_assembly_open`
- `il2cpp_assembly_get_image`
- `il2cpp_class_from_name`
- `il2cpp_class_get_methods`

```json
{
  "engine": "unity-il2cpp",
  "confidence": "high",
  "gameAssemblyBase": "0x7ff6a0000000",
  "exports": {
    "il2cpp_domain_get": "0x7ff6a0123450",
    "il2cpp_domain_assembly_open": "0x7ff6a0123460",
    "il2cpp_assembly_get_image": "0x7ff6a0123470",
    "il2cpp_class_from_name": "0x7ff6a0123480",
    "il2cpp_class_get_methods": "0x7ff6a0123490"
  },
  "playbook": "docs/superpowers/specs/2026-09-07-il2cpp-symbol-resolution-design.md",
  "note": "Recipe step 1 (resolve exports) is already done above — start at step 2 (call il2cpp_domain_get)."
}
```

If any export fails to resolve, include it as `null` in `exports`
rather than failing the whole call — a partially-stripped build is
still useful information, and the caller can fall back to resolving
the missing one manually.

**3. Unreal (heuristic)** — no Mono/IL2CPP signal, and the main
module's filename matches `*-Win64-Shipping.exe` (Epic's standard
packaging convention). This is a naming heuristic, not a structural
check, so it's reported as such, and — since Phase 1 of the UE
reflection bridge (`ue_bridge.cc`, GObjects/GNames) isn't built yet —
there is no address to hand back beyond the module base:

```json
{
  "engine": "unreal",
  "confidence": "heuristic",
  "exeBase": "0x7ff700000000",
  "playbook": "docs/superpowers/specs/2026-09-03-ue5-reflection-design.md",
  "note": "Detected by filename convention only (*-Win64-Shipping.exe); no live reflection bridge exists yet (Phase 1 not built). Use the five-recipe framework in that doc — plain value-scan / write-watch RE, not name-based class resolution."
}
```

**4. Fallback — native/unknown** — none of the above matched.

```json
{
  "engine": "native-unknown",
  "confidence": "low",
  "mainModuleBase": "0x7ff600000000",
  "moduleCount": 47,
  "playbook": ".claude/skills/authoring-tamper-cheats/SKILL.md",
  "note": "No known engine signature matched. Proceed with generic value-scan / write-watch / scan_aob discovery per the authoring-tamper-cheats skill."
}
```

### Error handling

`fingerprint_process` itself cannot fail in the normal sense — every
branch above is reachable and every branch returns a valid result, so
there's no error path to design beyond what `list_modules` already
has (an invalid `handle` errors the same way it does for every other
tool, unchanged). Individual `resolveExport` misses are represented as
`null` fields, not thrown errors, per the IL2CPP branch note above.

### Testing

Unit-testable without a live process: `addon.listModules` and
`addon.resolveExport` are already exercised elsewhere; this tool's own
logic is pure branching over their return values, so a test can mock
those two addon calls directly (same pattern likely already used for
other `tools/*.ts` unit tests — check existing test setup for the
established mocking approach before adding a new one) and assert the
branch selection and result shape for: mono present, GameAssembly
present, Shipping.exe-named main module, and none of the above with
a partial-export-resolution case (IL2CPP with one export missing).

## Follow-on note (not in this spec's scope)

Once this ships, `authoring-tamper-cheats` SKILL.md should get a
one-line pointer at the top: "call `fingerprint_process` first" —
that's a small doc edit to make after this tool exists, not part of
implementing the tool itself.

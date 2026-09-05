---
name: authoring-tamper-cheats
description: Use when investigating a live game process with the game-memory MCP server to find an anchor/offset for a new Tamper cheat, or when a shipped cheat does nothing / breaks something it shouldn't.
---

# Authoring Tamper Cheats via game-memory MCP

## Overview

Live memory RE for this project (Tamper/Apprentice, `games/*.json`
profiles) follows a small set of proven moves plus a few sharp edges in
the `game-memory` MCP tools — most learned the hard way, including a
shipped-then-reverted cheat.

## Which recipe is this?

Name which of the five patterns
(`docs/superpowers/specs/2026-09-03-ue5-reflection-design.md`) the cheat
is before scanning anything:

| Recipe | Shape | Tamper mode |
|---|---|---|
| A — struct field, per-player singleton | one object, always the same instance | `capture` anchor + `freeze`/`force` |
| B — one-time flag, not a continuous value | a system-disable switch, not a threshold | one-shot write, never `freeze` |
| C — compiler-baked immediate, no reflection | `sN` in a CE script, fixed byte offset | `replace`/`nop` |
| D — captured pointer, not a per-field anchor | GodMode/speed-style: one pointer, many fields off it | `capture` + several targets |
| E — world/global singleton | not per-player, may not need a capture at all | plain value scan first |
| Shared data-table row, different instance every call | crafting/building requirement checks | `strip` (see below) — none of A-E fit |

Getting this wrong wastes the session: an anchor recipe (A/D) on a
shared-row target freezes whichever instance was current at capture time,
not the one the game is using right now.

## Anchor discovery: the proven loop

1. **Value-scan the on-screen number directly** rather than guessing a
   struct layout first. Watch for scaling — this engine's `FixedPoint64`
   stores the displayed value ×1000 as an int64; scanning for the raw
   displayed number instead reads as GPU-driver noise, not the field.
2. **`start_write_watch`** the address, then trigger the change in-game.
3. **If the caught instruction is a shared/generic leaf** (an engine-wide
   setter called from dozens of sites — a `mov [rcx],rax; ret`-shaped
   3-instruction leaf is the tell), don't anchor there. Read
   `stackTop[0]` as the caller's return address, disassemble backward from
   it, and find the call site that set up the register for THIS field —
   that site, not the shared leaf, is the durable module-relative anchor.
4. **Verify the signature is unique** with `scan_aob` before writing it
   into a profile — extend the byte window until it returns exactly 1
   match. A short, "obviously" unique opcode sequence routinely isn't.

## `scan_first` / `scan_aob` sharp edges

- **`scan_aob` only searches executable/code memory**, not read-write heap
  data. Use it for locating instructions, never for hunting a struct
  instance on the heap (recipe data, player objects) — it silently returns
  zero matches there, indistinguishable from "not found."
- **Common values return huge result sets.** When a result is too large
  for context, the tool auto-saves it to a local file — read/intersect
  those files locally (a short Python one-liner) instead of pulling a huge
  JSON array into context.
- **Narrowing without a second risky scan:** if the user can change the
  value in-game, scan again after and intersect the two candidate sets
  locally (works even when both are individually huge). If two fields are
  spatially related (adjacent struct slots N bytes apart, e.g. two
  material-cost slots), self-intersect one scan's result set shifted by
  that offset instead of risking a second scan for a value that's itself
  too common.
- `kMaxScanResults` (`native/src/scanner.cc`) caps result size to keep the
  MCP transport from crashing on a pathologically common value — if a scan
  still returns a huge set, narrow the value or bound `rangeStart`/
  `rangeEnd` rather than relying on the cap alone.

## When to reach for `strip` mode

Use `strip` (`docs/superpowers/specs/2026-09-04-strip-patch-mode-design.md`)
specifically when the target is a **shared data-table row** — a different
instance is current on every invocation (a recipe row, a build-object
template), so a `capture` anchor is wrong (it freezes whichever instance
happened to be current the moment it was captured). `strip` re-reads the
live register on every invocation, writes several fixed-offset fields off
it, then replays the original (read) instructions — contrast:

- `capture` — records a register **once**, for a per-player singleton.
- `force` — writes **one** field, **replacing** the original write.
- `freeze` — polls and overwrites via a timer loop, for a value the anchor
  target keeps changing on its own.

## Before shipping: verification discipline

**A confirmed-correct offset is not enough — verify the *mechanism* live.**
Zeroing/freezing a **threshold or count** is usually safe (materials
needed, hunger level). Zeroing/freezing a **rate or per-tick multiplier**
is often catastrophic in the opposite direction: it can stop the very
system it was meant to speed up (a craft-progress rate zeroed to "make it
instant" instead freezes progress at 0 forever — the failure looks nothing
like the intended effect, which is itself the tell that the mechanism, not
just the offset, was wrong).

If a shipped cheat's live test is ambiguous, does nothing, or actively
breaks something: **revert immediately**, don't leave it shipped "to
investigate later." A cheat that installs cleanly but silently does
nothing is exactly as bad as one that's missing.

Also check whether the exact code pattern you found is **compiled more
than once** in the binary (once per subclass sharing a base layout is
common). A `scan_aob`-unique signature only guarantees you found *an*
occurrence, not the one the game actually exercises for the case you
tested — verify against more than one real-game scenario (multiple item
types, multiple building types) before trusting full coverage.

## Environment gotchas

- **`Apprentice.cmd` runs a pre-built `out/main/index.js`.** Restarting the
  app does NOT pick up `src/` changes — run `npm run build` first.
- **The native addon (`native/build/Release/memory_addon.node`) needs
  `node-gyp build`** after any `native/src/` change, and the file locks
  while any running Apprentice instance or `mcp-server` process holds it
  open — close/kill those first (check with `tasklist`/
  `Get-CimInstance Win32_Process` if the build fails with "permission
  denied").
- **Module base shifts across game restarts (ASLR); the RVA
  (`moduleOffset`, relative to base) doesn't.** Tamper resolves
  `module.base + moduleOffset` fresh each session, so a shipped cheat
  doesn't need updating — but a live investigation address computed this
  game session is not reusable literally in a later one; recompute
  `base + RVA` after any reattach.

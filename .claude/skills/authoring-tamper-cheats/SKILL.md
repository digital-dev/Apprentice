---
name: authoring-tamper-cheats
description: Use when investigating a live game process with the game-memory MCP server to find an anchor/offset for a new Tamper cheat, or when a shipped cheat does nothing / breaks something it shouldn't.
---

# Authoring Tamper Cheats via game-memory MCP

## Overview

**Start every new game by calling `fingerprint_process(handle)`** (right
after `attach`) — it identifies the engine/runtime from the module list
and hands back whatever key addresses are cheaply resolvable up front
(module bases, and for IL2CPP the five exports its resolution recipe
needs), plus which playbook doc below applies. Skip straight to that
playbook's recipe instead of manually checking `list_modules` for
`mono.dll`/`GameAssembly.dll`/a `*-Win64-Shipping.exe` name.

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

## Cheat category → recipe lookup

Byte-level templates don't port across games (or even across builds of
the same game — see the IL2CPP note above and the "session finding" in
`2026-09-03-ue5-reflection-design.md` where most signatures from a
third-party trainer had gone stale). What *does* port is the mapping from
a wishlist item's **category** to which recipe shape it almost always
turns out to be, plus the mistakes already paid for once discovering it —
check this before spending a session rediscovering the same lesson:

| Wishlist category | Usual recipe | Known landmine |
|---|---|---|
| Health / shield / stamina / mana pools ("unlimited X") | A — per-player struct field | The *max* value is sometimes only ever computed (not stored) — don't chase it; freezing *current* high is sufficient for invincibility and the max-value hunt is often a dead end. |
| Hunger / thirst / fatigue / any continuously-decaying stat ("never X") | Looks like A, is actually **B** | Freezing a continuously-decaying field loses the race against the game's own tick — a 100ms freeze loop cannot out-write logic that runs every frame. Find the system's decay-enable flag/switch and write it once instead. |
| Craft/build speed, "instant X" duration-sounding fields | Looks like a duration to zero, is often a **rate/multiplier** | Zeroing a per-tick progress rate doesn't make it instant — it freezes progress at 0 forever (the opposite of the goal). Before writing anything, live differential-test: watch the field's value change while the action runs normally, correlate against the visible progress, and confirm zero speeds it up rather than halting it. |
| Craft/build material or requirement removal | Shared data-table row → **`strip`** | The same struct-copy/requirement-check code is often compiled more than once (once per subclass/object-type sharing a layout) — a signature that's unique in `scan_aob` still only patches *one* occurrence. Test every distinct item/building type with the cheat on before trusting full coverage; patch every occurrence that's actually exercised. |
| Currency / points / resources with a spend-side check | A, anchored at the **spend/subtract** instruction if possible | A generic replicated-property setter (virtual dispatch into an engine-wide property-copy/memcpy) is a false anchor shared by every property of that type — if write-watching a candidate lands in a generic copy routine rather than game-specific code, keep looking for a sibling candidate that goes through real, specific logic (the actual subtract/spend check) instead. |
| Movement speed / jump / godmode-style toggles | D — captured player pointer | Capture once (write-watch any known player-object field's write, e.g. jump count), then every other field off that same pointer is cheap — don't re-derive the pointer per field. |
| World/global settings (drop rate, damage multiplier, work speed, time scale) | E — try a **plain value scan first** | Cheapest recipe to even attempt: a world-settings singleton is far more likely to be a stable global than a per-player heap struct, and may need no capture patch at all. Don't reach for capture-patch machinery before ruling this out. |
| One-time flags / mode switches (stealth mode, disable a requirement system) | B — one-shot write, never `freeze` | Wording is a signal: "no X" / "disable X" in the wishlist usually means a flag, not a threshold — treat "unlimited X" and "no X" as different recipes by default, and verify which one it actually is before assuming. |
| Compiler-baked immediates (a fixed threshold baked into a compare, found via CE `sN` wildcards) | C — `replace`/`nop`, no anchor | If the cheat needs genuinely NEW inserted logic (not just replacing/nopping existing bytes — e.g. an extra `xor`/comparison ahead of the original code), it doesn't fit Tamper's fixed cave encoders; needs a Lua script cheat instead of a code patch. |

**Cheapest-first attempt order**, confirmed across sessions: E (plain
scan) → A (once any anchor for that struct is known, each additional
field off it is nearly free) → D (one capture, many cheap fields after)
→ B (needs a live differential-write test, can't skip it) → C (mechanical
per-cheat but every single signature needs live re-verification, no
shortcut).

**Scaled/fixed-point value gotcha** (any category above): if a plain
scan for the on-screen number returns nothing in the game's own module
but lands in GPU-driver-owned generic buffer-copy memory instead, suspect
a scaled encoding (e.g. an int64 storing the displayed value ×1000)
before suspecting a wrong process or a bad scan — the naive displayed
value was never in game memory to begin with.

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

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

**IL2CPP game (no `mono.dll` in `list_modules`, `mono_*` tools return
empty)?** Byte-pattern/AOB porting from a reference CT table usually
can't carry forward alone — most real tables name hook sites as bare
`Namespace.Class.Method` symbols with no AOB signature at all. Read
`docs/superpowers/specs/2026-09-07-il2cpp-symbol-resolution-design.md`
first: it's a fully-worked, repeatable recipe (six generic remote-call
MCP tools already wired up) for resolving any such symbol to a real,
current-build address without needing a live in-game trigger — plus two
live-fire landmines (identical-code-folding making some exports lie about
their own signature, and a bad pointer arg crashing the target outright)
worth knowing before making a single remote call.

## Fast path: `author_cheats` (Unity/Mono and Unity/IL2CPP)

For a Unity game, run this first — it replaces the per-cheat RE loop for
the common categories (health, stamina, mana, money, bank, cash, water,
curfew, freezetime, runspeed, godmode). `hunger`, `speed`, `nosearch` and `cash`
are reported as **manual** with the reason: each was tried as a field cheat
and is the wrong shape (see the evidence-loop section below). Categories are data in
`mcp-server/src/factory/categories.ts`: add name hints there for a new game
before reaching for manual RE:

1. `attach`, `fingerprint_process` (must report `unity-mono` or `unity-il2cpp`).
2. Get the player into a world/save (live instances must exist).
3. `author_cheats(handle, ["health","bank","cash","curfew"], "games/<exe>.json")` (any category ids above).
4. Read the result. `checklist` lists each drafted cheat with `verified`
   (was a live instance read with a plausible value?), `liveValue`, and
   `multiInstanceRisk` (a capture hook records whichever instance ran
   last). `unresolved` = matched but no plausible value or no hookable
   method; `notFound` = no field matched (fall back to the recipes below);
   `manual` = hunger/speed, known landmines, do by hand.
5. Toggle each drafted cheat in Tamper from `games/<exe>.draft.json` and
   check its `lookFor` line. Move confirmed entries into the real profile.

**IL2CPP** drafts are a `capture` patch (on the owning class's `Update`,
found by unique signature) plus an `anchor` value cheat — the same pair
existing IL2CPP profiles in `games/` use. Mono drafts are plain `mono` value cheats.
IL2CPP details worth knowing: enumeration reads runtime structs directly
(never `il2cpp_class_get_fields`, which can be a folded stub); the addon
caps reads at 4096 bytes; a game running MelonLoader/Harmony may already
have detoured method starts, which the hook chooser refuses. Layout offsets
are per Unity version and re-verified each run (see the IL2CPP factory spec).

**Native games** (`fingerprint_process` says `native-unknown`, e.g. Elden Ring) work only when listed in
`mcp-server/src/factory/nativeGames.ts`: root signatures plus offset chains, verified live. To add one, see
`docs/superpowers/specs/2026-09-20-native-cheat-factory-design.md`. Value cheats only; patches stay hand-authored.

It only writes the draft file, never game memory or the live profile
(beyond one scratch buffer for a few `il2cpp_*` calls). Other engines get
an error naming the playbook; use the recipes below.
Design: `docs/superpowers/specs/2026-09-19-cheat-factory-design.md` and
`docs/superpowers/specs/2026-09-19-il2cpp-cheat-factory-design.md`.

## When a cheat doesn't work, or the mechanism isn't obvious: read the code, then watch the game

Confident guesses from field and method *names* fail often; evidence does not.
The scripts are in `mcp-server/scripts/` (see its README); each is read-only.

1. **Read what the game really does.** Disassemble the getter or setter to see
   which field it touches, and find its callers. IL2CPP **inlines trivial
   getters**, so a getter with no callers is not a lever: patching it changes
   nothing, because the readers load the field directly. Search for readers of
   the field's offset, not just callers of its accessor.
2. **Find the choke point.** When several routes reach one behaviour, patch the
   function they all share rather than each gate. A flag on the *player* rarely
   controls an *NPC's* decision (search, arrest, detect, attack): find the
   actor and its decision function.
3. **Watch the real event.** When reading code is not enough, poll the relevant
   fields read-only while the user triggers the event (`watchBehaviours.js`
   shows the shape). A live state change often names a route that the call
   graph hides behind virtual calls or callbacks.
4. **After the user toggles it, read memory.** Are the patch bytes applied? Did
   the field change? That separates "not applied", "applied at the wrong site"
   and "written but not shown" in one step. Never say a cheat works because it
   was drafted: say what was read live and what was not run in-game.

Sharp edges, each of which cost a round trip:

- **Live vs leftover objects.** A scan for a class pointer also finds destroyed
  Unity objects still sitting in memory. Their native pointer at `+0x10` is 0
  and their values are stale, so a game can appear to have two managers with
  only one alive. Freed slots reused as noise also read as plausible numbers, so
  a scan is not proof: `author_cheats` demands a non-zero plausible value and
  refuses when more than 16 candidates match.
- **A capture only fires when the hooked method runs.** Hooking a rarely called
  method of an *item* means "the game never ran the capture hook" until that
  event happens. Hook a per-frame method on a **holder** singleton (an
  inventory, a manager) and reach the item with an anchor `derefOffset`. Find
  the holder by reading how the game's own accessor for that item ends.
- **Shared classes need a gate.** A value that lives on a generic helper type
  (a stack of multipliers, a timer, a wrapper) is shared by many systems.
  Patching the helper affects all of them; patch at a site that only the target
  system executes, or gate the patch to it.
- **Read-modify-write sites vs consuming sites.** A load of a field is not
  always where the value is *used*: a smoothing/lerp step reads and writes the
  same field. Scaling there corrupts the stored value and everything that reads
  it. Scale where the value is consumed, or you change the state, not the effect.
- **`const` fields have no storage.** A "static" field that sits at offset 0
  with the same value as its neighbours is a compile-time constant baked into
  the code as an immediate: there is nothing to write. Look for the instance
  field or scale the product where it is consumed.
- **Prefer a `scale` patch at the consuming site over freezing an input.**
  Find where the code multiplies its factors into the final value (a chain of
  `mulss` ending in the result) and scale that register (`sourceRegister`
  plus `value`). It needs no instance capture, leaves every stored field alone
  (so nothing else that reads them changes), and only affects the code path it
  sits in. The patch site must be a whole instruction with no branch or
  rip-relative operand, after the register holds the final product (scale runs
  before the displaced instruction).
- **Identical-code folding.** One method pointer can belong to several classes'
  MethodInfos (trivial getters). A hook there fires for whichever class calls
  it: refuse any pointer owned by more than one class.
- **Disabling a freeze does not restore anything.** Give the cheat an
  `offValue` (a known default) when the game never puts the field back itself.
  `captureOriginal` is racy for anchors: it reads before the hook has run, so
  the snapshot is empty.
- **One-shot Apply on an anchored cheat** needs the capture patch installed and
  the hook to have run; Tamper's `applyOnce` does both and reports failure.
- **Writing a value does not refresh the UI.** The visible number updates when
  the game raises its UI event (click it, open the panel). Do not call the UI
  method yourself from an injected thread: Unity's text APIs are main-thread
  only and can crash the game.
- **A frozen value may feed other systems.** Freezing a multiplier to speed
  something up can also scale things that read it (animation, camera). Prefer
  the value only the target system reads, or scale it where it is consumed.
- **Signature uniqueness.** Wildcarding addresses makes IL2CPP prologues
  collide (a 71-byte signature still matched 11 places). Extend into the method
  body until exactly one match, typically 70 to 150 bytes.
- **Early-return patch.** At a function's entry, replace the first whole
  instructions with `xor eax,eax; ret` plus nops (`33 c0 c3 ...`). It is valid
  for void, bool and pointer returns, and safe because no stack change has
  happened yet.

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
| NPC-decided behaviour (search, arrest, detect, attack: several routes reach one decision) | Method-level `replace` at the function all routes share | A player-side flag is not the lever. Read callers, then watch which state turns on (see the section above). |
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

**For `mono`/plain-chain targets, call `verify_cheat(handle, profilePath,
cheatId)` before eyeballing anything manually** — it resolves the shipped
cheat's targets and reports live status (resolves? current value?
matches?) read-only, no address re-derivation by hand. It cannot verify
`anchor` targets (their address only exists in the running app's own
capture-patch bookkeeping) — those still need a live Tamper session.

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
- **Restart Tamper after editing a profile or rebuilding the app.** It loads a
  profile once and can overwrite an on-disk edit the next time it saves; and
  `Apprentice.cmd` runs the pre-built bundle, so app changes need
  `npm run build` first.
- **The addon caps a read at 4096 bytes** (larger reads return null, not a
  short read). Chunk big reads (`mcp-server/src/factory/chunkedRead.ts`).
- **The Edit dialog does not expose `offValue`** (or `derefOffset`): set them
  in the profile JSON.

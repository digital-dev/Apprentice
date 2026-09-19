# Cheat factory (`author_cheats`) — design

## Problem

Authoring a full cheat list for a new game takes far longer than 30
minutes because each cheat is its own RE session: find the field, pick a
recipe, write the profile entry, verify it. For reflection-capable
engines (Mono, UE5) the field is already discoverable by name, and the
category → recipe mapping is already written down in
`.claude/skills/authoring-tamper-cheats/SKILL.md`. That knowledge lives
in prose; nothing executes it.

## Goal

One MCP tool, `author_cheats(handle, wishlist, profilePath)`, that turns
a wishlist of cheat categories into draft, pre-verified profile entries
plus a single live checklist, so the human does one in-game pass instead
of one session per cheat. Target: full list for a Mono game in ~30 min.

## Constraints

- The MCP server is read-only against game memory by policy
  (`2026-09-16-verify-cheat-design.md`). The factory writes only draft
  profile JSON files, never game memory.
- `anchor` targets cannot be verified outside the running Electron app.
  Mono and chain targets can.
- No new native code. Everything needed exists in `mcp-server/src/addon.ts`.
- "Persistent" = the existing schema-2 profile mechanism (module RVA /
  Mono reflection re-resolved every session). Surviving game updates is
  out of scope.

## Design

New pure module `mcp-server/src/cheatFactory.ts` and tool file
`mcp-server/src/tools/author.ts`.

1. **Category table** (data): per category — name-hint regexes, expected
   data type, recipe (A–E, strip), Tamper mode, default value, landmine
   flags (`decays`, `rate`, `sharedRow`). Executable form of the skill's
   lookup table.
2. **Enumerators** (per engine): return `{class, field, type, isStatic}[]`.
   Mono via `mono_list_*`; UE via `ue_list_field_names`. Thin adapters.
3. **Ranker**: scores fields per category (name match, type fit, class
   match such as `Player`/`Character`); returns top N with scores.
4. **Emitter**: builds schema-2 `CheatDefinition` entries into
   `games/<exe>.draft.json`. Never edits the live profile.

Flow: `fingerprint_process` → pick enumerator → enumerate → rank →
apply recipe (landmine flags override the naive choice: decaying stats
get a one-shot write not `freeze`; rate fields are never zeroed, flagged
for manual review) → emit drafts → `verify_cheat` each → return a
checklist (cheat, target, current value, what to watch for on screen,
top alternate candidate). Human toggles each in-game once; confirmed
drafts are promoted into the real profile by hand.

## Engine coverage

- **Mono**: full — resolves and verifies end to end.
- **UE5**: enumerate/rank/emit work; results are anchor/capture drafts,
  unverifiable by MCP, marked "needs live Tamper session".
- **IL2CPP**: no field enumerator exists (only symbol resolution by
  name). Out of scope; ranker/emitter are reusable once one exists.

## Error handling

- No candidate above a score threshold → category reported as
  "not found", never a low-confidence guess emitted as a draft.
- Enumerator returns empty (wrong engine/protected process) → tool
  errors with the fingerprint result.
- `verify_cheat` failure on a draft → draft kept but listed as
  "unresolved" in the checklist.

## Testing

- Unit: ranker and emitter against fixture field lists taken from
  `games/valheim.json` and `games/aviassembly.json`; assert known
  targets (`m_stamina`, `m_health`, `m_godMode`) are re-derived and
  landmine flags change the emitted mode.
- Live (Valheim): run the factory and compare drafts to the hand-authored
  profile; target ≥80% of the same targets.

## Non-goals

- No game-memory writes. No auto-promotion into the live profile.
- No native-game scan/write-watch automation (deferred approach C).
- No IL2CPP field enumeration.

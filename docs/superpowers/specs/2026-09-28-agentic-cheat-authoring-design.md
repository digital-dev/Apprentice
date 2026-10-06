# Agentic cheat authoring fallback — design

## Problem

`author_cheats` (`mcp-server/src/factory/categories.ts`) is deliberately
dumb: name/regex match against live fields, freeze/oneshot if the value
looks plausible. That covers per-instance stat fields (health, stamina,
money, curfew flags) but nothing function-shaped — a computed gate like
"is this shop item unlocked" or "can this item be placed here" has no
field to point at; the answer comes from a comparison inside a method
body. Every such cheat so far (No Body Search, Place Anywhere, Unlock All
Shop Items, the Instant-* production patches) was hand-built in a live
chat session: survey classes → disassemble candidates → trace callers →
identify the real gate → pick a recipe from the skill's lookup table →
verify a unique signature → write the patch. That process is not written
down anywhere as a repeatable procedure; each session re-derives it.

The user asked for the factory to "read and understand the game's
functions, do necessary agent lookups for data about the game and its
mechanics, and author cheats it thinks would be beneficial" — i.e.
formalize that manual process into something any future session (or
agent) can follow consistently, without re-deriving it from scratch.

## Non-negotiable constraint

The MCP server (`mcp-server/`) is a plain Node process with no LLM in
it — it exposes mechanical tools (disassemble, find callers, scan
memory, read live values) but cannot itself "understand" code semantics
or search the web. All reasoning in this design happens in the calling
agent (Claude, driving the existing MCP tools plus a web-search tool),
not in new TypeScript. This is a documented workflow, not a new service.

## Decisions (from user Q&A)

1. **Shape**: a documented subagent workflow, not new heuristics inside
   the MCP server. `categories.ts`/the ranker stay exactly as they are.
2. **Trigger**: wishlist-driven fallback only. No unprompted/proactive
   scanning of a game to propose cheats the user never asked for. The
   fallback activates when a requested cheat doesn't match any
   `categories.ts` entry (`notFound`/`manual`) or was never a category
   to begin with (a gate, a UI lock, a placement check).
3. **Invocation surface**: a new section inside the existing
   `authoring-tamper-cheats` skill, not a separately-named skill. Same
   entry point users and agents already know; it just goes further when
   the fast path can't.
4. **Investigation isolation**: the noisy part (surveying classes,
   disassembling candidates, most of which are dead ends) runs in a
   `fork` subagent that inherits the live game handle/context and
   returns a distilled report, keeping that noise out of the parent's
   context — the same shape used for the Place Anywhere / Unlock Shop
   investigations in this conversation, just made procedural.
5. **External lookups**: web search for the game's own mechanics (wiki
   pages, guides) is in scope, used to point investigation at the right
   classes/keywords before RE, not to skip RE. Code is still the source
   of truth for what a patch actually does; web results only save blind
   guessing about names.
6. **Safety bar**: identical checklist as manual RE, no exceptions — the
   skill's landmines (decay-race, rate-zeroing, shared/generic helper,
   identical-code folding, multi-occurrence data-table rows, signature
   uniqueness) apply regardless of who/what found the target.
7. **Output target**: writes straight to the live `games/<exe>.json`
   with an "untested in-game" note when unconfirmed — matching this
   session's actual hand-authored convention, not `author_cheats`'
   draft-only behavior. The corresponding `games/<exe>-notes.md` gets the
   same mechanism writeup every hand-authored cheat in this repo already
   gets.

## Procedure (new skill section)

Given a wishlist item that doesn't match a category:

1. **Survey.** `mcp-server/scripts/survey.js <pid> <outFile> "<keyword-regex>"`
   against class-name keywords from the wishlist item (e.g. "Shop",
   "Unlock", "Build", "Place", "Grid"). If nothing plausible turns up,
   broaden the regex or web-search the game's own name for the mechanic
   ("Schedule I shop unlock rank system") to learn what it's actually
   called internally before re-surveying.
2. **Disassemble candidates.** `disasm.js` on methods whose names suggest
   they gate the behavior (`Is*Valid`, `Can*`, `*Unlocked`, `Check*`,
   `Update`/`LateUpdate` for per-frame state). Read what each one
   actually touches — never trust a name alone.
3. **Trace the real mechanism**, not the first hit: `findCallers.js` /
   `findFieldReaders.js` to follow a promising field or thunk back to
   its concrete, non-polymorphic implementation (IL2CPP virtual-dispatch
   thunks are 3-instruction stubs — `mov rax,[rcx]; mov rdx,[rax+N];
   jmp [rax+M]` — never the real logic; keep tracing).
4. **Classify the recipe** using the skill's existing "Which recipe is
   this?" and "Cheat category → recipe lookup" tables. This step is
   unchanged by this design — it's the same table, just now reached from
   a function-shaped starting point instead of a field-shaped one.
5. **Build the patch** with `makeCapture.js`/`makeReplace.js` as
   appropriate, or by hand for `strip`/`scale`/`force` shapes those
   scripts don't cover.
6. **Verify signature uniqueness live** via `scan_aob` (the scripts do
   this automatically; hand-built patches must do it explicitly) before
   the patch is considered done — never ship a signature with more than
   one match.
7. **Run the full safety checklist** from "Before shipping: verification
   discipline" — rate/duration fields need a live differential test
   before zeroing; multi-occurrence data-table code needs testing against
   more than one item/building type; shared/generic helpers need a gate,
   not a blanket patch.
8. **Write to the live profile** (`games/<exe>.json`) with a `note`
   field explaining the mechanism and callers found, same style as
   existing hand-authored entries, and mirror that explanation into
   `games/<exe>-notes.md`. Mark unconfirmed mechanisms "untested
   in-game" rather than asserting they work.

## Fork usage

The parent agent dispatches a `fork` with a directive prompt naming the
wishlist item, the game's pid/handle, and pointers to the survey/disasm
scripts — not a re-explanation of background the fork already has via
inherited context. The fork returns:

- the mechanism found (what it read, what it traced, what it ruled out)
- the proposed cheat JSON entry/entries
- confidence and any landmine flags raised
- the verification evidence (signature match count, live field reads)

The parent reviews that report against the checklist itself before
writing anything — a fork's summary describes what it did, not
inherently a decision the parent should apply unexamined (same "trust
but verify" rule as any other subagent use).

## Non-goals

- No unprompted/proactive game-wide scanning to propose a cheat list the
  user didn't ask for.
- No changes to `mcp-server/src/factory/` — `categories.ts`, the ranker,
  and the emitter are untouched. This is a skill-level procedure, not new
  software.
- No new MCP tools. Web search is the calling agent's own tool, not a
  server capability.
- No relaxed safety bar for agent-found targets — the same checklist a
  human RE session follows applies unconditionally.
- No auto-promotion beyond what hand-authored sessions already do
  (writing to the live profile with an honest "untested" note is the
  existing convention here, not a new risk introduced by this design).

## Testing

There's no unit-testable artifact (this is a procedure, not code). The
validation is: the next time a wishlist item doesn't match a
`categories.ts` entry, does an agent following the skill reach a
correctly-targeted patch without re-deriving the process from scratch?
Retroactive check: this procedure, applied to this session's own Place
Anywhere and Unlock Shop Items work, matches what was actually done —
it's a write-up of a validated process, not an untested new one.

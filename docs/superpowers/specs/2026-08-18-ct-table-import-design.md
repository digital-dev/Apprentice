# Query and import Cheat Engine tables from GitHub

## Problem

Cheat import today is local-file-only (`ct:import` opens a file picker) and
`ctImport.ts` recognizes exactly one shape: an Auto Assembler script that
replaces one write with a fixed constant (`force` mode). Two real gaps sit
behind "let users download and import cheats easily":

1. No way to find/fetch a `.CT` table without already having it on disk.
2. `ctImport.ts` silently drops plain (non-scripted) value entries and any
   Auto Assembler script that isn't the single "replace with a constant"
   shape — both common in real tables.

FearlessRevolution/OpenCheatTables (the usual CT-table sites) are forums
behind bot-protection with no API and unclear scraping terms — investigated
and rejected as a source (see prior discussion; not repeated here). GitHub
hosts real, openly-licensed `.CT` repositories (verified: a working Valheim
table exists at `themaoci/Game-Cheat-Tables-CE-`) and has a stable,
legitimate, unauthenticated-friendly API — that's the source this design
uses.

WeMod is out of scope entirely: its cheats run inside a closed client
against a private backend with no published data format — nothing to fetch.

## Goal

Let a user search GitHub for a game's `.CT` table, fetch one, and import it
through the existing (extended) `ctImport.ts` pipeline with the same
immediate-import/no-confirm-step convention local import already has.
Extend that pipeline to also convert plain value entries and two more
Auto Assembler shapes (nop-out, register-copy) that real tables use.
CE Lua Cheat Table entries and arbitrary computed-effect AA scripts stay
unsupported — reported, not guessed at, same as today.

Three components, expected to become three implementation plans:

1. `ctSource.ts` — GitHub search/fetch (no dependency on 2 or 3).
2. `ctImport.ts` extensions — plain values + nop-shape AA (no dependency on 3).
3. `cave_ops.cc`/`patchEngine.ts` — a new `copy` cave mode (2's
   register-copy shape depends on this existing before it's useful, but can
   land as "parsed, install refused" first if sequenced separately).

## Design

### Component 1: `ctSource.ts` (new, main process)

A small curated list of known open CT-table repos, hand-maintained:

```ts
interface CtRepo {
  owner: string
  repo: string
  branch: string // e.g. "main"
}

const CT_REPOS: CtRepo[] = [
  { owner: 'themaoci', repo: 'Game-Cheat-Tables-CE-', branch: 'main' },
  { owner: 'The-Grand-Archives', repo: 'Elden-Ring-CT-TGA', branch: 'main' },
  { owner: 'The-Grand-Archives', repo: 'Dark-Souls-III-CT-TGA', branch: 'main' },
  { owner: 'Hexorg', repo: 'CheatEngineTables', branch: 'main' },
  { owner: 'grasmanek94', repo: 'cheat-tables', branch: 'main' },
  { owner: 'bbfox0703', repo: 'Mydev-Cheat-Engine-Tables', branch: 'main' }
  // extend as more verified open repos are found; no auto-discovery —
  // every entry here has been manually checked to actually host .CT files.
]
```

```ts
export interface CtSearchResult {
  repo: string // "owner/repo"
  path: string // full path within the repo
  name: string // basename, for display
}

export async function searchCtTables(gameName: string): Promise<CtSearchResult[]>
export async function fetchCtTable(result: CtSearchResult): Promise<string> // raw XML
```

- `searchCtTables` calls, per repo, `GET
  https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
  (unauthenticated — no PAT required for this endpoint at this volume),
  filters entries whose path ends `.ct`/`.CT`, and keeps those whose path
  case-insensitively contains `gameName`. Results across all repos are
  concatenated.
- Each repo's tree is cached in-memory (`Map<string, TreeEntry[]>`) for the
  process lifetime — a repeat search within one session costs zero extra API
  calls, keeping well under the unauthenticated 60 req/hour cap even
  searching all curated repos back to back.
- `fetchCtTable` does a plain `GET
  https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}` — not
  rate-limited the way the API host is.
- Both are injected-fetch functions (`fetch: typeof globalThis.fetch` as a
  parameter, defaulted) so `tests/main/ctSource.test.ts` can run against a
  fake without a real network call, matching this codebase's existing
  "pure function, fake dependency" test convention (`patchEngine.ts`'s
  `PatchOps` interface, `anchor.ts`'s `AnchorOps`).
- **Failure is a normal result, not a crash**: no network, a 403/404, or a
  malformed tree response all resolve to an empty result / a thrown error
  the IPC handler turns into a banner message — this app works fully
  offline otherwise, and this feature must degrade to "unavailable"
  without touching anything else.

### Component 2: `ctImport.ts` extensions

**Plain value entries.** A `CheatEntry` whose `VariableType` is one of
`Byte`/`2 Bytes`/`4 Bytes`/`Float`/`Double` (mapped to this codebase's
`DataType`: `int8`/`int16`/`int32`/`float`/`double`) instead of `Auto
Assembler Script`. Its `<Address>` is either:

- a bare hex literal → a fixed-address `ChainTarget` (`moduleName: ''`,
  `baseOffset` the address, `offsets: []`), or
- `"module.exe"+hex` with a following `<Offsets><Offset>...</Offset>...`
  block → a full `ChainTarget` (`moduleName`, `baseOffset`, `offsets`,
  reading CE's offsets in the order CE stores them — outermost first,
  matching this codebase's own `ChainTarget.offsets` convention already
  used by scan-resolved chains).

Produces a `CheatDefinition` (`mode: 'freeze'`, the value taken from
`<LastState><LastValue>` if present, else `0`), not a `PatchCheat`.
`CtImportResult.imported` becomes `(PatchCheat | CheatDefinition)[]`; the
existing `ct:import` save loop (`for (const patch of imported) saveCheat
(...)`) already works unchanged since `saveCheat` takes `StoredCheat`.

**Nop-shape AA.** Extend the Auto Assembler parser to isolate the effect
body — the text between the `newmem:`-equivalent label and the
`code:`/`originalcode:`-equivalent label CE's template uses — stripping
comments and blank lines. If that body is **provably empty**, classify as
`nop` mode: the `aobscan`/`db` pair already supplies everything `nop` mode
needs (no register/offset/value). This is a positive-match rule only —
never inferred from "no `mov` line matched," which would misclassify an
unrecognized computed effect (e.g. `imul`/multi-instruction bodies) as a
silent no-op. Anything non-empty and not matching an already-recognized
shape stays unsupported/skipped with a reason, exactly as today.

**Register-copy AA.** A new sibling pattern to the existing `mov
[reg+offset], constant` match: `mov [reg1+offset], reg2` (register source
instead of a literal/immediate). Produces a `PatchCheat` with `mode:
'copy'`, `baseRegister: reg1`, `fieldOffset: offset`, `sourceRegister:
reg2` (new field, no `value`/`dataType`). Depends on Component 3 existing
to actually install; if sequenced first, it's parsed and stored but
`patchEngine.ts` refuses to apply it with a clear "not yet supported"
reason (no partial/best-effort install).

### Component 3: native `copy` cave mode

`native/src/cave_ops.cc`: new `encodeCopyStore(cave, baseRegister,
fieldOffset, sourceRegister)`, sibling to the existing `encodeStore` —
emits one `mov [baseReg+fieldOffset], srcReg32` instead of a literal
32-bit immediate. Cave layout is unchanged (`effect + tail + jmpBack`,
identical to `force`) — every existing safety mechanism applies as-is and
is reused, not reimplemented: displaced-run validation (refuses a run
containing a RIP-relative instruction, a relative branch, or a flow
terminator), byte-match verification before install, thread suspension
during the write, restore-on-disable/detach/quit. Only the effect
instruction's bytes differ from `force`'s.

**v1 scope: general-purpose registers, int32 width only.** No XMM/float
source register (a different encoding family — `movss`/`movsd` — real
additional work) and no arithmetic on the copied value. This stays one
well-defined primitive alongside the existing four, not a step toward a
general assembler — matching the "no general Auto Assembler interpreter"
principle `ctImport.ts`'s own module comment already states.

`store.ts`: `PatchCheat.mode` gains `'copy'`; new optional
`sourceRegister?: string`, meaningful only when `mode === 'copy'`.
`patchEngine.ts`: new `case 'copy'` branch alongside `force`/`capture`/
`guard`, requiring `baseRegister`/`fieldOffset`/`sourceRegister` in place
of `value`/`dataType`; refuses to install (clear error, not a crash) if
`sourceRegister` is absent — mirrors every other mode's existing
missing-field refusal pattern.

### IPC / preload / renderer

New channels, placed beside the existing `ct:import`/`ct:export`:

```ts
ipcMain.handle('ctSource:search', async (_e, gameName: string) => {
  try {
    return { results: await searchCtTables(gameName) }
  } catch (err) {
    return { results: [], error: String(err) }
  }
})

ipcMain.handle('ctSource:fetch', async (_e, exeName: string, result: CtSearchResult) => {
  let xml: string
  try {
    xml = await fetchCtTable(result)
  } catch (err) {
    return { importedNames: [], skipped: [{ description: result.name, reason: String(err) }] }
  }
  const { imported, skipped } = importCheatTable(xml)
  for (const cheat of imported) saveCheat(exeName, cheat)
  return { importedNames: imported.map((c) => c.name), skipped }
})
```

Same "pick = confirm, save immediately, return a summary" convention as
`ct:import` — picking a search result is the confirm gesture, no separate
step. `preload/index.ts` and `tamper.d.ts` get matching entries beside the
existing `importCheatTable`/`exportCheatTable`.

`CheatList.tsx`: new "Search online (.CT)" button beside the existing
Import/Export buttons, opening a small modal — a text input (game name,
defaulted to the current profile's display name), a "Search" button, a
result list (`repo` + `name`), each row's click calling `ctSource:fetch`
and rendering the same import-summary banner `ctImportResult` already
uses (imported count + names, skipped count + reasons, Dismiss). No new
banner component — reuses the existing one with the same shape.

## Out of scope

- CE Lua Cheat Table entries — different XML shape, separate project (same
  boundary the existing Lua-scripting spec already drew).
- Arbitrary computed-effect AA (arithmetic, multi-instruction bodies,
  calls) — stays unsupported/skipped; no general assembler is built.
- XMM/float source registers for `copy` mode.
- GitHub code-search / auto-discovery of new repos — the curated list is
  hand-maintained; no crawling.
- A GitHub PAT / authenticated higher-rate-limit path — v1 stays
  unauthenticated; revisit only if the curated list's search volume
  actually hits the 60/hr cap in practice.
- Ranking/deduplicating multiple hits for the same game across repos
  beyond a flat list — user picks by eye.

## Testing

- `tests/main/ctSource.test.ts`: `searchCtTables`/`fetchCtTable` against an
  injected fake fetch — filename matching, cross-repo aggregation, cache
  reuse on a second call, and error propagation on a failed/malformed
  response.
- `tests/main/ctImport.test.ts` (extend): a plain 4-byte/float entry with a
  bare address, one with a module+offset pointer chain, a genuinely-empty
  AA effect body (nop-shape), a register-copy AA script, and — unchanged —
  the existing force-mode and unsupported-shape cases stay green.
- `tests/native/cave_ops.test.ts` (extend): install a `copy`-mode patch
  against the harness, confirm the target reflects the source register's
  live value at trigger time, following the existing `encodeStore`
  coverage pattern.
- `patchEngine.test.ts` (extend): `copy` mode's missing-`sourceRegister`
  refusal, mirrored on the existing per-mode missing-field refusal tests.

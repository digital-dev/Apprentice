# Code-Patch Cheats (#6) — Carried Follow-Ups

Triaged during the task-by-task and whole-branch reviews of #6 and deliberately
carried rather than fixed, so the branch's scope stayed the feature itself.
None of these block merge. Ordered by the value of fixing them, not by severity
labels.

The three non-negotiable safety rules they are all judged against:

- Never write NOPs to an address whose bytes are neither the captured original
  nor already-NOPs.
- Ambiguous relocation (AOB scan with 0 or >1 match) → "can't relocate", never
  patch a guess.
- Always restore original bytes on disable and on detach/app-exit.

## Real-game findings (Valheim, 2026-07-25)

The manual validation pass against Valheim found more than the automated
suite ever could. Fixed during the pass, each verified against the harness:
AOB signatures were built from a single instruction and matched hundreds of
places (992 in the harness, 575 in Valheim), making every JIT patch
unrelocatable; closing the app mid-capture killed the game via a queued
debug exception delivered after detach; the capture panel discarded a scan
on every save; and the instruction matcher ignored index registers and
required an exact rather than covering effective-address match.

What remains unresolved, and matters more than any of the above:

- **Patching Valheim's stamina writers is not reliably safe.** Of the
  instructions caught watching a stamina address, one cleanly disabled
  regeneration, one blocked movement, one blocked running, and two crashed
  the game outright. Nothing stopped stamina drain.
- Two mechanisms could explain the crashes and they were not separated:
  the AOB may relocate to a *different* copy of identical JIT'd code (Mono
  emits identical bodies for generic instantiations, so `locate`'s
  verify-bytes-match check passes at the wrong instance), or the NOPped
  store may be load-bearing, leaving a field uninitialised that something
  later dereferences. Distinguishing them needs a disassembly view around
  the patch site — the tool shows bytes, never context.
- **Value cheats do not survive a restart for Mono-heap objects.** Confirmed
  empirically. A scanned pointer chain reaches the Player object through
  whatever path existed that session; after a restart the object has moved
  and the chain resolves to nothing. A durable path needs Mono metadata
  traversal (domain → assembly → class → static field), which this codebase
  has no notion of. That is a limitation of the original design, not of the
  patch feature.
- **Patch relocation across a restart was never proven either way** — the
  hunt never produced a patch worth keeping long enough to test it.
- A `movs`-style block copy still cannot be attributed to a field: the
  destination register auto-advances, so the post-trap register state no
  longer points at the watched address. `wideloop` in the harness covers
  this case and it is deliberately left undecoded.

Read together: the feature is mechanically correct and proven against the
harness, and is not yet an effective tool against a Mono/IL2CPP game. The
next step is a design conversation about anchoring to the runtime's own
metadata, not more repairs here.

## Worth doing next

**`ipc.ts` lifecycle wiring has no tests.** Restore-on-re-attach, restore-on-
delete, and `restoreAllPatches` are the three places the "never leave code
modified" promise is actually kept, and all three are verified only by reading.
This is where the whole-branch review's most serious finding (the UI adopting an
already-applied patch without telling the engine) was hiding — no per-task
review could see it. `PatchEngine` takes an injected `PatchOps`, so driving the
handler bodies with a fake engine is cheap.

**`ParseSignature` was never hardened the way `HexToBytes` was.**
`native/src/patch_ops.cc` — `ParseSignature` still uses `strtoul` on a 2-char
buffer, so `-1` and `+1` tokens are accepted and truncate to `0xff`. Same
translation unit, same bug class the `0f4e5db` fix round closed on the write
path; only the write path got the nibble decoder. Impact is bounded — a bogus
signature yields wrong matches, and `locate`'s byte verification still refuses
to write — but the two should be consistent. Reuse `HexNibble`.

**A failed protection restore is invisible.** `writeBytes` discards the return
of both the restoring `VirtualProtectEx` and `FlushInstructionCache`, and still
returns `true`. If the restore fails, the target's page stays
`PAGE_EXECUTE_READWRITE` forever — exactly the residue the comment above it says
the feature must never leave. Fold the restore result into the returned boolean,
or at minimum log it.

**`restore`/`restoreAll` write original bytes without reading first.**
`src/main/patchEngine.ts`. For a JIT region freed and re-used between apply and
restore, this stamps stale instruction bytes into unrelated memory. The design
deliberately makes the applied-set authoritative and the spec endorses that, so
this is a judgment call — but a cheap upgrade is to read `length` bytes first and
skip the write when they are no longer NOPs: if they aren't ours, our patch is
already gone and there is nothing to undo.

## Testing gaps

- No test pins `scanAob`'s executable-regions-only filter. Planting a known byte
  sequence in a harness *data* global and asserting `scanAob` does NOT return it
  would pin what is currently only a comment.
- No test for the page-straddle refusal — a deliberate, deviating behaviour with
  zero coverage. Write across a known page boundary in the harness, assert
  `false` plus unchanged memory.
- `FakeOps` in `tests/main/patchEngine.test.ts` models memory as whole-blob-per-
  address rather than byte-addressable, so an overlapping or wrong-length write
  is invisible to every engine test.
- Untested matrix cells: signature-anchored × `applied`/`mismatch`, and `restore`
  returning `false` and retaining its entry on write failure. The retain-on-
  failed-restore path is safety-relevant and cheap to add.

## Cleanups

- Add `PatchEngine.restoreById(id)` and drop `cheats:delete`'s disk lookup. The
  engine already holds everything needed; the lookup can silently skip a restore
  if disk state and in-memory state disagree (a latency bug, not a leak — the
  next re-attach or quit still restores).
- `src/renderer/src/tamper.d.ts` re-declares `PatchState`/`PatchStatus` instead
  of type-importing them from `patchEngine.ts`. Two copies of a four-member union
  will drift, and the copy the renderer compiles against is the one that isn't
  the engine's.
- `removePatch` is not busy-guarded. Deleting mid-apply orphans the on-disk
  record (the in-memory applied-map still restores the bytes, so no code is left
  modified). A one-liner now that `patchBusy` exists.
- `locate` conflates "module not loaded" with "found but unreadable" by returning
  `address: null` for both, so the status chip can only ever say "can't
  relocate".
- `ParseHex` is now duplicated in three native translation units. House pattern,
  but a shared `hex_util.h` would be cheap.
- `_beginthreadex`'s thread handle is never `CloseHandle`d in the harness's
  `drainloop`/`watchloop`. Test infrastructure only; pre-existing pattern.
- The `val`-decoy rationale for `catchDrainInstruction` lives only in a test
  comment; a pointer near `harness.c`'s `val` declaration would help the next
  reader, since the bug is easy to reintroduce.
- `store.test.ts` calls `.filter(isPatchCheat)` twice in one test instead of
  storing the result.
- `locate` evaluates `current.toLowerCase()` twice.

## Performance

- Locate-on-load is sequential: each JIT patch triggers a full executable-memory
  AOB walk, with no loading indicator. Several JIT patches on a large game will
  populate the chips slowly.
- `scanAob` allocates a buffer the size of each executable region. Consistent
  with the value scanner, but a JIT-heavy game with a very large RX region will
  spike RSS.

## Known-and-accepted, with the reasoning

**Id collision is narrowed, not eliminated.** Patch ids are now namespaced
`patch-<slug>`, but a value cheat literally named "Patch Health" still slugs to
`patch-health` and collides with a patch named "Health". `saveCheat` replaces by
id, so a collision is silent data loss.

**Pre-existing on-disk patch cheats keep their old unprefixed ids.** No migration
was written, and that was the right call: every id consumer (`store.ts`,
`ipc.ts`'s `cheats:delete`, `PatchEngine`'s applied map, `freezeLoop`) uses plain
string equality with no format assumption, so old records still save, load,
toggle, restore and delete. A silent rewrite would have to be sequenced against
`PatchEngine`'s in-memory applied map — which is keyed by the OLD id for anything
applied in the current session — so a naive migration could orphan an applied
patch's restore entry.

**Same-pid re-attach skips `restoreAll`, and that is correct.** `Attach` never
`CloseHandle`s the previous handle, so Windows cannot recycle that PID while
Tamper holds it; attaching to the same PID therefore is the same process, and
restoring would silently undo the user's active patches on a mere UI re-attach.
This correctness depends on the handle being leaked — worth a comment in
`ipc.ts` recording the dependency, since fixing the leak would break the
reasoning.

**`patch:*` throws while `cheats:oneShot` returns `false`.** Two conventions
coexist in `ipc.ts`. Every renderer call site is now wrapped in try/catch;
unifying the convention is the real fix.

**The native write-watch `g_session` is process-global, not per-handle.** This is
why `vitest.config.ts` sets `fileParallelism: false` — two native test files
driving one debugger session collide. Unchanged by this branch; revisit if the
suite grows enough for serial execution to hurt.

**No arity/type validation on N-API `info[]` arguments**, consistent with the
sibling native modules. The renderer is a trusted local surface; worth a
project-wide decision rather than a one-module fix.

**`writeBytes` has no explicit length cap** where `readBytes` enforces `1..64`.
The page-straddle refusal now bounds it below one page.

## Manual validation still outstanding

The plan's Valheim pass is a human step and has not been performed. Run plan
step 7 **twice**: once quitting Tamper gracefully (exercises `before-quit` →
`restoreAllPatches`), and once killing it from Task Manager, then re-attaching —
that second variant is what would surface a regression in the adopt-on-reattach
fix, and the failure mode is a toggle that reads ON and lies when you switch it
off.

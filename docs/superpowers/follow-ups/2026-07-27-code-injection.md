# Follow-ups from #7 (code injection and persistent anchors)

Carried out of the SDD workspace before it was deleted. Every item below was
found by a review, triaged at the final whole-branch review, and deliberately
deferred rather than forgotten. Nothing here blocks merge.

## Ruled on and accepted (do not "fix" without deciding again)

**Restore proceeds even when thread suspension fails.** Install refuses when
`suspendThreads()` returns false; `restore`/`restoreAll` write anyway. Refusing
to restore would leave a game permanently patched, which is the exact failure
this sub-project exists to prevent — a torn restore write is the lesser evil.
Documented at the restore path in `patchEngine.ts`.

**Caves are never freed.** A thread suspended inside a cave must still have
valid code to return through. Consequences accepted: a failed install after the
cave write leaks that cave, and a retried install allocates a second one.

**No adoption of an untracked injection.** If Tamper loses its in-memory applied
map while the game runs, the live trampoline is detected (`'foreign-injection'`)
and the user is told to restart the game. Adopting it would be unsafe: after a
crash we have the captured instruction but not the full displaced run, so we
could not restore correctly, and we would not recover the cave address either.

## Worth doing before heavy Valheim debugging

- `resolveAnchor` logs "patch not installed" and "slot unreadable" but
  deliberately not "slot still zero" — the freeze loop would spam it. If a real
  anchor misbehaves and the cause is unclear, a one-shot or rate-limited log for
  the zero case is the missing breadcrumb.
- The `'e9'`-prefix test for a foreign trampoline can misclassify a patch whose
  genuine original bytes start with `e9`. It fails closed (refuses, writes
  nothing), so the cost is a misleading message, not corruption. Comparing
  against the stored `originalBytes` first would sharpen it.

## Correctness nits, none reachable today

- `platform::WriteMemory` has no `size == 0` guard; `address + size - 1`
  underflows. Fails safe (page mismatch → false), and no caller passes 0.
- `decodeRun(minBytes: 0)` returns `{length: 0, decodable: true}` — claims
  decodable without decoding. The only call site hardcodes 5.
- `decodeRun`'s short-read fallback halves by powers of two, so it under-reports
  at a true mapping boundary (50 readable bytes → 32). Conservative direction;
  untested path.
- `encodeJump` computes `from + 5` on `uintptr_t` before casting to `int64_t`,
  so a `from` within 5 bytes of `UINTPTR_MAX` wraps before the range check.
  Unreachable for user-mode addresses.
- `nopHex` throws `RangeError` on a negative count. Reachable only if
  `decodeRun` returned `decodable: true` with `length < 5`, which `minBytes`
  prevents.
- `fieldOffset: ''` passes validation (`BigInt('') === 0n`) and becomes offset 0;
  `value: NaN` passes `typeof === 'number'`. Both reachable only by hand-editing
  `games/*.json` — the UI always supplies captured values. Same class as the
  pre-existing unvalidated `moduleOffset`.

## Performance

- `AllocateNear`'s downward walk steps a fixed 64KB granularity instead of
  jumping to the queried region's boundary the way the upward walk does — up to
  ~32.7k `VirtualQueryEx` calls inside one large free region. Correct, just slow,
  and only on the downward half.

## Test-quality gaps

- `restoreAll`'s suspend-once-around-the-loop behaviour is uncovered.
- The zero-slack `decodeRun` test asserts `relocatable === false` without pinning
  that the refusal is caused by the trailing `ret` — a future compiler emitting
  something else position-dependent there would keep it green for the wrong
  reason.
- The "cannot be decoded" refusal test asserts less than its siblings (no error
  text, no `isApplied`).
- `decodeRun`'s short-read fallback has no test.
- `CheatList.tsx`'s `isAnchor`/`targetLabel`/`targetKey` are untested — the repo
  has no renderer test suite at all.

## Structural

- `ParseHex`/`ToHex` are now a fourth verbatim copy across `memory_ops.cc`,
  `patch_ops.cc`, `write_watch.cc` and `cave_ops.cc`. A shared `hex_utils.h` is
  overdue. Pre-existing pattern, not introduced here.
- **A second top-level `beforeAll` in `tests/native/cave_ops.test.ts` segfaults
  the vitest worker** when it awaits an `AsyncWorker`-backed promise
  (`scanFirst`). Root-caused in isolation during Task 5, worked around by merging
  setup into the single existing hook, and recorded in a comment in that file.
  The underlying cause was never chased down. Anyone adding tests there must not
  add another top-level `beforeAll`.

## Known limits of this sub-project

- **Linux is a stub.** The platform seam has a working Windows backend and a
  Linux one that compiles, loads and refuses via `IsSupported() === false`.
  Injection is refused there with a clear message. Implementing it needs a Linux
  machine; `AllocateNear` is the hard part, since Linux has no `VirtualAllocEx`
  and allocating in another process means hijacking a thread to call `mmap`.
- **Only new code goes through the seam.** The scanner, pointer walker, memory
  ops, write-watch and patch ops still call Win32 directly. Porting them is a
  separate sub-project — and note that even with the Linux backend implemented,
  a Linux build would attach and do very little until that port happens.
- **A `movs`-style block copy still cannot be attributed to a field.** Carried
  over from #6; `wideloop` in the harness pins it as a documented limitation.

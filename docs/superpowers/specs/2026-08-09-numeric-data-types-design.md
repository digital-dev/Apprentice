# More numeric data types: int16, int64, double

## Problem

Apprentice's value cheats support `int32`, `float`, and a write-only `byte`
(excluded from scanning — see `store.ts`'s comment on `DataType`). Cheat
Engine supports the full width range on both sides (scan and freeze): 1/2/4/8
byte integers and both float widths. Some games use narrower or wider fields
than int32/float for counters and stats, and there's currently no way to
scan for or freeze those.

## Goal

Add `int16`, `int64`, and `double` as fully-supported data types — scannable
and freezable, the same as `int32`/`float` today. Along the way, fix the
existing `byte` gap (write-only, unscannable) as a natural side effect of
generalizing the scan/read/write code, since the fix is free once the code
is generalized and leaving it inconsistent would be strange.

**Out of scope**, and why:
- **Force-mode code patches** (`cave_ops.cc`'s `encodeStore`, a
  `mov [reg+offset], imm32` x86 instruction) stay int32/float-only. A 64-bit
  or double-width store needs a different instruction encoding entirely —
  a separate, much larger change not worth bundling here. Immune-mode's
  "return value" field (`CheatList.tsx`'s `monoAnchorReturnDataType`) feeds
  that same force-mode write path and is untouched for the same reason.
- **String / array-of-bytes** — a structurally different shape
  (variable-length, not a fixed-width numeric comparison). Separate future
  spec.

## Design

### `store.ts`: widen `DataType`, rename `byte` → `int8`

```ts
export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'
```

Renaming `'byte'` to `'int8'` gives every type a consistent width-based name
instead of one oddly-named holdout. Existing saved cheats with
`dataType: 'byte'` must keep loading and working unchanged — `profile.ts`'s
load path gets a one-line rename (`'byte' → 'int8'`) applied to every loaded
cheat's `dataType` field, so old `games/*.json` files need no migration
script and behave exactly as before after the rename.

### `native/src/scanner.cc` and `native/src/memory_ops.cc`: a shared width/interpretation table

Both files currently branch on type in an ad hoc way:
- `scanner.cc` has a `bool isFloat` (assumes non-float means int32) and a
  compile-time `kValueSize = 4`.
- `memory_ops.cc` has an `if/else if/else` chain for `int32` / `byte` /
  anything-else-is-float.

Both get replaced with one small lookup, keyed by the `dataType` string,
giving:
- **width in bytes**: 1 (`int8`), 2 (`int16`), 4 (`int32`/`float`), 8
  (`int64`/`double`)
- **interpretation kind**: signed integer or float

`scanner.cc`'s memory-walk loop currently advances by the compile-time
`kValueSize`; it becomes a runtime width from this table, and
`InterpretAsDouble`/`ValuesEqual` extend their existing float-vs-int branch
to width-aware reads (`int8_t`/`int16_t`/`int32_t`/`int64_t` all widen to
`double` for comparison; `float`/`double` both go through the existing
epsilon comparison, `int8`/`int16`/`int32`/`int64` through the existing
exact comparison). `memory_ops.cc`'s `ReadValue`/`WriteValue` get the same
table-driven branch instead of three near-duplicate ones, replacing the
current `int32`/`byte`/else chain.

Because this generalizes the *whole* interpretation table rather than
special-casing three new entries next to the old ones, `int8` (today's
`byte`) becomes scannable through the same code path — no separate carve-out
needed, and the existing "byte isn't scannable" limitation goes away as a
side effect.

### int64 precision

`int64` values are stored and passed as plain JS `number` end-to-end (scan
input, freeze value, JSON profile storage) — the same as every other type.
This is exact for any value up to 2^53 (~9 quadrillion), which covers any
realistic game counter. No `BigInt` threading through IPC, native N-API
calls, or JSON storage, which would be materially more invasive (`BigInt`
isn't natively JSON-serializable, N-API `BigInt` handling differs from
`Number`, every UI input would need parsing changes) for a precision range
no real cheat value will ever reach.

### UI

- **Scanner's scan-type `<select>`** (`Scanner.tsx:375-382`) gains `int8`
  (newly scannable), `int16`, `int64`, and `double` options alongside the
  existing `float`/`int32`.
- **Mono Explorer's value-target `<select>`** (`CheatList.tsx:852-859`,
  currently `float`/`int32`/`byte` — `byte` relabeled `int8` per the rename
  above) gains `int16`, `int64`, `double` for parity, since Mono-anchored
  value cheats write through the same `memory_ops.cc` path being
  generalized here.
- Immune-mode's return-value type select (`monoAnchorReturnDataType`,
  `CheatList.tsx:1019-1024`) is **not** touched — it feeds the force-mode
  write path, out of scope per above.

## Testing

Native tests drive a real child process (`test-harness/harness.exe`, built
from `harness.c`) — see `CODEBASE_MAP.md`'s "Tests" section for the existing
pattern (`send()`/`beforeAll` harness spawn, one-shot scans).

- `harness.c` gains new globals for the three new types (`g_int16`,
  `g_int64`, `g_double`) plus `set`/`get` stdin commands for each, following
  the existing `setf %f` / `sscanf` pattern used for `g_stamina`.
- `harness.exe` must be rebuilt from PowerShell per `CODEBASE_MAP.md`'s
  documented `cl.exe` invocation (Bash can't run `vcvars`) — delete
  `harness.obj` after and verify the exe's timestamp changed.
- `tests/native/scanner.test.ts` gains one round-trip case per new type
  (int16, int64, double), plus one for int8 now that it's scannable:
  `scanFirst` finds the harness's known initial value, `set`-command changes
  it, `scanNext` narrows correctly — mirroring the existing int32/float
  cases in the same file.
- `tests/native/memory_ops.test.ts` gains one `readValue`/`writeValue`
  round-trip per new type, mirroring the existing int32 case.
- `tests/main/profile.test.ts` (or wherever `profile.ts`'s load path is
  already tested) gains a case: a schema-2 profile with a cheat whose
  `dataType` is the legacy `'byte'` string loads with `dataType: 'int8'`.

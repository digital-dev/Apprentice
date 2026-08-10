# Numeric Data Types (int16/int64/double) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `int16`, `int64`, and `double` as fully scannable/freezable value-cheat data types, rename the existing `'byte'` type to `'int8'` for a consistent naming scheme, and fix `int8`'s pre-existing "not scannable" gap as a side effect of generalizing the scan/read/write code.

**Architecture:** `store.ts`'s `DataType` union widens and its `'byte'` literal is renamed to `'int8'`, with a load-time migration in `profile.ts` so existing saved cheats keep working. The native scan/read/write code (`scanner.cc`, `memory_ops.cc`) is generalized from three ad hoc int32/float/byte branches into one shared width/interpretation table (`native/src/value_type.h`), used identically by both files so int8's "unsigned, matches the existing Mono-bool-field behavior" convention can't drift between them. A real correctness gap this widening would otherwise introduce — force-mode code patches can only encode a 32-bit immediate, but the UI's scan-type picker is shared with force-mode patch creation — gets a guard in `patchEngine.ts` (the authoritative check) and the `Scanner.tsx` UI (so the user sees "unavailable" instead of a runtime refusal).

**Tech Stack:** TypeScript (main + renderer), C++17 (N-API native addon), Vitest, MSVC (`cl.exe`) for the native addon and the test harness.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-numeric-data-types-design.md`
- Force-mode code patches (`cave_ops.cc`'s `encodeStore`) stay int32/float-only — not touched by this plan. `int8`/`int16`/`int64`/`double` must be **rejected**, not silently mis-encoded, if a force-mode patch somehow carries one.
- `int8` (renamed from `'byte'`) stays **unsigned** (matches its current `uint8_t` read/write behavior exactly, since it's used for Mono bool fields like `Player.m_godMode`) — this is a rename, not a reinterpretation. `int16`/`int32`/`int64` are signed.
- `int64` is represented as a plain JS `number` end-to-end (scan input, freeze value, JSON storage) — no `BigInt`. Exact up to 2^53 (~9 quadrillion), which covers any realistic game counter.
- Every existing saved cheat with `dataType: 'byte'` must keep loading and working unchanged after this plan — `profile.ts`'s load path rewrites `'byte'` to `'int8'` in memory; no on-disk migration script, no change to the file until something is next saved (same convention `profile.ts` already uses for its schema-1 legacy-array handling).
- Rebuild the native addon and the test harness only from **PowerShell**, never Bash (Bash can't run `vcvars` and fails silently) — see `CODEBASE_MAP.md`'s "Build and run" section for the exact commands, repeated in the relevant tasks below.
- **Stop the Apprentice app before rebuilding the native addon** — a running Electron instance locks `memory_addon.node` and the link fails with "permission denied".

---

### Task 1: Widen `DataType`, rename `'byte'` → `'int8'`, migrate legacy profiles

**Files:**
- Modify: `src/main/store.ts:3-11` (the `DataType` type)
- Modify: `src/main/profile.ts` (add a load-time migration, used at both `loadProfile` return sites)
- Modify: `src/main/ctExport.ts:110` (the byte-specific skip check, now needs to cover every non-int32/float type)
- Modify: `src/renderer/src/screens/CheatList.tsx:858` (rename the Mono value-target select's `byte` option to `int8` — the option itself, not its label)
- Test: `tests/main/profile.test.ts`, `tests/main/ctExport.test.ts`

**Interfaces:**
- Produces: `DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'`, exported from `store.ts`, consumed by every later task.

- [ ] **Step 1: Widen `DataType` in `store.ts`**

Find:
```ts
// 'byte' is a 1-byte write/read — the width a Mono bool field (e.g.
// Player.m_godMode) actually occupies. int32/float always write 4 bytes;
// using either of those on a 1-byte field overwrites 3 bytes of whatever
// field follows it in the object's layout. Scanning (scanner.cc) does not
// support 'byte' — this exists for the Mono value-target write path only,
// where the field's real width is already known from its resolution, not
// discovered by scanning.
export type DataType = 'int32' | 'float' | 'byte'
```
Replace with:
```ts
// Every numeric width Apprentice can scan for, freeze, or write through a
// Mono value target. 'int8' (an unsigned 1-byte write/read — kept
// unsigned to match the width a Mono bool field, e.g. Player.m_godMode,
// actually occupies, and how it's always been read/written here) was
// previously named 'byte' and excluded from scanning; native/src/scanner.cc
// and native/src/memory_ops.cc now handle every one of these widths
// uniformly through native/src/value_type.h, so scanning works for all of
// them. int16/int32/int64 are signed.
//
// Force-mode code patches (cave_ops.cc's encodeStore) can only encode a
// 32-bit immediate — a force-mode PatchCheat's dataType must stay
// 'int32' or 'float'; patchEngine.ts's apply() refuses any other width
// before installing anything.
export type DataType = 'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'
```

- [ ] **Step 2: Migrate legacy `'byte'` cheats on load, in `profile.ts`**

Find:
```ts
  // Schema 1: a bare array of cheats, written before profiles existed. It
  // loads as a profile with no fingerprints, which makes every cheat in it
  // unverified and signature-only — exactly how it behaved before. The file
  // on disk is left alone until something is saved.
  if (Array.isArray(parsed)) {
    return { ...emptyProfile(exeName), cheats: parsed as StoredCheat[] }
  }

  const obj = parsed as Partial<GameProfile>
  if (!Array.isArray(obj.cheats)) {
    throw new Error(`${file} has no cheats array — refusing to overwrite it.`)
  }
  return {
    schema: 2,
    exe: obj.exe ?? exeName.replace(/\.exe$/i, ''),
    modules: obj.modules ?? {},
    cheats: obj.cheats
  }
}
```
Replace with:
```ts
  // Schema 1: a bare array of cheats, written before profiles existed. It
  // loads as a profile with no fingerprints, which makes every cheat in it
  // unverified and signature-only — exactly how it behaved before. The file
  // on disk is left alone until something is saved.
  if (Array.isArray(parsed)) {
    return { ...emptyProfile(exeName), cheats: migrateByteDataType(parsed as StoredCheat[]) }
  }

  const obj = parsed as Partial<GameProfile>
  if (!Array.isArray(obj.cheats)) {
    throw new Error(`${file} has no cheats array — refusing to overwrite it.`)
  }
  return {
    schema: 2,
    exe: obj.exe ?? exeName.replace(/\.exe$/i, ''),
    modules: obj.modules ?? {},
    cheats: migrateByteDataType(obj.cheats)
  }
}

// DataType's 'byte' was renamed to 'int8' (same width, same unsigned
// representation — a naming change only, not a reinterpretation). Any
// cheat saved before the rename still has 'byte' on disk; rewriting it to
// 'int8' here means every existing games/*.json file keeps loading and
// working unchanged, with no migration script and no rewrite of the file
// until something in it is next saved — the same "fix it in memory, leave
// the file alone" convention this loader already uses for schema 1.
function migrateByteDataType(cheats: StoredCheat[]): StoredCheat[] {
  return cheats.map((cheat) => {
    const withDataType = cheat as { dataType?: string }
    if (withDataType.dataType !== 'byte') return cheat
    return { ...cheat, dataType: 'int8' } as StoredCheat
  })
}
```

- [ ] **Step 3: Widen `ctExport.ts`'s representable-types check**

Find (around line 110):
```ts
    if (patch.dataType === 'byte') {
      skipped.push({ name: patch.name, reason: UNREPRESENTABLE_REASON })
      continue
    }
```
Replace with:
```ts
    // Force-mode's Auto Assembler script can only encode a 32-bit
    // immediate (see ctExport.ts's own module comment and
    // patchEngine.ts's force-mode validation) — every dataType except
    // int32/float is unrepresentable here, not just the old 'byte' type.
    if (patch.dataType !== 'int32' && patch.dataType !== 'float') {
      skipped.push({ name: patch.name, reason: UNREPRESENTABLE_REASON })
      continue
    }
```

- [ ] **Step 4: Rename the Mono value-target select's `byte` option**

In `src/renderer/src/screens/CheatList.tsx`, find:
```tsx
            <option value="byte">Byte (bool, e.g. a Mono bool field)</option>
```
Replace with:
```tsx
            <option value="int8">Byte (bool, e.g. a Mono bool field)</option>
```

- [ ] **Step 5: Add a `profile.ts` migration test**

In `tests/main/profile.test.ts`, add a new test inside the `describe('profile', ...)` block, near the existing schema-1 test:
```ts
  it("migrates a legacy dataType of 'byte' to 'int8' on load, without rewriting the file", () => {
    const file = path.join(dir, 'valheim.json')
    const legacyByte = JSON.stringify({
      schema: 2,
      exe: 'valheim',
      modules: {},
      cheats: [
        {
          id: 'god-mode',
          name: 'God Mode',
          dataType: 'byte',
          mode: 'freeze',
          targets: [],
          value: 1
        }
      ]
    })
    fs.writeFileSync(file, legacyByte)
    const profile = loadProfile('valheim')
    expect(profile.cheats).toHaveLength(1)
    expect((profile.cheats[0] as { dataType?: string }).dataType).toBe('int8')
    // The file on disk is untouched until something is saved — same
    // convention as the schema-1 legacy-array test above.
    expect(fs.readFileSync(file, 'utf-8')).toBe(legacyByte)
  })
```

- [ ] **Step 6: Add a `ctExport.ts` widened-type skip test**

In `tests/main/ctExport.test.ts`, add a new test after the existing "skips a force-mode patch with a negative value" test:
```ts
  it('skips a force-mode patch whose dataType is not int32/float', () => {
    const patch = forcePatch({ dataType: 'int8', name: 'Wide Type' })
    const result = buildCheatTable([patch])
    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      {
        name: 'Wide Type',
        reason: "This value cannot be represented in Cheat Engine's Auto Assembler script format."
      }
    ])
  })
```

- [ ] **Step 7: Run the affected tests and type-check**

Run: `npx vitest run tests/main/profile.test.ts tests/main/ctExport.test.ts`
Expected: PASS, including the two new tests.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main/store.ts src/main/profile.ts src/main/ctExport.ts src/renderer/src/screens/CheatList.tsx tests/main/profile.test.ts tests/main/ctExport.test.ts
git commit -m "Widen DataType with int16/int64/double, rename byte to int8"
```

---

### Task 2: Refuse force-mode patches with an unencodable `dataType`

**Files:**
- Modify: `src/main/patchEngine.ts:541-544` (the force-mode field validation)
- Test: `tests/main/patchEngine.test.ts`

**Interfaces:**
- Consumes: `DataType` from Task 1.
- Produces: nothing new consumed by later tasks — this closes a correctness gap Task 1's widened `DataType` would otherwise open (a force-mode patch could previously only ever carry `'int32'`/`'float'`/`'byte'`-as-write-only, but `'byte'` was never used for force mode; now that `DataType` includes width the force-mode encoder genuinely cannot handle, `apply()` must refuse those explicitly instead of silently mis-encoding them via `valueBits`'s `value >>> 0` fallback).

- [ ] **Step 1: Write the failing test**

In `tests/main/patchEngine.test.ts`, inside `describe('PatchEngine — force injection', ...)`, add a new test near the existing "refuses, before allocating a cave, when the patch is missing a required force-mode field" test:
```ts
  it("refuses, before allocating a cave, when the patch's dataType is a width force mode cannot encode", async () => {
    const wideType = { ...forcePatch, id: 'patch-wide', dataType: 'int64' } as PatchCheat
    const result = await engine.apply(wideType)
    expect(result.ok).toBe(false)
    expect(ops.caves).toHaveLength(0)
    expect(ops.writes).toHaveLength(0)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/main/patchEngine.test.ts -t "dataType is a width force mode cannot encode"`
Expected: FAIL — `result.ok` is currently `true` (the existing validation only checks `typeof patch.value !== 'number' || !patch.dataType`, which a `dataType: 'int64'` patch satisfies).

- [ ] **Step 3: Extend the force-mode validation**

Find:
```ts
      if (mode === 'force') {
        if (typeof patch.value !== 'number' || !patch.dataType) {
          throw new Error('missing force-mode fields')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
    } catch {
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : "This patch is missing the register, offset, value, or data type a force injection needs, or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
```
Replace with:
```ts
      if (mode === 'force') {
        if (
          typeof patch.value !== 'number' ||
          !patch.dataType ||
          (patch.dataType !== 'int32' && patch.dataType !== 'float')
        ) {
          // Force mode encodes the value as a 32-bit immediate (see
          // valueBits below and cave_ops.cc's encodeStore) — any other
          // width, including a legitimately-set int8/int16/int64/double,
          // would be silently mis-encoded rather than refused if this
          // check only looked for presence.
          throw new Error('missing or unencodable force-mode fields')
        }
        BigInt(patch.fieldOffset as string) // throws on unparsable hex
      }
    } catch {
      return {
        ok: false,
        error:
          mode === 'capture'
            ? "This patch is missing the register a capture injection needs — can't install it."
            : "This patch is missing the register, offset, value, or data type a force injection needs, its data type isn't int32/float (the only widths force mode can write), or its offset isn't valid hex — can't compute what to write.",
        caveAddress: null,
        displaced: null
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/main/patchEngine.test.ts -t "dataType is a width force mode cannot encode"`
Expected: PASS.

- [ ] **Step 5: Run the full `patchEngine.test.ts` suite to confirm no regressions**

Run: `npx vitest run tests/main/patchEngine.test.ts`
Expected: PASS, every existing test still green (every existing `forcePatch`-derived fixture already uses `dataType: 'float'`, so none of them trip the new check).

- [ ] **Step 6: Commit**

```bash
git add src/main/patchEngine.ts tests/main/patchEngine.test.ts
git commit -m "Refuse force-mode patches whose dataType isn't int32/float"
```

---

### Task 3: Test-harness commands for int16/int64/double

**Files:**
- Modify: `test-harness/harness.c`
- Modify (rebuild only, binary): `test-harness/harness.exe`

**Interfaces:**
- Produces: `seti16`/`geti16`, `seti64`/`geti64`, `setd`/`getd` stdin commands, driving new globals `g_int16` (`short`), `g_int64` (`long long`), `g_double` (`double`). Task 4's native tests spawn `harness.exe` and drive it with these commands, the same way `tests/native/scanner.test.ts`/`memory_ops.test.ts` already drive `set`/`setf`/`get`.

- [ ] **Step 1: Add the new globals**

In `test-harness/harness.c`, find:
```c
int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this
float g_stamina = 100.0f; // scanner.test.ts float-path coverage
```
Replace with:
```c
int g_health = 100;
int* g_health_ptr = &g_health; // pointer.test.ts resolves through this
float g_stamina = 100.0f; // scanner.test.ts float-path coverage
short g_int16 = 12345; // scanner.test.ts / memory_ops.test.ts int16 coverage
long long g_int64 = 123456789012345LL; // scanner.test.ts / memory_ops.test.ts int64 coverage — comfortably beyond int32's range
double g_double = 123.456; // scanner.test.ts / memory_ops.test.ts double coverage
```

- [ ] **Step 2: Add local variables for the new command handlers**

Find:
```c
    if (line[0] == 'q') break;
    int val;
    float fval;
    if (strncmp(line, "loadmono", 8) == 0) {
```
Replace with:
```c
    if (line[0] == 'q') break;
    int val;
    float fval;
    short val16;
    long long val64;
    double dval;
    if (strncmp(line, "loadmono", 8) == 0) {
```

- [ ] **Step 3: Add the set/get command handlers, before the bare `get` check**

Find:
```c
    } else if (sscanf(line, "setp %f", &fval) == 1) {
      g_player_ptr->stamina = fval; // lets pointer.test.ts narrow to this exact field
      printf("OK\n");
    } else if (sscanf(line, "setshield %f", &fval) == 1) {
```
Replace with:
```c
    } else if (sscanf(line, "setp %f", &fval) == 1) {
      g_player_ptr->stamina = fval; // lets pointer.test.ts narrow to this exact field
      printf("OK\n");
    } else if (sscanf(line, "seti16 %hd", &val16) == 1) {
      g_int16 = val16;
      printf("OK\n");
    } else if (strncmp(line, "geti16", 6) == 0) {
      // Must come before the bare "get" check below — strncmp(line, "get", 3)
      // would otherwise match "geti16" too and print g_health instead.
      printf("OK %d\n", g_int16);
    } else if (sscanf(line, "seti64 %lld", &val64) == 1) {
      g_int64 = val64;
      printf("OK\n");
    } else if (strncmp(line, "geti64", 6) == 0) {
      printf("OK %lld\n", g_int64);
    } else if (sscanf(line, "setd %lf", &dval) == 1) {
      g_double = dval;
      printf("OK\n");
    } else if (strncmp(line, "getd", 4) == 0) {
      printf("OK %f\n", g_double);
    } else if (sscanf(line, "setshield %f", &fval) == 1) {
```

- [ ] **Step 4: Rebuild `harness.exe` — from PowerShell, never Bash**

```powershell
& cmd.exe /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 && cl.exe /nologo /Fe:test-harness\harness.exe test-harness\harness.c'
Remove-Item test-harness\harness.obj
```
(Adjust the `vcvars64.bat` path if this environment's Visual Studio install location differs — check `CODEBASE_MAP.md`'s "Build and run" section, or search for `vcvars64.bat` under `C:\Program Files*\Microsoft Visual Studio\` if the above path doesn't exist.)

Expected: compiles with no errors; `harness.obj` deleted; verify `test-harness/harness.exe`'s modified timestamp changed (`Get-Item test-harness\harness.exe | Select LastWriteTime`).

- [ ] **Step 5: Manual smoke-test the new commands**

```powershell
$p = Start-Process -FilePath test-harness\harness.exe -NoNewWindow -PassThru -RedirectStandardInput stdin.tmp -RedirectStandardOutput stdout.tmp
```
Simplest verification (matches this plan's precedent in `docs/superpowers/plans/2026-07-25-find-what-writes.md`'s Task 2): pipe a short command script directly and inspect stdout —
```powershell
"seti16 777`ngeti16`nseti64 555000000000`ngeti64`nsetd 9.5`ngetd`nq`n" | test-harness\harness.exe
```
Expected output includes, in order: `PID <n>`, `OK`, `OK 777`, `OK`, `OK 555000000000`, `OK`, `OK 9.500000`.

- [ ] **Step 6: Commit**

```bash
git add test-harness/harness.c test-harness/harness.exe
git commit -m "Add int16/int64/double commands to the test harness"
```

---

### Task 4: Generalize `scanner.cc` and `memory_ops.cc` to every width

**Files:**
- Create: `native/src/value_type.h`
- Modify: `native/src/scanner.cc` (full rewrite of its type-handling sections)
- Modify: `native/src/memory_ops.cc` (full rewrite of `ReadValue`/`WriteValue`)
- Test: `tests/native/scanner.test.ts`, `tests/native/memory_ops.test.ts`

**Interfaces:**
- Produces: `SpecForDataType(dataType: string) -> optional<ValueSpec>`, `InterpretAsDouble(bytes, spec) -> double`, `EncodeFromDouble(value, spec, out)`, `IsFloatKind(kind) -> bool` — header-only, included by both `scanner.cc` and `memory_ops.cc`. No change to `native/binding.gyp` (headers aren't listed as sources; `value_type.h` is picked up via `#include`).
- Consumes: Task 3's harness commands, for the new native tests.

- [ ] **Step 1: Create `native/src/value_type.h`**

```cpp
#pragma once
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>

// The width/interpretation table both scanner.cc and memory_ops.cc read
// through — kept in one place so int8's "unsigned, to match the existing
// byte-for-a-Mono-bool-field behavior" convention can't drift between the
// two files. int16/int32/int64 are signed; float/double are IEEE-754.
enum class ValueKind { UInt8, Int16, Int32, Int64, Float, Double };

struct ValueSpec {
  size_t size;
  ValueKind kind;
};

inline std::optional<ValueSpec> SpecForDataType(const std::string& dataType) {
  if (dataType == "int8") return ValueSpec{1, ValueKind::UInt8};
  if (dataType == "int16") return ValueSpec{2, ValueKind::Int16};
  if (dataType == "int32") return ValueSpec{4, ValueKind::Int32};
  if (dataType == "int64") return ValueSpec{8, ValueKind::Int64};
  if (dataType == "float") return ValueSpec{4, ValueKind::Float};
  if (dataType == "double") return ValueSpec{8, ValueKind::Double};
  return std::nullopt;
}

inline bool IsFloatKind(ValueKind kind) {
  return kind == ValueKind::Float || kind == ValueKind::Double;
}

// Interprets `spec.size` raw bytes as a double — scanner.cc's comparisons
// and memory_ops.cc's ReadValue both go through this, so a value reads the
// same way no matter which file touches it.
inline double InterpretAsDouble(const uint8_t* bytes, const ValueSpec& spec) {
  switch (spec.kind) {
    case ValueKind::UInt8: {
      uint8_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Int16: {
      int16_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Int32: {
      int32_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Int64: {
      int64_t v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Float: {
      float v;
      memcpy(&v, bytes, sizeof(v));
      return static_cast<double>(v);
    }
    case ValueKind::Double: {
      double v;
      memcpy(&v, bytes, sizeof(v));
      return v;
    }
  }
  return 0.0; // unreachable — every ValueKind is handled above
}

// The reverse of InterpretAsDouble: encodes a JS-side double into
// `spec.size` raw bytes for a write. memory_ops.cc's WriteValue is the
// only caller — scanner.cc never writes.
inline void EncodeFromDouble(double value, const ValueSpec& spec, uint8_t* out) {
  switch (spec.kind) {
    case ValueKind::UInt8: {
      uint8_t v = static_cast<uint8_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Int16: {
      int16_t v = static_cast<int16_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Int32: {
      int32_t v = static_cast<int32_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Int64: {
      int64_t v = static_cast<int64_t>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Float: {
      float v = static_cast<float>(value);
      memcpy(out, &v, sizeof(v));
      return;
    }
    case ValueKind::Double: {
      memcpy(out, &value, sizeof(value));
      return;
    }
  }
}
```

- [ ] **Step 2: Rewrite `native/src/scanner.cc`**

Replace the file's full contents with:
```cpp
#include "scanner.h"
#include "value_type.h"
#include <windows.h>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <cmath>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

// Float equality after a game tick can differ by tiny rounding error even
// when "the same" value was written, so float/double comparisons use a
// small epsilon; every integer width compares exact.
bool ValuesEqual(double a, double b, bool isFloat) {
  if (isFloat) return std::abs(a - b) < 0.0001;
  return a == b;
}

bool ReadValueAsDouble(HANDLE h, uintptr_t addr, const ValueSpec& spec, double* out) {
  uint8_t buf[8]; // widest supported type (int64/double) is 8 bytes
  SIZE_T read;
  if (!ReadProcessMemory(h, (LPCVOID)addr, buf, spec.size, &read) || read != spec.size)
    return false;
  *out = InterpretAsDouble(buf, spec);
  return true;
}

struct AddressValue {
  uintptr_t address;
  double value;
};

// The actual memory walk, kept free of any Napi:: types so it's safe to run
// on a background thread (see ScanFirstWorker below) — Napi::Env/Value are
// not thread-safe and must only be touched on the JS thread.
std::vector<AddressValue> RunScanFirst(HANDLE h, const ValueSpec& spec, double target) {
  std::vector<AddressValue> out;
  bool isFloat = IsFloatKind(spec.kind);

  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool readable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) &&
        !(mbi.Protect & PAGE_GUARD);

    if (readable && mbi.RegionSize >= spec.size) {
      std::vector<uint8_t> buffer(mbi.RegionSize);
      SIZE_T bytesRead = 0;
      if (ReadProcessMemory(h, mbi.BaseAddress, buffer.data(), mbi.RegionSize, &bytesRead)) {
        uintptr_t base = (uintptr_t)mbi.BaseAddress;
        for (SIZE_T offset = 0; offset + spec.size <= bytesRead; offset += spec.size) {
          double value = InterpretAsDouble(buffer.data() + offset, spec);
          if (ValuesEqual(value, target, isFloat)) {
            out.push_back({base + offset, value});
          }
        }
      }
      // A whole-region read can legitimately fail (e.g. protection changed
      // between VirtualQueryEx and ReadProcessMemory) — skip that region
      // rather than falling back to a per-address read, which is what made
      // scanning slow enough to look hung against a real game process.
    }

    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }

  return out;
}

// Runs RunScanFirst on a libuv worker thread instead of the main JS thread.
// scanFirst walks the whole process's committed memory, which even after
// the bulk-read optimization can take real wall-clock time against a large
// real game process — running it synchronously on the main thread blocks
// the ENTIRE Electron app (not just this call) for that whole duration,
// which is indistinguishable from a hang to the user.
class ScanFirstWorker : public Napi::AsyncWorker {
 public:
  ScanFirstWorker(Napi::Env env, HANDLE handle, ValueSpec spec, double target)
      : Napi::AsyncWorker(env),
        handle_(handle),
        spec_(spec),
        target_(target),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override { results_ = RunScanFirst(handle_, spec_, target_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("address", Napi::String::New(env, ToHex(results_[i].address)));
      item.Set("value", Napi::Number::New(env, results_[i].value));
      result.Set((uint32_t)i, item);
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  ValueSpec spec_;
  double target_;
  std::vector<AddressValue> results_;
  Napi::Promise::Deferred deferred_;
};

} // namespace

Napi::Value ScanFirst(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string dataType = info[1].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "dataType must be one of int8, int16, int32, int64, float, double")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double target = info[2].As<Napi::Number>().DoubleValue();

  auto* worker = new ScanFirstWorker(env, h, *specOpt, target);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value ScanNext(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  // Each candidate carries its own previously-known value (from the last
  // scanFirst/scanNext call), so relative filters (changed/increased/...)
  // compare each address against its OWN prior value rather than a single
  // value broadcast across every candidate — which would be wrong for any
  // candidates whose values have diverged from each other since the last
  // scan.
  Napi::Array candidates = info[1].As<Napi::Array>();
  std::string dataType = info[2].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "dataType must be one of int8, int16, int32, int64, float, double")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  ValueSpec spec = *specOpt;
  bool isFloat = IsFloatKind(spec.kind);
  Napi::Object filter = info[3].As<Napi::Object>();
  std::string mode = filter.Get("mode").As<Napi::String>().Utf8Value();

  Napi::Array result = Napi::Array::New(env);
  uint32_t count = 0;

  for (uint32_t i = 0; i < candidates.Length(); i++) {
    Napi::Object candidate = candidates.Get(i).As<Napi::Object>();
    uintptr_t addr = ParseHex(candidate.Get("address").As<Napi::String>().Utf8Value());
    double current;
    if (!ReadValueAsDouble(h, addr, spec, &current)) continue;

    bool keep = false;
    if (mode == "exact") {
      double target = filter.Get("value").As<Napi::Number>().DoubleValue();
      keep = ValuesEqual(current, target, isFloat);
    } else {
      double previous = candidate.Get("value").As<Napi::Number>().DoubleValue();
      if (mode == "changed") keep = !ValuesEqual(current, previous, isFloat);
      else if (mode == "unchanged") keep = ValuesEqual(current, previous, isFloat);
      else if (mode == "increased") keep = current > previous;
      else if (mode == "decreased") keep = current < previous;
    }

    if (keep) {
      Napi::Object item = Napi::Object::New(env);
      item.Set("address", Napi::String::New(env, ToHex(addr)));
      item.Set("value", Napi::Number::New(env, current));
      result.Set(count++, item);
    }
  }

  return result;
}
```

Note the behavior change from the original: `ScanNext` previously had no
dataType validation at all (an unrecognized string silently fell through to
a 4-byte int32-shaped read). It now throws the same validation error
`ScanFirst` already did — a latent bug fixed as a side effect of sharing
`SpecForDataType`, not a new restriction on any dataType this codebase ever
actually passed.

- [ ] **Step 3: Rewrite `native/src/memory_ops.cc`**

Replace the file's full contents with:
```cpp
#include "memory_ops.h"
#include "value_type.h"
#include <windows.h>
#include <string>
#include <vector>
#include <cstdint>
#include <optional>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::optional<uintptr_t> ResolveChain(HANDLE h, uintptr_t base, const std::vector<uintptr_t>& offsets) {
  uintptr_t addr = base;
  for (size_t i = 0; i < offsets.size(); i++) {
    addr += offsets[i];
    if (i + 1 < offsets.size()) {
      uintptr_t next;
      SIZE_T read;
      if (!ReadProcessMemory(h, (LPCVOID)addr, &next, sizeof(next), &read) || read != sizeof(next))
        return std::nullopt;
      addr = next;
    }
  }
  return addr;
}

std::vector<uintptr_t> ParseOffsets(const Napi::Array& arr) {
  std::vector<uintptr_t> out;
  for (uint32_t i = 0; i < arr.Length(); i++) {
    out.push_back(ParseHex(arr.Get(i).As<Napi::String>().Utf8Value()));
  }
  return out;
}

} // namespace

Napi::Value ReadValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t base = ParseHex(info[1].As<Napi::String>().Utf8Value());
  auto offsets = ParseOffsets(info[2].As<Napi::Array>());
  std::string dataType = info[3].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) {
    Napi::Error::New(env, "unrecognized dataType").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto addr = ResolveChain(h, base, offsets);
  if (!addr) {
    Napi::Error::New(env, "pointer chain did not resolve").ThrowAsJavaScriptException();
    return env.Null();
  }

  uint8_t buf[8]; // widest supported type (int64/double) is 8 bytes
  SIZE_T read;
  if (!ReadProcessMemory(h, (LPCVOID)*addr, buf, specOpt->size, &read) || read != specOpt->size) {
    Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Number::New(env, InterpretAsDouble(buf, *specOpt));
}

Napi::Value WriteValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t base = ParseHex(info[1].As<Napi::String>().Utf8Value());
  auto offsets = ParseOffsets(info[2].As<Napi::Array>());
  std::string dataType = info[3].As<Napi::String>().Utf8Value();
  auto specOpt = SpecForDataType(dataType);
  if (!specOpt) return Napi::Boolean::New(env, false);
  double value = info[4].As<Napi::Number>().DoubleValue();

  auto addr = ResolveChain(h, base, offsets);
  if (!addr) return Napi::Boolean::New(env, false);

  uint8_t buf[8];
  EncodeFromDouble(value, *specOpt, buf);
  SIZE_T written;
  bool ok = WriteProcessMemory(h, (LPVOID)*addr, buf, specOpt->size, &written) && written == specOpt->size;
  return Napi::Boolean::New(env, ok);
}
```

- [ ] **Step 4: Rebuild the native addon — from PowerShell, never Bash, and with Apprentice not running**

```powershell
cd native
npx node-gyp configure
npx node-gyp build
cd ..
```
Expected: builds with no errors. (`configure` is required because a new source-adjacent header was added; `binding.gyp` itself is unchanged since headers aren't listed as sources.)

- [ ] **Step 5: Add native round-trip tests for the new types**

In `tests/native/scanner.test.ts`, add new `it` blocks inside `describe('scanFirst / scanNext', ...)`, following the existing int32 test's shape and using Task 3's new harness commands:
```ts
  it('finds and narrows an int16 value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'int16', 12345)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 12345)).toBe(true)

    await send('seti16 -500')
    candidates = (addon as any).scanNext(handle, candidates, 'int16', {
      mode: 'exact',
      value: -500
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === -500)).toBe(true)
  })

  it('finds and narrows an int64 value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'int64', 123456789012345)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 123456789012345)).toBe(true)

    await send('seti64 987654321098765')
    candidates = (addon as any).scanNext(handle, candidates, 'int64', {
      mode: 'exact',
      value: 987654321098765
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 987654321098765)).toBe(true)
  })

  it('finds and narrows a double value', async () => {
    let candidates: Candidate[] = await (addon as any).scanFirst(handle, 'double', 123.456)
    expect(candidates.length).toBeGreaterThan(0)

    await send('setd 9.5')
    candidates = (addon as any).scanNext(handle, candidates, 'double', {
      mode: 'exact',
      value: 9.5
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => c.value === 9.5)).toBe(true)
  })
```

In `tests/native/memory_ops.test.ts`, add a new `it` inside `describe('readValue / writeValue', ...)` — this one round-trips through `writeValue` directly rather than narrowing via a scan, mirroring the file's existing single test but for a new width:
```ts
  it('reads and writes an int16 value directly', async () => {
    let candidates: { address: string; value: number }[] = await (addon as any).scanFirst(
      handle,
      'int16',
      12345
    )
    expect(candidates.length).toBeGreaterThan(0)
    const target = candidates[0].address

    const before = (addon as any).readValue(handle, target, [], 'int16')
    expect(before).toBe(12345)

    const ok = (addon as any).writeValue(handle, target, [], 'int16', -1000)
    expect(ok).toBe(true)

    const reply = await send('geti16')
    expect(reply).toBe('OK -1000')
  })
```

- [ ] **Step 6: Run the native tests**

Run: `npx vitest run tests/native/scanner.test.ts tests/native/memory_ops.test.ts`
Expected: PASS, including the new int16/int64/double cases. (Per `CODEBASE_MAP.md`'s documented hazard: scans in these tests are one-shot and key off a field's *initial* value — the new tests above each scan for their global's untouched initial value first, exactly like the existing int32/float tests, so ordering within the file doesn't matter as long as no earlier test in the same file has already changed `g_int16`/`g_int64`/`g_double`.)

- [ ] **Step 7: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: same pass/fail split as this environment's established baseline for every suite this plan didn't touch; every suite this plan did touch (`scanner.test.ts`, `memory_ops.test.ts`, `profile.test.ts`, `ctExport.test.ts`, `patchEngine.test.ts`) fully green.

- [ ] **Step 8: Commit**

```bash
git add native/src/value_type.h native/src/scanner.cc native/src/memory_ops.cc tests/native/scanner.test.ts tests/native/memory_ops.test.ts
git commit -m "Generalize scanner.cc and memory_ops.cc to every DataType width"
```
(`native/build/` is gitignored — the rebuilt addon binary is never committed, only the sources that produce it.)

---

### Task 5: UI — new type options, and disable force-mode for wide types

**Files:**
- Modify: `src/renderer/src/screens/Scanner.tsx` (the scan-type select, and the patch-mode select's `force` option)
- Modify: `src/renderer/src/screens/CheatList.tsx` (the Mono value-target select)

**Interfaces:**
- Consumes: Task 1's widened `DataType`, Task 2's `patchEngine.ts` guard (this task's UI-level disable is the friendly front end for that guard — the guard is what actually prevents a bad save either way).

- [ ] **Step 1: Add new options to Scanner's scan-type select**

Find:
```tsx
      <select
        value={dataType}
        onChange={(e) => setDataType(e.target.value as DataType)}
        disabled={candidates.length > 0}
      >
        <option value="float">Float (most common — health, stamina, position)</option>
        <option value="int32">Whole number (gold, item count)</option>
      </select>
```
Replace with:
```tsx
      <select
        value={dataType}
        onChange={(e) => setDataType(e.target.value as DataType)}
        disabled={candidates.length > 0}
      >
        <option value="float">Float (most common — health, stamina, position)</option>
        <option value="double">Double (higher-precision float)</option>
        <option value="int32">Whole number (gold, item count)</option>
        <option value="int16">Whole number, 2 bytes (small counters)</option>
        <option value="int64">Whole number, 8 bytes (large totals)</option>
        <option value="int8">Byte, 0-255 (e.g. a bool flag)</option>
      </select>
```

- [ ] **Step 2: Disable the "force" patch-mode option for types force mode can't encode**

Find:
```tsx
                {/* The labels name the consequence, not the mechanism. The
                    difference that actually bites: force rewrites the
                    instruction, so it applies to EVERY object that code runs
                    for — in Valheim, forcing health hit enemies and
                    destructibles too. Capture writes one address, so it
                    reaches only the object it was armed on. */}
                <option value="nop">Stop this value from changing</option>
                <option value="guard">Stop this value from changing — for this object only</option>
                <option value="capture">Set this value — for this object only</option>
                <option value="force">Set this value — everywhere this code runs</option>
              </select>
```
Replace with:
```tsx
                {/* The labels name the consequence, not the mechanism. The
                    difference that actually bites: force rewrites the
                    instruction, so it applies to EVERY object that code runs
                    for — in Valheim, forcing health hit enemies and
                    destructibles too. Capture writes one address, so it
                    reaches only the object it was armed on. */}
                <option value="nop">Stop this value from changing</option>
                <option value="guard">Stop this value from changing — for this object only</option>
                <option value="capture">Set this value — for this object only</option>
                {/* Force mode encodes the value as a 32-bit immediate — it
                    can only handle the two data types that fit that shape.
                    patchEngine.ts's apply() refuses this at save time too;
                    disabling it here means the user sees "unavailable"
                    instead of a save-time error. */}
                <option
                  value="force"
                  disabled={dataType !== 'int32' && dataType !== 'float'}
                  title={
                    dataType !== 'int32' && dataType !== 'float'
                      ? 'Force mode can only set whole numbers (4 bytes) or floats'
                      : undefined
                  }
                >
                  Set this value — everywhere this code runs
                </option>
              </select>
```

- [ ] **Step 3: Add new options to Mono Explorer's value-target select**

In `src/renderer/src/screens/CheatList.tsx`, find (the `byte`→`int8` rename from Task 1 is already in place):
```tsx
          <select
            value={monoValueDataType}
            onChange={(e) => setMonoValueDataType(e.target.value as DataType)}
          >
            <option value="float">Float</option>
            <option value="int32">Whole number</option>
            <option value="int8">Byte (bool, e.g. a Mono bool field)</option>
          </select>
```
Replace with:
```tsx
          <select
            value={monoValueDataType}
            onChange={(e) => setMonoValueDataType(e.target.value as DataType)}
          >
            <option value="float">Float</option>
            <option value="double">Double</option>
            <option value="int32">Whole number (4 bytes)</option>
            <option value="int16">Whole number (2 bytes)</option>
            <option value="int64">Whole number (8 bytes)</option>
            <option value="int8">Byte (bool, e.g. a Mono bool field)</option>
          </select>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Build to confirm the renderer bundle compiles**

Run: `npm run build`
Expected: build completes without error. (No GUI available headlessly in this environment — this build check is the available substitute for a literal visual check of the two updated selects, consistent with how prior plans in this codebase handled the same constraint.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/screens/Scanner.tsx src/renderer/src/screens/CheatList.tsx
git commit -m "Add int16/int64/double options to the scan and Mono value-target pickers"
```

---

## Self-Review Notes

- Spec coverage: `DataType` widened + `byte`→`int8` rename with load-time migration ✅ (Task 1); native scan/read/write generalized to every width via one shared table ✅ (Task 4); int8 becomes scannable as a side effect ✅ (Task 4, `scanner.cc`'s walk no longer excludes it); int64 as plain `number` ✅ (no `BigInt` anywhere in this plan); force-mode patches stay int32/float-only, now enforced rather than merely documented ✅ (Task 2, backed by Task 5's UI-level disable); UI pickers updated for parity ✅ (Task 5).
- A gap the spec didn't anticipate, found while reading the actual UI code: `Scanner.tsx`'s scan-type `<select>` and its force-mode patch-value input share one `dataType` state variable, so widening the scan types without a guard would have let a user create a force-mode patch with an unencodable width — silently mis-encoded via `valueBits`'s `>>> 0` fallback. Task 2 (engine-level refusal) and Task 5 Step 2 (UI-level disable) close this; Task 2 is the authoritative fix, Task 5 is the friendly front end for it.
- Type consistency: `ValueSpec`/`ValueKind`/`SpecForDataType`/`InterpretAsDouble`/`EncodeFromDouble` are defined once in `value_type.h` (Task 4 Step 1) and used identically by `scanner.cc` and `memory_ops.cc` (Task 4 Steps 2-3) — no duplicated width/interpretation logic to drift. `DataType`'s string literals (Task 1) match `SpecForDataType`'s recognized strings (Task 4) exactly: `int8`/`int16`/`int32`/`int64`/`float`/`double`.
- No placeholders: every step has literal code and an exact verification command; the two commands whose exact path depends on this machine's Visual Studio install (`vcvars64.bat`) carry an explicit fallback instruction rather than a bare TODO.

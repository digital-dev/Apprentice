# IL2CPP Cheat Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development). Steps use checkbox syntax.

**Goal:** `author_cheats` also drafts persistent cheats (capture patch + anchor value cheat) for Unity/IL2CPP games.

**Architecture:** Pure decoders and orchestration with injected memory/disassembly/AOB ops, unit-tested with byte fixtures captured from the live Schedule I probe. One dispatch change in the existing tool.

**Tech Stack:** TypeScript, vitest (root config), existing `mcp-server/src/addon.ts`.

**Spec:** `docs/superpowers/specs/2026-09-19-il2cpp-cheat-factory-design.md`

## Global Constraints

- Read-only against game memory except the existing scratch-buffer remote calls; only file write is `<profile>.draft.json`.
- Never call `il2cpp_class_get_fields`/`il2cpp_class_get_methods`; read structs.
- Layout offsets come from the spec table; a failed cross-check refuses to draft.
- No `Co-Authored-By`/`Claude-Session` trailers in commits (repo rule).
- Run tests from repo root: `npx vitest run mcp-server/tests/<file>`. Type-check: `npx tsc -p mcp-server/tsconfig.json --noEmit`.
- Style: no semicolons, single quotes, 2-space indent.

## Tasks

### Task 1: Layout decoders (`factory/il2cppLayout.ts`)
Interfaces: `leU64(hex, byteOffset): bigint`, `toHex(n: bigint): string`, `decodeClass(hex)`, `decodeField(hex)`, `decodeType(hex)`, `decodeMethod(hex)`, `typeEnumToDataType(e: number): DataType | null`, `cString(hex): string`.
Tests (real bytes from the probe): MoneyManager class header gives name/namespace/fields/methods/static pointers and counts 61/22; field record 5 decodes offset `0x128`, parent equals the class; type bytes `68be7fc3d401000006000c8000000000` give attrs `0x0006`, enum `0x0c` → `float`; method record 0 gives flags `0x96` (static) and klass equals the class.
Commit: `feat: add IL2CPP struct decoders for the cheat factory`.

### Task 2: Fake memory helper and enumerator (`factory/il2cppEnumerator.ts`)
Interfaces: `Il2cppOps { readBytes(address: string, length: number): string | null }`; `enumerateIl2cpp(ops, classPointers: string[], classHints: RegExp[]): Il2cppEnumeration` with `classes`, `roots`, `classesTotal`, `classesScanned`.
Tests: a sparse `FakeMemory` builds a two-class world (Player-like singleton with static root, MoneyManager fields); asserts hinted-only scanning, field dataType/static flags, static-field skip, root discovery with instance class from the object header, null-root ignored, parent-mismatch field record rejected (layout cross-check).
Commit: `feat: add IL2CPP class/field/method enumerator`.

### Task 3: Class-table bootstrap (`factory/il2cppBootstrap.ts`)
Interface: `findClassTable(ops: BootstrapOps): Promise<string[]>` where `BootstrapOps` has `call(fn, args)`, `writeString(text): string`, `scanQword(value: bigint): Promise<string[]>`, `readBytes`. Tests with scripted fakes: picks the scan hit whose next qword equals class 1; returns `count` pointers; errors clearly when no hit matches, or when the count is implausible (0 or > 200000).
Commit: `feat: add IL2CPP class-table bootstrap`.

### Task 4: Hook site and signature (`factory/hookSite.ts`)
Interface: `chooseHookSite(methods, ops: HookOps, moduleBase: string): Promise<HookSite | null>` with `HookSite { method, rva: string, originalBytes, length, signature }`; helpers `ripDispOffset(bytesHex): number | null`, `buildSignature(bytesHex, rows)`.
Tests: rejects already-detoured prologues (`e9`, `ff25`, `48b8`), static methods, ctors, rip-relative/branch in the first 5 bytes; accepts `48895c2408`; wildcards rip-relative and rel32 displacements; grows signature length until unique; refuses when the unique match is not the method start; prefers `Update`.
Commit: `feat: add IL2CPP hook-site chooser and signature builder`.

### Task 5: Builder (`factory/il2cppBuild.ts`) and generic ranker
Interface: `buildIl2cppFactory(wishlist, enumeration, ops: BuildOps): Promise<Il2cppFactoryResult>`; `rankFields` becomes generic `<T extends FieldCandidate>`.
Tests: money resolves `onlineBalance` with a verified singleton; type-fit rejects an int field for a float-only category; static fields skipped; unverified draft flagged `multiInstanceRisk`; implausible verified read skips that candidate; hook failure falls through to the next candidate then `unresolved`; one capture patch shared by two cheats on the same class; landmine categories reported as manual.
Commit: `feat: add IL2CPP cheat factory builder`.

### Task 6: Tool dispatch, docs, live run
Modify `tools/author.ts`: on `unity-il2cpp` build ops from the addon, run bootstrap, enumerate, build, write draft. Update SKILL.md and README. Rebuild `dist/`. Live: run against Schedule I and compare with `games/Schedule I.json`.
Commit: `feat: author_cheats supports Unity/IL2CPP`.

## Self-review
Spec coverage: layout (T1), enumeration and roots (T2), bootstrap (T3), hook rules (T4), verification, type fit and output (T5), dispatch and non-goals (T6). Types flow T1 → T2 → T4/T5 without renames.

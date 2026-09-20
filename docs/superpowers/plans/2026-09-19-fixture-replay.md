# Fixture Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regression-test AOB signature building and patch relocation against recorded real-game memory snapshots, offline.

**Architecture:** Extract the signature builder out of the hardware-breakpoint handler into a pure function over a `SigMemory` interface (live process adapter + snapshot adapter). Add snapshot-backed native exports and a TS `ReplayOps` so the real `PatchEngine` runs against recorded bytes. Two test tiers: synthetic (always, CI) and real (local snapshots, skipped when absent).

**Tech Stack:** C++17 N-API addon (Zydis), TypeScript, vitest, node zlib.

**Spec:** `docs/superpowers/specs/2026-09-19-fixture-replay-design.md`

## Global Constraints

- Never commit game bytes. Snapshots live in `fixtures/snapshots/` (gitignored). Only `tests/fixtures/manifest.json` (hashes, signatures, counts) is committed.
- Signatures produced live must be byte-identical before and after the extraction (Task 1 golden pins this).
- Safety rules stay the judge: never patch a guess (0 or >1 matches = "can't relocate"); never NOP bytes that are neither original nor NOPs; always restore.
- Snapshot regions carry readable margins (`pre` <=64 bytes, `post` <=128 bytes, Buffers, optional). Snapshot `Read` is all-or-nothing across bodies+margins, mirroring live `ReadProcessMemory`. Margins are never scanned.
- Signature is scanned one memory region at a time, executable regions only (matches `RunScanAob`); the snapshot must therefore keep VirtualQuery region boundaries, never merge adjacent regions.
- Tests run serially (`fileParallelism: false`); native tests use `test-harness/harness.exe`.
- Commits: no `Co-Authored-By` / `Claude-Session` trailers in this repo. Never stage `games/Schedule I.json` (unrelated uncommitted edit).
- Build the addon: `cd native && npx node-gyp build` (Node 22 to build). Stop Apprentice first.
- Test commands: `npx vitest run <file>`, `npx tsc --noEmit`.

---

### Task 1: Golden-pin live signatures (characterization, before any refactor)

**Files:**
- Create: `tests/native/signature_golden.test.ts`
- Create: `tests/fixtures/signature-golden.json` (written by the test on first run)

**Interfaces:**
- Produces: `tests/fixtures/signature-golden.json` shape `{ "stamina": {"signature": string, "signatureOffset": number, "length": number}, "shield": {...} }`. Task 2 must keep this test passing unchanged.

- [ ] **Step 1: Write the test.** It follows `write_watch.test.ts` (same harness spawn, `staminaAddress`/`shieldAddress` scans, `watchloop`/`shieldloop` commands). Copy the `send`, `sleep`, address-resolution helpers from `tests/native/write_watch.test.ts` lines 1-72 verbatim, then:

```ts
import fs from 'node:fs'

const GOLDEN = path.resolve('tests/fixtures/signature-golden.json')

async function capture(address: string, loopCmd: string, stopCmd = 'stoploop') {
  ;(addon as any).startWriteWatch(harness.pid, address)
  await send(loopCmd)
  let list: any[] = []
  for (let i = 0; i < 40 && list.length === 0; i++) {
    await sleep(50)
    list = (addon as any).pollWriteWatch()
  }
  await send(stopCmd)
  const final = (addon as any).stopWriteWatch()
  expect(final.length).toBeGreaterThan(0)
  const c = final[0]
  return { signature: c.signature, signatureOffset: c.signatureOffset, length: c.length }
}

describe('live signature golden', () => {
  it('stamina and shield signatures match the recorded golden', async () => {
    const got = {
      stamina: await capture(await staminaAddress(), 'watchloop'),
      shield: await capture(await shieldAddress(), 'shieldloop')
    }
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(GOLDEN)) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
      fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n')
    }
    expect(got).toEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')))
  }, 30000)
})
```

Check `tests/native/write_watch.test.ts` for the exact shield loop / stop command names (`shieldloop`, and what stops it) and use those.

- [ ] **Step 2: Run to record the golden against the CURRENT (unrefactored) addon.**
Run: `npx vitest run tests/native/signature_golden.test.ts`
Expected: PASS, and `tests/fixtures/signature-golden.json` now exists.

- [ ] **Step 3: Run again to prove it is stable across runs (ASLR, restart).**
Run: `npx vitest run tests/native/signature_golden.test.ts`
Expected: PASS. If it fails, the signature is not restart-stable on the harness; stop and report before refactoring, since the golden cannot pin anything.

- [ ] **Step 4: Commit.**
```bash
git add tests/native/signature_golden.test.ts tests/fixtures/signature-golden.json
git commit -m "test: pin live signatures on the harness before extracting the builder"
```

---

### Task 2: Extract `aob.h` and the pure signature builder

**Files:**
- Create: `native/src/aob.h`
- Create: `native/src/sigbuild.h`, `native/src/sigbuild.cc`
- Modify: `native/src/patch_ops.cc` (use `aob.h`), `native/src/write_watch.cc:528-774` (call the builder), `native/binding.gyp` (add `src/sigbuild.cc`)
- Test: `tests/native/signature_golden.test.ts` (from Task 1, unchanged)

**Interfaces:**
- Produces (`sigbuild.h`):
```cpp
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

// Where the signature builder reads code from. Two implementations: a live
// process (write_watch.cc) and a recorded snapshot (snapshot_ops.cc).
class SigMemory {
 public:
  virtual ~SigMemory() = default;
  // Copies up to `len` bytes at `addr` into `buf`; returns how many were
  // copied (0 = unreadable). Must not read across a region boundary
  // silently: a short count is the signal.
  virtual size_t Read(uintptr_t addr, uint8_t* buf, size_t len) const = 0;
  // Base address of the memory region containing `addr`; false if unknown.
  virtual bool RegionBase(uintptr_t addr, uintptr_t& base) const = 0;
};

struct SigResult {
  std::string signature;        // "48 89 ?? ..." tokens
  uint32_t signatureOffset = 0; // pattern bytes that precede the instruction
};

// `insn`/`insnLen`: the caught instruction's own bytes (fallback signature
// when the surrounding window cannot be read).
SigResult BuildSignature(const SigMemory& mem, uintptr_t insnAddr,
                         const uint8_t* insn, size_t insnLen);
```
- Produces (`aob.h`): `struct PatternByte { uint8_t value; bool wildcard; }; bool ParseSignature(const std::string&, std::vector<PatternByte>&);` moved out of `patch_ops.cc` unchanged, both `inline`.

- [ ] **Step 1: Create `aob.h`.** Move `PatternByte` and `ParseSignature` (patch_ops.cc lines 72-96) into it verbatim, marked `inline`, with `#include <string> <vector> <cstdint> <cstdlib>`. In `patch_ops.cc` delete the moved definitions and `#include "aob.h"`. (`ParseSignature`'s `strtoul` weakness is a known separate follow-up; do not change behaviour here.)

- [ ] **Step 2: Create `sigbuild.cc`.** Move the body of the block at `write_watch.cc` lines 528-774 into `BuildSignature`, mechanically:
  - Local `ZydisDecoder decoder; ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);` at the top (write_watch's own `decoder` stays for its other uses).
  - Copy `EndsMethod` (write_watch.cc 176-190) into `sigbuild.cc`'s anonymous namespace; delete it from write_watch.cc only if nothing else there uses it (grep first).
  - `ReadProcessMemory(proc, (LPCVOID)(insnAddr - kLookBack), win, sizeof(win), &winGot)` becomes `(winGot = mem.Read(insnAddr - kLookBack, win, sizeof(win))) == 0` style: keep the exact two conditions (`failed || winGot <= kLookBack`) as `winGot = mem.Read(...); if (winGot <= kLookBack) {...}`. The forward-only retry uses `mem.Read(insnAddr, win, tryForward)` with `got >= kMinSigBytes`.
  - The `VirtualQueryEx` clamp becomes `uintptr_t regionBase; if (mem.RegionBase(insnAddr, regionBase)) { ...same arithmetic... }`.
  - `out.length` -> `insnLen`; `out.bytes` fallback -> `insn[0..insnLen)`; results go into a `SigResult`.
  - Keep every comment.

- [ ] **Step 3: Live adapter in `write_watch.cc`.** Replace lines 528-774 with:
```cpp
  {
    struct LiveSigMemory : SigMemory {
      HANDLE proc;
      explicit LiveSigMemory(HANDLE p) : proc(p) {}
      size_t Read(uintptr_t addr, uint8_t* buf, size_t len) const override {
        SIZE_T got = 0;
        if (!ReadProcessMemory(proc, (LPCVOID)addr, buf, len, &got)) return 0;
        return (size_t)got;
      }
      bool RegionBase(uintptr_t addr, uintptr_t& base) const override {
        MEMORY_BASIC_INFORMATION mbi{};
        if (VirtualQueryEx(proc, (LPCVOID)addr, &mbi, sizeof(mbi)) != sizeof(mbi)) return false;
        base = (uintptr_t)mbi.BaseAddress;
        return true;
      }
    } live(proc);
    SigResult sig = BuildSignature(live, insnAddr, out.bytes.data(), out.bytes.size());
    out.signature = sig.signature;
    out.signatureOffset = sig.signatureOffset;
  }
```
Add `#include "sigbuild.h"`. Note `ReadProcessMemory` can return FALSE with a nonzero partial count; the old code treated FALSE as failure, so returning 0 on FALSE preserves behaviour exactly.

- [ ] **Step 4: Add `src/sigbuild.cc` to `binding.gyp` sources; build.**
Run: `cd native && npx node-gyp build`
Expected: builds clean.

- [ ] **Step 5: Golden and full native suite.**
Run: `npx vitest run tests/native`
Expected: PASS, including `signature_golden` unchanged. A golden diff means the extraction changed behaviour: fix the extraction, never the golden.

- [ ] **Step 6: Commit.**
```bash
git add native/src/aob.h native/src/sigbuild.h native/src/sigbuild.cc native/src/patch_ops.cc native/src/write_watch.cc native/binding.gyp
git commit -m "refactor(native): extract the signature builder behind a SigMemory interface"
```

---

### Task 3: Snapshot-backed native exports

**Files:**
- Create: `native/src/snapshot_ops.h`, `native/src/snapshot_ops.cc`
- Modify: `native/src/cave_ops.cc` (factor `DecodeRunBuffer`), `native/src/cave_ops.h`, `native/src/addon.cc`, `native/binding.gyp`
- Test: `tests/native/snapshot_ops.test.ts`

**Interfaces:**
- Consumes: `SigMemory`, `BuildSignature`, `ParseSignature`/`PatternByte`.
- Produces addon exports (regions are `{ base: '0x..', bytes: Buffer, pre?: Buffer, post?: Buffer }[]`, one entry per original memory region, never merged):
  - `listExecRegions(handle): { base: string, size: number }[]` — committed, executable, non-guard regions (same predicate as `RunScanAob`).
  - `readRegionBuffer(handle, base, size): Buffer | null` - bulk read for the recorder (`readBytes` is capped at 4096 and returns hex).
  - `snapshotBuildSignature(regions, insnAddress: string, insnLength: number): { signature: string, signatureOffset: number } | null` (null if `insnAddress` is in no region).
  - `snapshotScanAob(regions, signature: string): string[]` — hex addresses; scans each region independently, matches must lie fully inside one region.
  - `snapshotDecodeRun(regions, address: string, minBytes: number): { length, decodable, relocatable, clobbers }` — same result as live `decodeRun`.

- [ ] **Step 1: Factor `DecodeRunBuffer`.** In `cave_ops.cc`, move the decode loop of `DecodeRun` (from `ZydisDecoder decoder` through building `result`) into `Napi::Object DecodeRunBuffer(Napi::Env, const uint8_t* window, size_t got, size_t minBytes)`; `DecodeRun` keeps the read-shrinking logic then calls it. Declare it in `cave_ops.h`. Behaviour identical.

- [ ] **Step 2: Write the failing test** `tests/native/snapshot_ops.test.ts` using hand-assembled bytes (no harness):
```ts
import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'
const a = addon as any

// mov [rcx+0x10], eax ; ret   -> 89 41 10 c3
const CODE = Buffer.from([0x89, 0x41, 0x10, 0xc3])
const regions = [{ base: '0x1000', bytes: CODE }]

describe('snapshot exports', () => {
  it('snapshotScanAob finds an exact and a wildcarded pattern', () => {
    expect(a.snapshotScanAob(regions, '89 41 10 c3')).toEqual(['0x1000'])
    expect(a.snapshotScanAob(regions, '89 ?? 10')).toEqual(['0x1000'])
    expect(a.snapshotScanAob(regions, 'de ad')).toEqual([])
  })
  it('does not match across a region boundary', () => {
    const split = [
      { base: '0x1000', bytes: Buffer.from([0x89, 0x41]) },
      { base: '0x1002', bytes: Buffer.from([0x10, 0xc3]) }
    ]
    expect(a.snapshotScanAob(split, '89 41 10')).toEqual([])
  })
  it('snapshotDecodeRun reports length and relocatability', () => {
    const r = a.snapshotDecodeRun(regions, '0x1000', 3)
    expect(r.decodable).toBe(true)
    expect(r.length).toBe(3)
    expect(r.relocatable).toBe(true)
  })
  it('snapshotBuildSignature returns null outside every region', () => {
    expect(a.snapshotBuildSignature(regions, '0x9000', 3)).toBeNull()
  })
})
```

- [ ] **Step 3: Run; expect FAIL** (`a.snapshotScanAob is not a function`).
Run: `npx vitest run tests/native/snapshot_ops.test.ts`

- [ ] **Step 4: Implement `snapshot_ops.cc`.**
  - Parse `regions` into `struct SnapRegion { uintptr_t base; const uint8_t* data; size_t size; }` (borrow the Buffer data for the call's duration; sort by base).
  - `SnapSigMemory : SigMemory`: `Read` finds the region containing `addr`, copies `min(len, regionEnd - addr)` bytes, returns 0 when `addr` is in no region; `RegionBase` returns that region's base.
  - `SnapshotBuildSignature`: locate the instruction bytes at `insnAddress` (length `insnLength`, clamp to region), call `BuildSignature`, return `{signature, signatureOffset}` or null.
  - `SnapshotScanAob`: `ParseSignature`, then per region a plain byte loop honoring `wildcard`; results `ToHex`.
  - `SnapshotDecodeRun`: read up to 64 bytes at `address` (clamped to region) and call `DecodeRunBuffer`.
  - `ListExecRegions(handle)`: walk with `platform::QueryRegion` from 0, collecting `executable && readable` regions; advance by `size`; guard non-advancing.
  Register all four in `addon.cc` and `binding.gyp`.

- [ ] **Step 5: Build and run.**
Run: `cd native && npx node-gyp build && cd .. && npx vitest run tests/native/snapshot_ops.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the differential test (the real proof).** In `tests/native/snapshot_ops.test.ts` add a second `describe` that spawns the harness (copy the beforeAll/afterAll/`send`/stamina helpers from `write_watch.test.ts`), captures the stamina write via `startWriteWatch`/`pollWriteWatch`/`stopWriteWatch`, then:
```ts
const execRegions = a.listExecRegions(handle)
const regions = execRegions.map((r: any) => ({
  base: r.base,
  bytes: Buffer.from(a.readBytes(handle, r.base, r.size), 'hex')
}))
const snap = a.snapshotBuildSignature(regions, insn.instructionAddress, insn.length)
expect(snap.signature).toBe(insn.signature)
expect(snap.signatureOffset).toBe(insn.signatureOffset)
// and the live scan agrees with the snapshot scan
expect(a.snapshotScanAob(regions, insn.signature).sort())
  .toEqual((await a.scanAob(handle, insn.signature)).sort())
```
Check `readBytes`' real return type in `patch_ops.cc`/`patchEngine.ts` (`readBytes(address, length): string | null`, hex) and that `insn.instructionAddress` is exposed on the polled object (`write_watch.cc` ~L975); adjust field names to what is actually exported. Regions larger than `readBytes`' cap must be read in chunks.
Run: `npx vitest run tests/native/snapshot_ops.test.ts`
Expected: PASS. This proves snapshot building and scanning equal live behaviour on a real process.

- [ ] **Step 7: Commit.**
```bash
git add native tests/native/snapshot_ops.test.ts
git commit -m "feat(native): snapshot-backed signature build, AOB scan and decodeRun; listExecRegions"
```

---

### Task 4: Snapshot file format and `ReplayOps`

**Files:**
- Create: `src/main/replay/snapshotFile.ts`, `src/main/replay/replayOps.ts`
- Test: `tests/main/replayOps.test.ts`

**Interfaces:**
- Consumes: addon `snapshotScanAob`, `snapshotDecodeRun`; `PatchOps` from `src/main/patchEngine.ts` (implement only the methods the locate path uses; the rest throw `Error('ReplayOps: <name> is not replayable')`).
- Produces:
```ts
export interface SnapshotRegion { base: string; size: number; bytes: Buffer; pre?: Buffer; post?: Buffer }
export interface SnapshotModule { name: string; base: string; size: number; timestamp: number }
export interface SnapshotSite { id: string; address: string; length: number }
export interface Snapshot {
  version: 1
  game: string
  build: string
  modules: SnapshotModule[]
  regions: SnapshotRegion[]
  sites: SnapshotSite[]
}
export function encodeSnapshot(s: Snapshot): Buffer          // gzip
export function decodeSnapshot(b: Buffer): Snapshot
export function snapshotSha256(b: Buffer): string             // hex of the encoded file
export class ReplayOps implements Partial<PatchOps> { constructor(s: Snapshot, addon?: any) }
```
File layout before gzip: `u32le headerLength`, header JSON (`Snapshot` minus `regions[].bytes`, plus per-region `offset`), then concatenated region bytes.

- [ ] **Step 1: Write failing tests** `tests/main/replayOps.test.ts`: round-trip `encodeSnapshot`/`decodeSnapshot` equality; `ReplayOps.readBytes` inside/outside a region (`null` outside, hex inside, `null` when the read would cross the end); `scanAob` returns the addresses `snapshotScanAob` gives and honours `rangeStart`/`rangeEnd`; `getModuleBase` case-insensitive, `null` when absent; `decodeRun` delegates.

- [ ] **Step 2: Run; expect FAIL** (module missing).
Run: `npx vitest run tests/main/replayOps.test.ts`

- [ ] **Step 3: Implement** the two files. `ReplayOps` builds its native region array once in the constructor; `scanAob(signature, rangeStart?, rangeEnd?)` calls `snapshotScanAob` and filters by range (`hit >= rangeStart && hit + sigLen <= rangeEnd`, same rule as `RunScanAob`, computing `sigLen` as the token count).

- [ ] **Step 4: Run; expect PASS. Then `npx tsc --noEmit`.**

- [ ] **Step 5: Commit.**
```bash
git add src/main/replay tests/main/replayOps.test.ts
git commit -m "feat: snapshot file format and ReplayOps over recorded memory"
```

---

### Task 5: Synthetic-tier tests (always run, including CI)

**Files:**
- Create: `tests/main/fixtures/synthImage.ts`
- Test: `tests/main/replay.synthetic.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `ReplayOps`, addon `snapshotBuildSignature`, `PatchEngine` and its `locate(patch)`.
- Produces: `buildSynthSnapshot(opts): { snapshot: Snapshot, sites: {...} }` used by tests only.

The synthetic image is hand-assembled x86-64 in one region at a fixed base, with three traps:

1. **Twin bodies.** Two byte-identical methods (`push rbp; mov rbp,rsp; movss [rcx+0x3c], xmm0; pop rbp; ret`) at different addresses, as Mono emits for generic instantiations. A signature built at site A must match TWO places.
2. **Region edge.** A site 0x13 bytes from the region base (the harness's own failure case): lead-in must clamp to the region and the signature must still match once.
3. **Relocation stability.** One method containing a RIP-relative `lea` and a `movabs r11, imm64`, loaded at two different bases with different imm64 values: signatures built from the two snapshots must be equal, and each scan must hit exactly one address.

- [ ] **Step 1: Write the failing tests.**
```ts
it('twin bodies: signature is ambiguous and the engine refuses to patch a guess', async () => {
  const { snapshot, sites } = buildSynthSnapshot()
  const sig = a.snapshotBuildSignature(regionsOf(snapshot), sites.twinA, 5)
  const ops = new ReplayOps(snapshot)
  expect((await ops.scanAob(sig.signature)).length).toBe(2)
  const status = await engineFor(ops).locate(patchFor(sig, sites.twinA))
  expect(status.state).toBe('not-found')
  expect(status.matchCount).toBe(2)
})
it('region edge: lead-in clamps and the signature matches exactly once', async () => {
  const { snapshot, sites } = buildSynthSnapshot()
  const sig = a.snapshotBuildSignature(regionsOf(snapshot), sites.edge, 2)
  expect((await new ReplayOps(snapshot).scanAob(sig.signature)).length).toBe(1)
  expect(sig.signatureOffset).toBeLessThanOrEqual(0x13)
})
it('relocation: same code at two bases and imm64 values gives one signature', async () => {
  const one = buildSynthSnapshot({ base: 0x10000, imm64: 0x1111222233334444n })
  const two = buildSynthSnapshot({ base: 0x7ff00000n, imm64: 0x5555666677778888n })
  const s1 = a.snapshotBuildSignature(regionsOf(one.snapshot), one.sites.reloc, one.sites.relocLen)
  const s2 = a.snapshotBuildSignature(regionsOf(two.snapshot), two.sites.reloc, two.sites.relocLen)
  expect(s1.signature).toBe(s2.signature)
  expect(s1.signature).toContain('??')
  expect(await new ReplayOps(two.snapshot).scanAob(s1.signature)).toEqual([two.sites.reloc - BigInt(s2.signatureOffset)].map(h))
})
```
Define `regionsOf`, `engineFor` (a `PatchEngine` constructed with the `ReplayOps`; read `tests/main/patchEngine.test.ts` for how it constructs one and a minimal `PatchCheat`), `patchFor`, and `h` (bigint to `0x` hex) in the test file. Use real encodings; verify each hand-assembled byte string with `a.disassembleBuffer` inside the fixture builder (assert the mnemonics) so a typo fails loudly instead of testing garbage.

- [ ] **Step 2: Run; expect FAIL** (builder missing).

- [ ] **Step 3: Implement `synthImage.ts`.** Emit the bytes with a tiny helper (`bytes(...)`, `pad(n)`), place the three sites, return addresses as bigint. Give methods distinct 8-16 byte prologues where uniqueness is intended so only the twins collide.

- [ ] **Step 4: Run.**
Run: `npx vitest run tests/main/replay.synthetic.test.ts`
Expected: PASS. If a trap does NOT behave as the test says, that is a finding about the heuristic: stop and report it instead of bending the test.

- [ ] **Step 5: Commit.**
```bash
git add tests/main
git commit -m "test: synthetic fixture replay pins twin-body, region-edge and relocation behaviour"
```

---

### Task 6: Recorder, manifest, real tier, docs

**Files:**
- Create: `mcp-server/scripts/recordSnapshot.js`, `tests/fixtures/manifest.json`, `tests/replay/real.test.ts`
- Modify: `.gitignore`, `mcp-server/scripts/README.md`, `CODEBASE_MAP.md`, `README.md` (short section)

**Interfaces:**
- Consumes: addon `attach`, `listModules`, `listExecRegions`, `readBytes`; the Task 4 file layout.
- Produces: `tests/fixtures/manifest.json`
```json
{ "version": 1, "sites": [
  { "game": "valheim", "build": "<fingerprint>", "snapshot": "valheim-<fp>.snap",
    "snapshotSha256": "<hex>", "id": "<patch id>", "address": "0x..", "length": 5,
    "signature": "48 89 ??", "signatureOffset": 0, "matchCount": 1, "relocatable": true }
] }
```
Initial file: `{ "version": 1, "sites": [] }`.

- [ ] **Step 1: Recorder.** `node mcp-server/scripts/recordSnapshot.js <pid|exe-name> <game> <out.snap> [siteId:address:length ...]`: attach, `listModules`, `listExecRegions`, read each region with `readRegionBuffer` plus its margins (`base-64` x 64 bytes, `base+size` x 128 bytes; null means absent), write the layout from Task 4 with `zlib.gzipSync`. Print region count, total MB, SHA-256. Refuse to write inside the git-tracked tree except `fixtures/snapshots/`. Follow the style of the neighbouring scripts (`survey.js`).

- [ ] **Step 2: Contract test** in `tests/main/replayOps.test.ts`: run the recorder's exported `writeSnapshotFile(snapshot, path)` on a small snapshot and read it back with `decodeSnapshot`. (Export the writer from the script behind `require.main === module`.) This pins the JS writer to the TS reader.

- [ ] **Step 3: Real tier** `tests/replay/real.test.ts`: for each manifest site, `it.skipIf(!fs.existsSync(snapPath))`; when present, verify the file's SHA-256 equals the manifest, then assert: `ReplayOps.scanAob(signature)` returns exactly `[address - signatureOffset]`, `readBytes` equals the recorded original bytes, `snapshotBuildSignature` rebuilds the manifest signature and offset, and `snapshotDecodeRun(...).relocatable` equals the manifest flag. Log a skip reason naming the missing snapshot file. Empty manifest means the suite has zero tests, which vitest reports as no tests: guard with `it('manifest parses', ...)`.

- [ ] **Step 3b: Cross-build test (for sites with two snapshots of one game).** For a manifest group with `build` A and B, assert the patch either relocates to exactly one address in B or reports `matchCount !== 1`, and never that a wrong address matches. Skipped unless both snapshots exist.

- [ ] **Step 4: Docs and ignores.** `.gitignore`: `fixtures/snapshots/`. Add the recorder to `mcp-server/scripts/README.md`, a `replay/` row to `CODEBASE_MAP.md`, and a short README section ("Fixture replay: record, then run `npx vitest run tests/replay`; snapshots stay local because they contain game code").

- [ ] **Step 5: Verify all.**
Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit.**
```bash
git add mcp-server/scripts tests .gitignore CODEBASE_MAP.md README.md
git commit -m "feat: snapshot recorder, manifest and real-tier replay tests"
```

- [ ] **Step 7 (needs the games running; do with the user, not unattended): record Valheim and Schedule I** with the recorder, add their sites to the manifest with signatures taken from the shipped cheats, run `npx vitest run tests/replay`, commit only the manifest.

# Fixture replay — design

Regression-test signature building and patch relocation against recorded real
games, offline, without owning N games.

## Problem

Nearly every real defect (Valheim, 2026-07-25) was invisible to `harness.exe`:
signatures built from one instruction matched hundreds of places, and `locate`
verified bytes at the wrong copy of identical JIT'd code. Signature building
lives inline in the hardware-breakpoint handler (`native/src/write_watch.cc`,
~L528-770) and reads the live process directly, so it cannot run on recorded
bytes. (Uniqueness is not checked at build time; it is checked later by
`scanAob` at locate time, which is why replay needs a snapshot scan too.)

## Non-goals

- Replaying Mono/IL2CPP/UE reflection results (anchored-cheat resolution).
- Committing any game bytes. Snapshots are local and gitignored; committing
  game code is redistribution.

## Design

### 1. `MemoryView` and a pure signature builder (native)

Extract the signature builder into a function over a small interface:
read bytes at an address, enumerate executable regions. Two implementations:
the live process (behaviour unchanged) and a snapshot file. The addon exports
`buildSignatureFromSnapshot`. One code path is tested; no TS reimplementation
that could drift.

Guard: signatures produced live must be byte-identical before and after the
extraction (compared on `harness.exe` and the existing `tests/native` suite).

### 2. Snapshot format and `ReplayOps`

One compressed `.snap` per game build: executable regions (base, size, bytes)
each with its readable **margins** (up to 64 bytes before, 128 after - the
largest window the signature builder reads; absent when unreadable at record
time). The margins are load-bearing: the builder's window read is
all-or-nothing and crosses region edges live, so a snapshot of executable
bytes alone made a site near a region edge take the "window unreadable"
fallback and produce a different, weaker signature (found by the live-vs-
snapshot differential test). Margins are never scanned. Plus `listModules` output (name, base, `SizeOfImage`, `TimeDateStamp`) and the
recorded sites. `ReplayOps` (TS) implements `PatchOps`/`AnchorOps` over it:
`scanAob`, `readBytes`, `getModuleBase`, `decodeRun`. The real `patchEngine`
runs against it unmodified.

### 3. Recorder

A read-only script in `mcp-server/scripts`. Dumps the snapshot plus the sites
of interest: each shipped patch address and chosen write-watch hits.

### 4. Storage

Snapshots: `fixtures/snapshots/`, gitignored. Committed:
`tests/fixtures/manifest.json`, per site: game, build fingerprint, snapshot
SHA-256, expected signature, `signatureOffset`, match count (1), expected
`decodeRun` relocatable flag. No game bytes.

### 5. Tests, two tiers

- **Synthetic** (always runs, including CI): a generated snapshot with traps -
  identical JIT bodies for generic instantiations, a site near a region edge, a
  `movs`-style block copy.
- **Real** (only when the `.snap` exists locally; otherwise skips with a
  message): every manifest site still gives one match at the recorded address,
  original bytes verify, signature is stable when rebuilt from a second
  snapshot of the same build, and across two builds it relocates uniquely or
  reports "can't relocate" - never a wrong match.

## Order of work

1. Extract `MemoryView` and the pure builder; existing native suite is the net.
2. Snapshot format and `ReplayOps`.
3. Synthetic-tier tests.
4. Recorder script.
5. Record Valheim and Schedule I; write the manifest.

## Safety rules (unchanged, still the judge)

Never patch a guess: 0 or >1 matches is "can't relocate". Never write NOPs to
bytes that are neither original nor NOPs. Always restore on disable/detach.

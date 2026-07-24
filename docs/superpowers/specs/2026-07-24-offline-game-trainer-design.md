# Offline Game Trainer — Design

## Purpose

A desktop app (like WeMod/Cheat Engine) for modifying in-memory values of
running single-player games — infinite stamina, health, etc. Fully offline:
no network calls, no accounts, no license checks, no auto-update fetching.
Strictly for single-player titles where memory edits give no competitive
advantage.

## Scope (v1)

- Windows only.
- One proof-of-concept game: Valheim.
- No known offsets exist yet — offsets/pointer chains are discovered via a
  built-in scanner, not fetched from anywhere.

## Architecture

- **Electron renderer** — UI: process picker, cheat list, scanner screen.
- **Electron main process** — orchestration, IPC handler, freeze-loop
  scheduler.
- **Native addon (C++ / N-API)** — the only code that touches Win32 memory
  APIs (OpenProcess, ReadProcessMemory, WriteProcessMemory, Toolhelp32
  enumeration, VirtualQueryEx).
- **Local cheat-definition store** — one JSON file per game under
  `games/<exe-name>.json`. No network access anywhere in this stack.

## Native addon — operations

- `listProcesses()` — enumerate running processes (PID + name) via
  Toolhelp32Snapshot.
- `attach(pid)` — OpenProcess handle; enumerate modules for base addresses.
- `scanFirst(dataType, value)` — walk readable committed regions
  (VirtualQueryEx) for an exact value match; return candidate addresses.
- `scanNext(addresses, filter)` — re-read previous candidates; filter by
  exact / changed / unchanged / increased / decreased.
- `resolvePointerChain(targetAddress, maxLevels)` — search memory for
  values pointing at the target address, recursing up to `maxLevels`,
  keeping only chains anchored to a static module base + offset path (so
  the address survives ASLR / process restarts).
- `readValue(chain, dataType)` / `writeValue(chain, dataType, value)` —
  resolve the chain from the current module base on every call, then
  Read/WriteProcessMemory.

## Cheat definition schema

Each game's JSON file is an array of entries:

```json
{
  "id": "stamina",
  "name": "Infinite Stamina",
  "dataType": "float",
  "mode": "freeze",
  "moduleName": "valheim.exe",
  "baseOffset": "0x...",
  "offsets": ["0x...", "0x..."],
  "value": 999
}
```

- `mode: "freeze"` — continuously rewritten while enabled.
- `mode: "oneshot"` — written once when triggered, no ongoing loop.

## Freeze loop

Main process runs a scheduler (~100ms tick). For each enabled freeze-mode
cheat, calls `writeValue` again every tick. One-shot cheats call
`writeValue` once on click, no loop entry.

If a pointer chain fails to resolve at runtime (game patched/updated,
memory layout changed), that cheat auto-disables and the UI flags it as
broken — it does not silently no-op.

## UI flow

1. **Process picker** — list running processes, searchable; pick the
   target (e.g. Valheim).
2. **Cheat list** — definitions from `games/<exe-name>.json` matching the
   attached process, each with a toggle (freeze) or button (one-shot).
   Empty until at least one cheat has been scanned and saved.
3. **Scanner screen**:
   - Enter data type + current known value → "First Scan" → candidate
     count.
   - Change the value in-game, then enter the new value or pick a filter
     (changed / increased / decreased / unchanged) → "Next Scan" →
     repeat until narrowed to one address.
   - "Resolve Pointer Chain" on the surviving address.
   - "Save as Cheat" — name it, choose freeze vs one-shot, mode, and it's
     written into the game's JSON file and appears in the cheat list.

## Branding & UI design

App name: **Tamper**. Layout mirrors the familiar trainer pattern (sidebar
process/game list, category-tabbed cheat rows with toggle + hotkey) but
with its own visual identity, executed at a polished-SaaS quality bar —
refined spacing, subtle depth (soft shadows, gentle gradients on accent
elements), smooth pill-style toggles, consistent icon weight. Not a raw
terminal look.

**Palette**
- `#0A0B0A` — background
- `#161816` — panel/card surface
- `#FFB000` — signature accent (amber)
- `#3ECF8E` — active/on state
- `#FF5C5C` — broken-chain/error state
- `#8A8F87` — muted text/hairlines

**Type**
- Headers: IBM Plex Mono (bold)
- Body: IBM Plex Sans
- Data (addresses, hotkeys, values): IBM Plex Mono, tabular figures, dimmed

**Signature element**: each cheat row shows a small refined pill with its
resolved memory address (dim, low-contrast, rounded — not raw mono text
dumped inline). When a freeze-mode cheat is enabled, a small amber dot
pulses in sync with the write-loop tick, indicating memory is actively
being rewritten right now rather than just "on."

## Error handling

- Attach fails (process gone / access denied) → show error, return to
  process picker.
- Scan yields zero or too many candidates → stay on scanner screen, allow
  retry with a tighter filter.
- Pointer-chain resolution finds no static path within `maxLevels` → tell
  the user to pick a different candidate address or increase scan depth;
  do not save a broken chain.
- Broken chain at runtime (post game-update) → cheat auto-disables and is
  flagged in the UI; app does not crash or fail silently.

## Testing

- **Native addon**: unit-tested against a small synthetic test-harness
  executable (a throwaway C program exposing known int/float globals at a
  nontrivial pointer depth) rather than against Valheim — this makes
  scan/filter/pointer-chain/read/write logic deterministically testable.
- **End-to-end**: manual validation against a running Valheim instance —
  scan for stamina/health, resolve chains, freeze, confirm in-game effect.

## Out of scope (v1)

- Any network calls (community definition sharing, accounts, licensing,
  auto-update).
- Non-Windows platforms.
- Games beyond the Valheim proof of concept.
- Anti-cheat evasion or multiplayer/competitive use.

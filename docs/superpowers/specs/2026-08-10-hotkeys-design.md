# Global hotkeys for cheats and patches

## Problem

Every cheat and patch in Apprentice can only be toggled/applied by clicking
in the trainer window. In practice the trainer is never the focused window
while playing — the game is — so using a cheat means alt-tabbing away from
the game every time. Cheat Engine and tools like WeMod solve this with
per-entry global hotkeys that fire while the game has focus.

## Goal

Let any saved cheat (value cheat or patch) have an optional global hotkey
that toggles it (or applies a one-shot) while the target game has focus,
with audible on/off/error feedback since the trainer window won't be
visible when it fires.

## Design

### Data model

`CheatDefinition` and `PatchCheat` (`store.ts`) both gain:
```ts
hotkey?: string // an Electron accelerator string, e.g. "CommandOrControl+Shift+F1"
```
Absent means no hotkey — every existing saved cheat keeps loading and
behaving exactly as before, the same convention every other optional field
in this codebase already follows. No `profile.ts` migration needed.

### Capture UX (renderer)

A "Set hotkey" button per cheat/patch row (mirroring the existing Rename
button's inline-edit pattern) enters a capture state: a small "Press
keys…" indicator replaces the button, and a temporary `window`-level
`keydown` listener builds an accelerator string from the pressed combo.

- Requires exactly one modifier (`Ctrl`/`Alt`/`Shift`/`Meta`, any
  combination) **and** one non-modifier key from a restricted, unambiguous
  set: `A`-`Z`, `0`-`9`, `F1`-`F12`. Anything else (punctuation, media
  keys, a bare modifier with no other key) is rejected inline with "Use a
  letter, number, or function key, with at least one modifier" — this
  keeps the renderer-to-Electron-accelerator mapping small and exact
  rather than needing a full keycode table.
- The captured combo displays live as it's built; Save persists it, Cancel
  discards and exits capture mode.
- A cheat/patch with a hotkey shows a small chip next to its row (e.g.
  `Ctrl+Shift+F1`) with a "Clear" action.

### Conflict validation (main, authoritative)

`cheats:save`'s existing handler (`ipc.ts`) gains a check: before saving a
cheat whose `hotkey` is set, scan the rest of the attached exe's profile
(`loadCheats(exeName)`) for any OTHER cheat already using that exact
accelerator string, and reject the save with an error naming the
conflicting cheat if found. This runs on every save (not just
hotkey-specific ones) since it's cheap and keeps the invariant enforced
regardless of how a save was triggered — but it only ever fires when
`hotkey` is actually set on the cheat being saved. The renderer also
does an optimistic local check against its already-loaded `cheats`/
`patches` arrays before calling `saveCheat`, for immediate feedback
without a round trip — but the main-side check is what's authoritative,
since the renderer's local list can be stale.

### Registration (main) — new `src/main/hotkeys.ts`

Owns Electron's `globalShortcut` registrations for the attached exe's
cheats:

- `registerAll(exeName)`: unregisters everything this module previously
  registered, then loads the exe's cheats and registers one
  `globalShortcut.register(accelerator, callback)` per cheat/patch with a
  `hotkey`. Called on attach (alongside the existing attach flow in
  `ipc.ts`) and after any save that could have changed a hotkey.
- `unregisterAll()`: unregisters everything this module registered.
  Called on detach, on exe change, and from the existing
  `app.on('before-quit', releaseTarget)` handler in `index.ts` (extended
  to also call this).
- Any accelerator `globalShortcut.register` refuses (returns `false` —
  another running app already owns that combo) is collected and reported
  back to the renderer as a one-time banner via a new `hotkey:conflict`
  push event listing which cheats' hotkeys didn't register and why —
  never silently dropped.

### Firing

The registered callback, per cheat:
- **Freeze-mode value cheat**: checks current state via a new
  `FreezeLoop.isEnabled(cheatId): boolean` (`return this.active.has(cheatId)`
  — the one small addition `freezeLoop.ts` needs), then calls
  `freezeLoop.enable(cheat)` or `.disable(cheat.id)` — the same calls
  `cheats:toggleFreeze`'s existing handler already makes.
- **One-shot value cheat**: calls the same `writeCheat` path
  `cheats:oneShot`'s handler uses. No on/off state — always reports
  `applied`.
- **Patch**: checks current state via the existing
  `patchEngine.isApplied(patch.id)`, then calls `cheatRuntime.arm(patch)`
  or `cheatRuntime.disarm(patch.id, patch)` — the same calls
  `patch:apply`/`patch:restore`'s existing handlers make.

After the action, a `hotkey:fired` event is pushed to the renderer:
`{ cheatId, outcome: 'on' | 'off' | 'applied' | 'error', error?: string }`.
(One-shot's `applied` reuses the "on" sound cue rather than adding a
fourth tone — it's a positive action, same as turning something on.)

### Renderer: sound + state sync

A new `src/renderer/src/sound.ts` plays a short tone via the Web Audio
API (`AudioContext` + `OscillatorNode`) — no bundled audio assets, no
licensing:
- `playOn()`: a short rising two-note chime.
- `playOff()`: a short falling two-note chime (distinct pattern, not just
  the reverse of `playOn`, so the two are easy to tell apart by ear).
- `playError()`: a short low buzz/double-beep.

`CheatList.tsx` subscribes to `window.tamper.onHotkeyFired` (a new
preload/`tamper.d.ts` entry, mirroring the existing `onCheatState`
pattern exactly) once, in the same `useEffect` that already wires
`onCheatState`/`onGameState`. On each event it:
1. Plays the matching sound.
2. Updates the same local state a click-driven toggle already updates
   (`enabled`/`setEnabled` for freeze cheats, `patchEnabled`/
   `setPatchEnabled` for patches) — **this is the fix for a real gap
   found while reading the existing toggle code**: today, `enabled` is
   only ever set inside the renderer's own `toggle()`/`togglePatch()`
   functions. A hotkey fires entirely in the main process, so without
   this the on-screen checkbox would silently disagree with the game's
   actual state until the cheat list next reloads.
3. On `error`, surfaces the error the same way `patchError`/toggle
   failures already do.

Also subscribes to `onHotkeyConflict` (the registration-failure banner
from above), rendered as a dismissible `.banner`, same pattern as the CT
import/export banners.

## Out of scope

- Hotkeys only register while their exe is attached — no
  always-on-regardless-of-attachment mode, consistent with everything
  else in this app requiring attachment.
- No master "hotkeys enabled/disabled" switch for the whole feature.
- No in-game visual overlay — sound is the only fire-time feedback
  channel, confirmed above.
- No support for punctuation/media keys in the capture UI — the
  restricted key set (letters, digits, F1-F12) covers realistic use
  without a full keycode-to-accelerator mapping table.

## Testing

- `hotkeys.ts`'s registration/conflict logic is testable the way
  `patchEngine.ts`/`cheatRuntime.ts` already are: behind a thin interface
  over `globalShortcut` (so a fake can simulate register success/failure)
  rather than importing Electron's real module directly into a unit test.
- The `cheats:save` hotkey-conflict check is a pure function
  (`profile`/cheat-list in, conflicting cheat name or `null` out) and gets
  its own unit test, mirroring `profile.ts`'s existing pure-function
  tests (`verifiedModules`, `fingerprintOf`).
- `FreezeLoop.isEnabled` gets a one-line test alongside the existing
  `FreezeLoop` tests.
- No renderer test harness exists for `CheatList.tsx` today (consistent
  with how rename/CT-export were handled) — the capture UX, sound
  playback, and state-sync are verified manually.

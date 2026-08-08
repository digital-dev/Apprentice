# Sidebar navigation + light polish

## Problem

The sidebar is dead space — just a static "APPRENTICE" title. Meanwhile the
app's screens (`picker`, `cheats`, `scanner`, `mono`) are navigated via
inline buttons at the bottom of `CheatList.tsx` (`+ New cheat` →
`onOpenScanner`, `Mono Explorer` → `onOpenMonoExplorer`), which is both an
odd place for navigation to live and leaves the sidebar unused.

## Goal

Turn the sidebar into the app's real navigation surface, and give it enough
visual weight to stop looking blank. Keep the change scoped: sidebar nav
plus the minimum `theme.css` polish needed for the new nav elements to look
consistent with the rest of the app — no rework of individual screens.

## Design

### State ownership

`App.tsx` already owns `screen: Screen` and `exeName: string | null`. The
sidebar becomes a controlled component driven by this same state — no new
state is introduced.

```ts
Sidebar({
  screen: Screen
  exeName: string | null
  onNavigate: (screen: Screen) => void
})
```

`onNavigate` is `setScreen` from `App.tsx`, passed straight through (matching
the existing lifted-state pattern the file already documents for
`exeName`/`screen`).

### Sidebar contents

Top to bottom:

1. **Brand header** — kept (`APPRENTICE`), tightened spacing to make room for
   what follows.
2. **Attach status** — exe name + `pulse-dot` (existing CSS class) when
   `exeName` is set; muted "Not attached" text when it isn't.
3. **Nav list** — four items, one per `Screen` value:
   - Attach (`picker`)
   - Cheats (`cheats`)
   - Scanner (`scanner`)
   - Mono Explorer (`mono`)

   Each item is a `<button>`-like nav row. Clicking calls
   `onNavigate(screenId)`. The active screen gets an `.active` class
   (accent-colored left border + accent text, mirroring the existing
   `--accent` token). `cheats`, `scanner`, and `mono` are `disabled` when
   `exeName` is `null` — `picker` (Attach) is always enabled, since it's how
   you get an exe attached in the first place. Disabled items are dimmed and
   inert (no click handler fires), consistent with the existing
   `button:disabled { opacity: 0.5; cursor: not-allowed; }` rule.

Sidebar does not render Import Cheat Table — that stays an inline action on
`CheatList.tsx` since it is a one-off action, not a navigation destination.

### App.tsx changes

- Pass `screen`, `exeName`, and `onNavigate={setScreen}` to `<Sidebar />`.
- No changes to the screen-mounting logic below it (picker/cheats/mono/
  scanner conditional rendering stays exactly as-is — only how `screen`
  gets set changes, not what happens once it's set).

### CheatList.tsx changes

- Remove the `+ New cheat` button (`onClick={onOpenScanner}`) and the
  `Mono Explorer` button (`onClick={onOpenMonoExplorer}`) — both now
  redundant with sidebar nav.
- `onOpenScanner`/`onOpenMonoExplorer` props are removed from `CheatList`'s
  props and from where `App.tsx` passes them in, since navigation no longer
  originates from this screen.
- `Import Cheat Table (.CT)` button and its handler are untouched.

### theme.css changes

Add rules scoped to the new nav elements:

- `.sidebar` — adjust padding/layout for the new vertical stack (brand →
  status → nav list), using existing spacing rhythm (`16px`/`24px` seen
  elsewhere in the file).
- `.exe-badge` — small row for the attach-status line, reusing
  `.pulse-dot` and `--muted`/`--accent` tokens already defined.
- `.nav-item` — base style for nav rows (padding, border-radius, matching
  the existing `li`/`button` visual language rather than inventing a new
  one).
- `.nav-item.active` — accent left border + accent text color.
- `.nav-item:disabled` — same dimming as the existing global
  `button:disabled` rule, applied here since nav items aren't plain
  `<button>`s once styled as rows.

No other screens (`ProcessPicker`, `Scanner`, `MonoExplorer`) are touched.
Any other `theme.css` adjustment is limited to fixes directly needed for
the new nav to read consistently (e.g. aligning `li` hover/active states
with `.nav-item` states) — not a broader restyle.

## Out of scope

- Redesigning `ProcessPicker`, `Scanner`, or `MonoExplorer` layouts.
- Adding new app state, routing library, or URL-based navigation.
- Moving `Import Cheat Table (.CT)` into the sidebar.

## Testing

No existing tests reference the buttons being removed or the `Sidebar`
component (confirmed via search). This is a UI-only change with no new
runtime behavior to unit test; manual verification (visually confirm nav
works, active/disabled states are correct, cheat list still functions
without its old buttons) is sufficient.

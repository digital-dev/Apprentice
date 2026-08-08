# Sidebar Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the blank sidebar into the app's real navigation surface (Attach/Cheats/Scanner/Mono Explorer), removing the redundant inline nav buttons from `CheatList.tsx`, and add the minimal `theme.css` styling for it to look intentional.

**Architecture:** `Sidebar` becomes a controlled component driven by `App.tsx`'s existing `screen`/`exeName` state (no new state anywhere). It renders a brand header, an attach-status row, and four nav rows that call `onNavigate(screen)`. `CheatList.tsx` loses the two buttons that used to do this job.

**Tech Stack:** React 18 (function components + hooks), TypeScript, plain CSS (`theme.css`), Vitest for any test runs.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-sidebar-nav-design.md`
- No new app state — `Sidebar` is driven entirely by `screen`/`exeName`/`onNavigate` props already available in `App.tsx`.
- `picker` nav item is always enabled; `cheats`, `scanner`, `mono` are disabled when `exeName` is `null`.
- `Import Cheat Table (.CT)` stays on `CheatList.tsx` — do not move it to the sidebar.
- No changes to `ProcessPicker.tsx`, `Scanner.tsx`, or `MonoExplorer.tsx` internals.
- Reuse existing CSS tokens/classes (`--accent`, `--muted`, `.pulse-dot`, `button:disabled` dimming) rather than inventing new visual language.
- This is a UI-only change; no existing tests reference the removed buttons or `Sidebar` (confirmed by search) — verification is manual (build + visual check), not new unit tests.

---

### Task 1: Make `Sidebar` a controlled nav component

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx` (currently 7 lines, static `<h1>APPRENTICE</h1>` only)
- Modify: `src/renderer/src/App.tsx:9` (the `Screen` type — export it so `Sidebar` can import it), `App.tsx:29-31` (where `<Sidebar />` is rendered)

**Interfaces:**
- Consumes: `Screen` type (`'picker' | 'cheats' | 'scanner' | 'mono'`), currently declared unexported at `App.tsx:9`.
- Produces: `Sidebar({ screen, exeName, onNavigate })` — the props contract `App.tsx` and any future caller rely on:
  ```ts
  interface SidebarProps {
    screen: Screen
    exeName: string | null
    onNavigate: (screen: Screen) => void
  }
  ```

- [ ] **Step 1: Export the `Screen` type from `App.tsx`**

In `src/renderer/src/App.tsx`, change:
```ts
type Screen = 'picker' | 'cheats' | 'scanner' | 'mono'
```
to:
```ts
export type Screen = 'picker' | 'cheats' | 'scanner' | 'mono'
```

- [ ] **Step 2: Rewrite `Sidebar.tsx` as a controlled nav component**

Replace the full contents of `src/renderer/src/components/Sidebar.tsx` with:

```tsx
import type { Screen } from '../App'

const NAV_ITEMS: { screen: Screen; label: string }[] = [
  { screen: 'picker', label: 'Attach' },
  { screen: 'cheats', label: 'Cheats' },
  { screen: 'scanner', label: 'Scanner' },
  { screen: 'mono', label: 'Mono Explorer' }
]

export default function Sidebar({
  screen,
  exeName,
  onNavigate
}: {
  screen: Screen
  exeName: string | null
  onNavigate: (screen: Screen) => void
}) {
  return (
    <div className="sidebar">
      <h1>APPRENTICE</h1>
      <div className="exe-badge">
        {exeName ? (
          <>
            <span className="pulse-dot" />
            <span>{exeName}</span>
          </>
        ) : (
          <span className="muted">Not attached</span>
        )}
      </div>
      <nav className="nav-list">
        {NAV_ITEMS.map((item) => {
          const disabled = item.screen !== 'picker' && !exeName
          return (
            <button
              key={item.screen}
              className={`nav-item${screen === item.screen ? ' active' : ''}`}
              disabled={disabled}
              onClick={() => onNavigate(item.screen)}
            >
              {item.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
```

- [ ] **Step 3: Wire `Sidebar` up from `App.tsx`**

In `src/renderer/src/App.tsx`, change:
```tsx
    <div className="layout">
      <Sidebar />
```
to:
```tsx
    <div className="layout">
      <Sidebar screen={screen} exeName={exeName} onNavigate={setScreen} />
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit` (no dedicated `typecheck` script exists in `package.json` — this project only defines `dev`/`build`/`test`)
Expected: no errors related to `Sidebar`, `Screen`, or `App.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx
git commit -m "Turn sidebar into controlled screen nav"
```

---

### Task 2: Remove redundant nav buttons from `CheatList`

**Files:**
- Modify: `src/renderer/src/screens/CheatList.tsx:106-123` (props destructure/type), `CheatList.tsx:737-738` (the buttons)
- Modify: `src/renderer/src/App.tsx:44-52` (the `<CheatList />` call site, since it currently passes `onOpenScanner`/`onOpenMonoExplorer`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CheatList` props shrink to:
  ```ts
  {
    exeName: string
    pendingMonoSelection?: PendingMonoSelection | null
    onConsumePendingMonoSelection?: () => void
  }
  ```
  `onOpenScanner` and `onOpenMonoExplorer` no longer exist on this component — navigation to those screens now happens exclusively via `Sidebar` (Task 1).

- [ ] **Step 1: Drop the two buttons in `CheatList.tsx`**

Change (around line 737-738):
```tsx
      <button onClick={onOpenScanner}>+ New cheat</button>
      {onOpenMonoExplorer && <button onClick={onOpenMonoExplorer}>Mono Explorer</button>}
      <button onClick={importCheatTable} disabled={ctImporting}>
```
to:
```tsx
      <button onClick={importCheatTable} disabled={ctImporting}>
```

- [ ] **Step 2: Remove the now-unused props from `CheatList`'s signature**

Change (around line 106-123):
```tsx
export default function CheatList({
  exeName,
  onOpenScanner,
  onOpenMonoExplorer,
  pendingMonoSelection,
  onConsumePendingMonoSelection
}: {
  exeName: string
  onOpenScanner: () => void
  onOpenMonoExplorer?: () => void
  // A selection handed over from Mono Explorer, if the user just came from
  // there ("use as value target" / "use as patch anchor"). Pre-fills the
  // matching mini creation form below; onConsumePendingMonoSelection clears
  // it once saved or dismissed so it doesn't linger into a later, unrelated
  // visit to this screen.
  pendingMonoSelection?: PendingMonoSelection | null
  onConsumePendingMonoSelection?: () => void
}) {
```
to:
```tsx
export default function CheatList({
  exeName,
  pendingMonoSelection,
  onConsumePendingMonoSelection
}: {
  exeName: string
  // A selection handed over from Mono Explorer, if the user just came from
  // there ("use as value target" / "use as patch anchor"). Pre-fills the
  // matching mini creation form below; onConsumePendingMonoSelection clears
  // it once saved or dismissed so it doesn't linger into a later, unrelated
  // visit to this screen.
  pendingMonoSelection?: PendingMonoSelection | null
  onConsumePendingMonoSelection?: () => void
}) {
```

- [ ] **Step 3: Update the `<CheatList />` call site in `App.tsx`**

Change:
```tsx
        {screen === 'cheats' && exeName && (
          <CheatList
            exeName={exeName}
            onOpenScanner={() => setScreen('scanner')}
            onOpenMonoExplorer={() => setScreen('mono')}
            pendingMonoSelection={pendingMonoSelection}
            onConsumePendingMonoSelection={() => setPendingMonoSelection(null)}
          />
        )}
```
to:
```tsx
        {screen === 'cheats' && exeName && (
          <CheatList
            exeName={exeName}
            pendingMonoSelection={pendingMonoSelection}
            onConsumePendingMonoSelection={() => setPendingMonoSelection(null)}
          />
        )}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors — `onOpenScanner`/`onOpenMonoExplorer` are gone from both the component and its call site, so there's no dangling reference.

- [ ] **Step 5: Search for any other reference to the removed props**

Run: `grep -rn "onOpenScanner\|onOpenMonoExplorer" src/`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/screens/CheatList.tsx src/renderer/src/App.tsx
git commit -m "Remove nav buttons from cheat list now that sidebar handles navigation"
```

---

### Task 3: Style the sidebar nav in `theme.css`

**Files:**
- Modify: `src/renderer/src/theme.css` (142 lines currently; append/adjust rules, don't restructure existing ones)

**Interfaces:**
- Consumes: existing tokens `--bg`, `--panel`, `--accent`, `--active`, `--muted`, `--font-display`, `--font-body`; existing classes `.sidebar`, `.sidebar h1`, `.pulse-dot`, `button:disabled`.
- Produces: new classes `.exe-badge`, `.nav-list`, `.nav-item`, `.nav-item.active`, `.muted` — used by `Sidebar.tsx` from Task 1.

- [ ] **Step 1: Add a `.muted` utility class**

`Sidebar.tsx` uses `<span className="muted">Not attached</span>` but no `.muted` class exists yet (only the `--muted` CSS variable). Add, near the other small utility rules (after `.address-chip`, around line 59):

```css
.muted {
  color: var(--muted);
}
```

- [ ] **Step 2: Add `.exe-badge` styling**

Add after the `.sidebar h1` rule (around line 44):

```css
.exe-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-data);
  font-size: 12px;
  margin: 0 0 20px;
}
```

- [ ] **Step 3: Add `.nav-list` and `.nav-item` styling**

Add directly after `.exe-badge`:

```css
.nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0;
  padding: 10px 12px;
  font-size: 14px;
  color: #eceee9;
  cursor: pointer;
}

.nav-item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
}

.nav-item.active {
  border-left-color: var(--accent);
  color: var(--accent);
  background: rgba(255, 176, 0, 0.08);
}

.nav-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

Note: `.nav-item` intentionally overrides the global `button` rule's border/background/border-radius (it's a nav row, not a form button) — this is why every property that differs from the global `button` rule (border, background, border-radius, padding) is set explicitly here rather than relying on inheritance.

- [ ] **Step 4: Adjust `.sidebar` padding for the new vertical stack**

Current rule (around line 34-38):
```css
.sidebar {
  background: var(--panel);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  padding: 16px;
}
```
Change the padding to give the nav list a bit more breathing room on the sides while keeping the top/bottom as-is:
```css
.sidebar {
  background: var(--panel);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  padding: 16px 12px;
}
```

- [ ] **Step 5: Build and visually verify**

Run: `npm run dev`
Expected: app launches, sidebar shows brand header, "Not attached" status, and four nav rows (Attach enabled, Cheats/Scanner/Mono Explorer dimmed and unclickable). Attach to any process from the picker, then confirm: status row shows the exe name with a pulsing dot, the other three nav items become enabled, and clicking each one switches screens with the active item highlighted.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/theme.css
git commit -m "Style sidebar nav: status badge, nav list, active/disabled states"
```

---

## Self-Review Notes

- Spec coverage: brand header ✅ (Task 1), attach status ✅ (Task 1/3), nav list with active/disabled states ✅ (Task 1/3), buttons removed from `CheatList` ✅ (Task 2), Import CT untouched ✅ (Task 2 leaves it in place), no other screens touched ✅ (no task modifies `ProcessPicker`/`Scanner`/`MonoExplorer`).
- Type consistency: `Screen` type exported once (Task 1) and imported by name everywhere it's used; `Sidebar` props (`screen`/`exeName`/`onNavigate`) match between its definition (Task 1) and its call site (Task 1); `CheatList` props after Task 2 match its new call site in the same task.
- No placeholders: every step has literal code to write and an exact run/verify instruction.

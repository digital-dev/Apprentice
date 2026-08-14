import type { ReactNode } from 'react'
import RowMenu, { type RowMenuItem } from './RowMenu'

export type RailState = 'idle' | 'arming' | 'active' | 'stale' | 'failed'

export interface CheatRowVM {
  id: string
  name: string
  hotkey?: string
  targetLabel: string
  mode: string
  status: { text: string; tone: 'active' | 'failed' | 'muted' }
  railState: RailState
  control: ReactNode // Toggle, checkbox, or an Apply button
  menuItems: RowMenuItem[]
  subrow?: ReactNode // per-row error / verify panel, rendered as .row-subrow
  renaming?: {
    value: string
    onChange: (v: string) => void
    onCommit: () => void
    onCancel: () => void
  }
  hotkeyCapturing?: {
    value: string | null
    onCancel: () => void
  }
  // Only meaningful when hotkey is unset and neither renaming nor capturing
  // is in progress — reveals a ghost "⌘ Set" affordance in the hotkey cell.
  onStartHotkeyCapture?: () => void
}

// One row of the shared cheat/patch/script grid (see .cheat-table /
// .cheat-row / .cheat-table-head in theme.css for the column template all
// three lists share, so they line up into one continuous table).
export default function CheatRow({ vm }: { vm: CheatRowVM }) {
  const showGhostHotkey = !vm.hotkey && !vm.renaming && !vm.hotkeyCapturing && vm.onStartHotkeyCapture

  return (
    <div className="cheat-row">
      <div className={`row-rail rail-${vm.railState}`} />

      {vm.renaming ? (
        <input
          autoFocus
          className="row-name"
          value={vm.renaming.value}
          onChange={(e) => vm.renaming!.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') vm.renaming!.onCommit()
            if (e.key === 'Escape') vm.renaming!.onCancel()
          }}
          onBlur={() => vm.renaming!.onCommit()}
        />
      ) : (
        <span className="row-name" title={vm.name}>
          {vm.name}
        </span>
      )}

      {vm.hotkeyCapturing ? (
        <span
          className="address-chip"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)', cursor: 'pointer' }}
          title="Press a combo to set it, or click here (or Esc) to cancel"
          onClick={vm.hotkeyCapturing.onCancel}
        >
          {vm.hotkeyCapturing.value ?? 'Press keys…'}
        </span>
      ) : vm.hotkey ? (
        <span className="address-chip">{vm.hotkey}</span>
      ) : showGhostHotkey ? (
        <button className="btn-quiet btn-sm row-reveal" onClick={vm.onStartHotkeyCapture}>
          ⌘ Set
        </button>
      ) : (
        <span />
      )}

      <span className="address-chip truncate" title={vm.targetLabel}>
        {vm.targetLabel}
      </span>

      <span className="row-mode">{vm.mode}</span>

      <span className={`row-status tone-${vm.status.tone}`} title={vm.status.text}>
        {vm.status.text}
      </span>

      <div>{vm.control}</div>

      <RowMenu items={vm.menuItems} />

      {vm.subrow && <div className="row-subrow">{vm.subrow}</div>}
    </div>
  )
}

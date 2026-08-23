import { useState } from 'react'

// A first-class row control for a multiplier cheat — living behind an
// "Edit…" menu item (the original shape both damage's and speed's sliders
// launched with) meant dragging a value required opening a modal every
// time, and scale-mode patches couldn't even reach it (their row menu
// never offered "Edit…" at all — see CheatList's own fix alongside this).
// Drags update the shown label locally and only call onCommit once, on
// release — matching every other live-reapply-on-save path in this app
// (EditCheatModal/EditPatchModal), rather than restoring and reapplying
// the cheat on every intermediate tick while dragging.
export default function MultiplierSlider({
  factor,
  onCommit
}: {
  factor: number
  onCommit: (factor: number) => void
}) {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = dragValue ?? factor

  function commit(value: number) {
    setDragValue(null)
    if (value !== factor) onCommit(value)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={(e) => e.stopPropagation()}>
      <input
        type="range"
        min={1}
        max={20}
        step={0.5}
        value={shown}
        onChange={(e) => setDragValue(Number(e.target.value))}
        onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        style={{ width: 90 }}
      />
      <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right', fontSize: 12 }}>
        {shown.toFixed(1)}x
      </span>
    </div>
  )
}

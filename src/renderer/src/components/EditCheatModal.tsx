import type { CheatDefinition, CheatMode, CheatTarget, DataType } from '../../../main/store'

// Local guards mirroring CheatList.tsx's own (see that file's comment on
// why these are re-declared locally rather than imported as values from
// store.ts — same node:fs-in-renderer boundary reasoning applies here).
function isAnchor(target: CheatTarget): target is Extract<CheatTarget, { kind: 'anchor' }> {
  return (target as { kind?: string }).kind === 'anchor'
}
function isMono(target: CheatTarget): target is Extract<CheatTarget, { kind: 'mono' }> {
  return (target as { kind?: string }).kind === 'mono'
}

const HEX_RE = /^0x[0-9a-fA-F]+$/

// A target is well-formed enough to save: chain targets need a module name
// and valid hex for baseOffset/every offset; mono targets need both names;
// anchor targets (read-only here — see the anchor branch in TargetEditor
// below) are always valid, since nothing about them is editable in this
// modal.
function targetIsValid(target: CheatTarget): boolean {
  if (isAnchor(target)) return true
  if (isMono(target)) return target.className.trim() !== '' && target.staticFieldName.trim() !== ''
  return (
    target.moduleName.trim() !== '' &&
    HEX_RE.test(target.baseOffset) &&
    target.offsets.every((o) => HEX_RE.test(o))
  )
}

function TargetEditor({
  target,
  onChange,
  onRemove,
  removable
}: {
  target: CheatTarget
  onChange: (next: CheatTarget) => void
  onRemove: () => void
  removable: boolean
}) {
  if (isAnchor(target)) {
    return (
      <div className="target-card">
        <div className="target-card-head">
          <span className="eyebrow">Anchor target (from a capture patch)</span>
          <button className="btn-icon" onClick={onRemove} disabled={!removable} aria-label="Remove target">
            ✕
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Reached through <code>{target.patchId}</code> + <code>{target.offset}</code> — not editable
          here. Re-capture it from Scanner's "Find what writes this" if it needs to point somewhere
          else.
        </p>
      </div>
    )
  }

  if (isMono(target)) {
    return (
      <div className="target-card">
        <div className="target-card-head">
          <span className="eyebrow">Mono target</span>
          <button className="btn-icon" onClick={onRemove} disabled={!removable} aria-label="Remove target">
            ✕
          </button>
        </div>
        <div className="field-row">
          <label>Class</label>
          <input
            value={target.className}
            onChange={(e) => onChange({ ...target, className: e.target.value })}
            placeholder="e.g. Player"
          />
        </div>
        <div className="field-row">
          <label>Static field</label>
          <input
            value={target.staticFieldName}
            onChange={(e) => onChange({ ...target, staticFieldName: e.target.value })}
            placeholder="e.g. m_localPlayer"
          />
        </div>
        <div className="field-row">
          <label>Instance field</label>
          <input
            value={target.instanceFieldName ?? ''}
            onChange={(e) =>
              onChange({ ...target, instanceFieldName: e.target.value || undefined })
            }
            placeholder="optional, e.g. m_baseHP"
          />
        </div>
        <div className="field-row">
          <label>Instance field's class</label>
          <input
            value={target.instanceClassName ?? ''}
            onChange={(e) =>
              onChange({ ...target, instanceClassName: e.target.value || undefined })
            }
            placeholder={`optional — only if the instance field is inherited from a base class (e.g. "Character" for a Player target's m_runSpeed)`}
          />
        </div>
      </div>
    )
  }

  // Plain module+offsets chain.
  return (
    <div className="target-card">
      <div className="target-card-head">
        <span className="eyebrow">Chain target</span>
        <button className="btn-icon" onClick={onRemove} disabled={!removable} aria-label="Remove target">
          ✕
        </button>
      </div>
      <div className="field-row">
        <label>Module</label>
        <input
          value={target.moduleName}
          onChange={(e) => onChange({ ...target, moduleName: e.target.value })}
          placeholder="e.g. valheim.exe"
        />
      </div>
      <div className="field-row">
        <label>Base offset</label>
        <input
          value={target.baseOffset}
          onChange={(e) => onChange({ ...target, baseOffset: e.target.value })}
          placeholder="0x..."
        />
      </div>
      {target.offsets.map((offset, i) => (
        <div className="field-row" key={i}>
          <label>Offset {i + 1}</label>
          <input
            value={offset}
            onChange={(e) => {
              const next = target.offsets.slice()
              next[i] = e.target.value
              onChange({ ...target, offsets: next })
            }}
            placeholder="0x..."
          />
          <button
            className="btn-icon"
            onClick={() => onChange({ ...target, offsets: target.offsets.filter((_, idx) => idx !== i) })}
            aria-label="Remove offset"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn-sm"
        onClick={() => onChange({ ...target, offsets: [...target.offsets, '0x0'] })}
      >
        + Add offset level
      </button>
    </div>
  )
}

export default function EditCheatModal({
  cheat,
  onChange,
  onSave,
  onClose
}: {
  cheat: CheatDefinition
  onChange: (next: CheatDefinition) => void
  onSave: () => void
  onClose: () => void
}) {
  const targets = cheat.targets
  const factor = cheat.multiplierBaseline !== undefined ? cheat.value / cheat.multiplierBaseline : null
  // Same reasoning as EditPatchModal's scaleInSliderRange: a value tuned
  // past the slider's own 1x-20x range is legitimate (an "instant" cheat
  // wanting something far bigger), so it isn't rejected here — just shown
  // as a plain number instead of a slider that would misrepresent it.
  const factorInSliderRange = factor !== null && factor >= 1 && factor <= 20
  const valid = Number.isFinite(cheat.value) && targets.length > 0 && targets.every(targetIsValid)

  function updateTarget(i: number, next: CheatTarget) {
    const copy = targets.slice()
    copy[i] = next
    onChange({ ...cheat, targets: copy })
  }

  function removeTarget(i: number) {
    onChange({ ...cheat, targets: targets.filter((_, idx) => idx !== i) })
  }

  function addChainTarget() {
    onChange({
      ...cheat,
      targets: [...targets, { moduleName: '', baseOffset: '0x0', offsets: [] }]
    })
  }

  function addMonoTarget() {
    onChange({
      ...cheat,
      targets: [...targets, { kind: 'mono', className: '', staticFieldName: '' }]
    })
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      if (valid) onSave()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal compact" onKeyDown={onKeyDown} role="dialog" aria-modal="true">
        <div className="modal-head">
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>
            Edit "{cheat.name}"
          </span>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <label>Data type</label>
            <select
              value={cheat.dataType}
              onChange={(e) => onChange({ ...cheat, dataType: e.target.value as DataType })}
            >
              <option value="int8">int8</option>
              <option value="int16">int16</option>
              <option value="int32">int32</option>
              <option value="int64">int64</option>
              <option value="float">float</option>
              <option value="double">double</option>
            </select>
          </div>
          <div className="field-row">
            <label>Mode</label>
            <select
              value={cheat.mode}
              onChange={(e) => onChange({ ...cheat, mode: e.target.value as CheatMode })}
            >
              <option value="freeze">Freeze (continuous)</option>
              <option value="oneshot">One-shot</option>
            </select>
          </div>
          {cheat.multiplierBaseline !== undefined ? (
            <div className="field-row">
              <label>Multiplier</label>
              {factorInSliderRange ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={0.5}
                    value={cheat.value / cheat.multiplierBaseline}
                    onChange={(e) =>
                      onChange({ ...cheat, value: Number(e.target.value) * (cheat.multiplierBaseline as number) })
                    }
                    style={{ flex: 1 }}
                  />
                  <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
                    {(cheat.value / cheat.multiplierBaseline).toFixed(1)}x
                  </span>
                </div>
              ) : (
                <input
                  value={String(cheat.value)}
                  onChange={(e) => onChange({ ...cheat, value: Number(e.target.value) })}
                  placeholder="a value past the 1x-20x slider range"
                />
              )}
            </div>
          ) : (
            <div className="field-row">
              <label>Value</label>
              <input
                value={String(cheat.value)}
                onChange={(e) => onChange({ ...cheat, value: Number(e.target.value) })}
              />
            </div>
          )}

          <div className="section-head">
            <h3>Targets</h3>
          </div>
          {targets.map((target, i) => (
            <TargetEditor
              key={i}
              target={target}
              onChange={(next) => updateTarget(i, next)}
              onRemove={() => removeTarget(i)}
              removable={targets.length > 1}
            />
          ))}
          <div className="field-row">
            <button className="btn-sm" onClick={addChainTarget}>
              + Chain target
            </button>
            <button className="btn-sm" onClick={addMonoTarget}>
              + Mono target
            </button>
          </div>
          {targets.length === 0 && (
            <p style={{ color: 'var(--error)', margin: 0, fontSize: 12 }}>
              A cheat needs at least one target.
            </p>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onSave} disabled={!valid}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

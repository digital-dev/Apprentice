import type { DataType, PatchCheat } from '../../../main/store'

// Deliberately narrow: unlike EditCheatModal, this does NOT expose
// originalBytes/length/signature/baseRegister/armValue — those are the
// captured instruction's own identity, produced by Scanner's find-what-
// writes capture, not something to hand-edit. Editing them wrong doesn't
// just fail to save; the wrong length/signature can NOP the wrong bytes
// the next time this patch installs. Only value/dataType — the fields
// someone actually retunes after capturing (e.g. "cap durability at 9999
// instead of 4000") — are editable here.
export default function EditPatchModal({
  patch,
  onChange,
  onSave,
  onClose
}: {
  patch: PatchCheat
  onChange: (next: PatchCheat) => void
  onSave: () => void
  onClose: () => void
}) {
  const value = patch.value ?? 0
  const dataType = patch.dataType ?? 'int32'
  // Force mode encodes the value as a 32-bit immediate (cave_ops.cc's
  // encodeStore) — same constraint Scanner's own patch-mode select
  // enforces at creation time (see its "Force mode can only set whole
  // numbers (4 bytes) or floats" comment).
  const forceModeWidthOk = dataType === 'int32' || dataType === 'float'
  const valid = Number.isFinite(value) && (patch.mode !== 'force' || forceModeWidthOk)

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
            Edit "{patch.name}"
          </span>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <label>Value</label>
            <input value={String(value)} onChange={(e) => onChange({ ...patch, value: Number(e.target.value) })} />
          </div>
          <div className="field-row">
            <label>Data type</label>
            <select
              value={dataType}
              onChange={(e) => onChange({ ...patch, dataType: e.target.value as DataType })}
            >
              <option value="int32">int32</option>
              <option value="float">float</option>
              {patch.mode !== 'force' && (
                <>
                  <option value="int8">int8</option>
                  <option value="int16">int16</option>
                  <option value="int64">int64</option>
                  <option value="double">double</option>
                </>
              )}
            </select>
          </div>
          {patch.mode === 'force' && !forceModeWidthOk && (
            <p style={{ color: 'var(--error)', margin: 0, fontSize: 12 }}>
              Force mode can only set whole numbers (4 bytes) or floats.
            </p>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            The captured instruction itself (bytes, signature, module anchor) isn't editable here —
            re-capture from Scanner if this patch needs to target different code.
          </p>
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

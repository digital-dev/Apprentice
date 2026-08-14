import { useState } from 'react'
import type { ScriptCheat } from '../../../main/store'

type Tab = 'enable' | 'disable'

// Full-height modal editor for a script's enable/disable Lua, replacing the
// old inline pair of small textareas stacked at the bottom of the cheat
// list. A styled <textarea> for now (Phase 2) — CodeMirror 6 is a later,
// separately-approved swap (Phase 3) behind this same component boundary.
export default function ScriptEditor({
  script,
  onChange,
  onSave,
  onClose,
  onRun,
  output,
  error
}: {
  script: ScriptCheat
  onChange: (next: ScriptCheat) => void
  onSave: () => void
  onClose: () => void
  onRun: (source: string) => void
  output: string[] | null
  error: string | null
}) {
  const [tab, setTab] = useState<Tab>('enable')
  const activeSource = tab === 'enable' ? script.enableScript : script.disableScript

  function setActiveSource(value: string) {
    onChange(tab === 'enable' ? { ...script, enableScript: value } : { ...script, disableScript: value })
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      onSave()
    }
  }

  const hasOutput = (output && output.length > 0) || !!error

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onKeyDown={onKeyDown} role="dialog" aria-modal="true">
        <div className="modal-head">
          <input
            autoFocus
            value={script.name}
            onChange={(e) => onChange({ ...script, name: e.target.value })}
          />
          {script.hotkey && <span className="address-chip">{script.hotkey}</span>}
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabbar">
          <button className={`tab${tab === 'enable' ? ' active' : ''}`} onClick={() => setTab('enable')}>
            Enable script
          </button>
          <button className={`tab${tab === 'disable' ? ' active' : ''}`} onClick={() => setTab('disable')}>
            Disable script
          </button>
        </div>

        <div className="editor-shell">
          <textarea
            value={activeSource}
            onChange={(e) => setActiveSource(e.target.value)}
            spellCheck={false}
          />
        </div>

        {hasOutput && (
          <details className="output-drawer" open>
            <summary>Output {error ? '(error)' : output ? `(${output.length})` : ''}</summary>
            {error && <pre style={{ color: 'var(--error)', margin: '6px 0 0' }}>{error}</pre>}
            {output && output.length > 0 && <pre style={{ margin: '6px 0 0' }}>{output.join('\n')}</pre>}
          </details>
        )}

        <div className="modal-foot">
          <button className="btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button onClick={() => onRun(activeSource)}>
            {tab === 'enable' ? 'Run enable now' : 'Run disable now'}
          </button>
          <button className="btn-primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

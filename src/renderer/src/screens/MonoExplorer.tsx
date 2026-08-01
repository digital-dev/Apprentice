import { useState } from 'react'

interface Props {
  onUseAsValueTarget: (className: string, fieldName: string) => void
  onUseAsPatchAnchor: (className: string, methodName: string) => void
  onDone: () => void
}

// Search-by-exact-name today, not a live browsable tree — a full class
// listing needs per-assembly image walking not yet wired (see ipc.ts's
// mono:listClasses). Typing the class name you already know (from a
// reference like a Cheat Engine table) resolves it and shows its fields
// and methods, which covers this sub-project's proven use case exactly.
export default function MonoExplorer({ onUseAsValueTarget, onUseAsPatchAnchor, onDone }: Props) {
  const [namespaceName, setNamespaceName] = useState('')
  const [className, setClassName] = useState('')
  const [classHandle, setClassHandle] = useState<string | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [methods, setMethods] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [fieldFilter, setFieldFilter] = useState('')
  const [methodFilter, setMethodFilter] = useState('')

  async function resolve() {
    setError(null)
    setResolving(true)
    try {
      const handle = await window.tamper.monoResolveClass(namespaceName, className)
      if (handle === null) {
        setError(
          `Could not resolve ${namespaceName ? namespaceName + '.' : ''}${className} — is the runtime attached and this class loaded yet?`
        )
        setClassHandle(null)
        setFields([])
        setMethods([])
        return
      }
      setClassHandle(handle)
      setFields((await window.tamper.monoListFields(handle)).sort((a, b) => a.localeCompare(b)))
      setMethods((await window.tamper.monoListMethods(handle)).sort((a, b) => a.localeCompare(b)))
      setFieldFilter('')
      setMethodFilter('')
    } finally {
      setResolving(false)
    }
  }

  const visibleFields = fields.filter((f) => f.toLowerCase().includes(fieldFilter.toLowerCase()))
  const visibleMethods = methods.filter((m) => m.toLowerCase().includes(methodFilter.toLowerCase()))

  return (
    <div>
      <h2>Mono Explorer</h2>
      <div style={{ marginBottom: 12 }}>
        <button onClick={onDone}>← Cheat list</button>
      </div>
      <p className="muted">
        Search by the exact class name (e.g. copied from a Cheat Engine table) — this does not
        browse a live class tree.
      </p>
      <input
        placeholder="Namespace (often blank)"
        value={namespaceName}
        onChange={(e) => setNamespaceName(e.target.value)}
      />
      <input
        placeholder="Class name, e.g. Player"
        value={className}
        onChange={(e) => setClassName(e.target.value)}
      />
      <button onClick={resolve} disabled={!className || resolving}>
        {resolving ? 'Resolving…' : 'Resolve'}
      </button>
      {error && <p style={{ color: 'var(--error)' }}>{error}</p>}
      {classHandle && (
        <>
          <h3>Fields ({visibleFields.length}/{fields.length})</h3>
          <input
            placeholder="Filter fields…"
            value={fieldFilter}
            onChange={(e) => setFieldFilter(e.target.value)}
          />
          <ul>
            {visibleFields.map((f, i) => (
              <li key={`${f}-${i}`}>
                {f}
                <button onClick={() => onUseAsValueTarget(className, f)}>Use as value target</button>
              </li>
            ))}
            {fields.length === 0 && <li className="muted">No fields found.</li>}
            {fields.length > 0 && visibleFields.length === 0 && (
              <li className="muted">No fields match &quot;{fieldFilter}&quot;.</li>
            )}
          </ul>
          <h3>Methods ({visibleMethods.length}/{methods.length})</h3>
          <input
            placeholder="Filter methods…"
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
          />
          <ul>
            {visibleMethods.map((m, i) => (
              // Mono only gives us the method name, not its overload
              // signature — Player.IsPlayerInRange appears multiple times
              // for real, so `m` alone isn't a unique key. Without the
              // index, duplicate keys break React's reconciliation when
              // the filtered list shrinks, leaving stale rows on screen.
              <li key={`${m}-${i}`}>
                {m}
                <button onClick={() => onUseAsPatchAnchor(className, m)}>Use as patch anchor</button>
              </li>
            ))}
            {methods.length === 0 && <li className="muted">No methods found.</li>}
            {methods.length > 0 && visibleMethods.length === 0 && (
              <li className="muted">No methods match &quot;{methodFilter}&quot;.</li>
            )}
          </ul>
        </>
      )}
    </div>
  )
}

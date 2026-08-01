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
      setFields(await window.tamper.monoListFields(handle))
      setMethods(await window.tamper.monoListMethods(handle))
    } finally {
      setResolving(false)
    }
  }

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
          <h3>Fields</h3>
          <ul>
            {fields.map((f) => (
              <li key={f}>
                {f}
                <button onClick={() => onUseAsValueTarget(className, f)}>Use as value target</button>
              </li>
            ))}
            {fields.length === 0 && <li className="muted">No fields found.</li>}
          </ul>
          <h3>Methods</h3>
          <ul>
            {methods.map((m) => (
              <li key={m}>
                {m}
                <button onClick={() => onUseAsPatchAnchor(className, m)}>Use as patch anchor</button>
              </li>
            ))}
            {methods.length === 0 && <li className="muted">No methods found.</li>}
          </ul>
        </>
      )}
    </div>
  )
}

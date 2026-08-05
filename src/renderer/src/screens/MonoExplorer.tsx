import { useState } from 'react'

interface Props {
  onUseAsValueTarget: (className: string, fieldName: string) => void
  onUseAsPatchAnchor: (className: string, methodName: string) => void
  onDone: () => void
}

// Two ways to get to a class: type the exact name you already know (from a
// reference like a Cheat Engine table), or browse — pick an assembly, then
// pick a class from its own metadata table, no typing/guessing required.
// Browsing is scoped to ONE assembly at a time deliberately: a real game
// can have 100+ assemblies and thousands of types combined, so a single
// merged list would be enormous and slow to build; picking the assembly
// first keeps each list a manageable size.
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

  const [assemblies, setAssemblies] = useState<{ image: string; name: string }[]>([])
  const [assemblyFilter, setAssemblyFilter] = useState('')
  const [loadingAssemblies, setLoadingAssemblies] = useState(false)
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const [classes, setClasses] = useState<{ namespaceName: string; className: string }[]>([])
  const [classFilter, setClassFilter] = useState('')
  const [loadingClasses, setLoadingClasses] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)

  async function resolve(ns: string, cls: string) {
    setError(null)
    setResolving(true)
    try {
      const handle = await window.tamper.monoResolveClass(ns, cls)
      if (handle === null) {
        setError(
          `Could not resolve ${ns ? ns + '.' : ''}${cls} — is the runtime attached and this class loaded yet?`
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

  async function loadAssemblies() {
    setBrowseError(null)
    setLoadingAssemblies(true)
    try {
      const result = await window.tamper.monoListAssemblyNames()
      if (result.length === 0) {
        setBrowseError('No assemblies found — is the runtime attached?')
      }
      setAssemblies([...result].sort((a, b) => a.name.localeCompare(b.name)))
      setSelectedImage(null)
      setClasses([])
    } finally {
      setLoadingAssemblies(false)
    }
  }

  async function pickAssembly(imageHandle: string) {
    setSelectedImage(imageHandle)
    setClassFilter('')
    setBrowseError(null)
    setLoadingClasses(true)
    try {
      const result = await window.tamper.monoListClassesInImage(imageHandle)
      setClasses([...result].sort((a, b) => a.className.localeCompare(b.className)))
    } finally {
      setLoadingClasses(false)
    }
  }

  function pickClass(ns: string, cls: string) {
    setNamespaceName(ns)
    setClassName(cls)
    void resolve(ns, cls)
  }

  const visibleFields = fields.filter((f) => f.toLowerCase().includes(fieldFilter.toLowerCase()))
  const visibleMethods = methods.filter((m) => m.toLowerCase().includes(methodFilter.toLowerCase()))
  const visibleAssemblies = assemblies.filter((a) =>
    a.name.toLowerCase().includes(assemblyFilter.toLowerCase())
  )
  const visibleClasses = classes.filter((c) => c.className.toLowerCase().includes(classFilter.toLowerCase()))

  return (
    <div>
      <h2>Mono Explorer</h2>
      <div style={{ marginBottom: 12 }}>
        <button onClick={onDone}>← Cheat list</button>
      </div>

      <h3>Browse</h3>
      <button onClick={loadAssemblies} disabled={loadingAssemblies}>
        {loadingAssemblies ? 'Loading…' : 'Load assemblies'}
      </button>
      {browseError && <p style={{ color: 'var(--error)' }}>{browseError}</p>}
      {assemblies.length > 0 && (
        <>
          <input
            placeholder="Filter assemblies…"
            value={assemblyFilter}
            onChange={(e) => setAssemblyFilter(e.target.value)}
          />
          <ul style={{ maxHeight: 160, overflowY: 'auto' }}>
            {visibleAssemblies.map((a) => (
              <li key={a.image}>
                <button
                  onClick={() => pickAssembly(a.image)}
                  style={a.image === selectedImage ? { fontWeight: 'bold' } : undefined}
                >
                  {a.name}
                </button>
              </li>
            ))}
            {visibleAssemblies.length === 0 && (
              <li className="muted">No assemblies match &quot;{assemblyFilter}&quot;.</li>
            )}
          </ul>
        </>
      )}
      {loadingClasses && <p className="muted">Loading classes…</p>}
      {selectedImage && !loadingClasses && (
        <>
          <input
            placeholder="Filter classes…"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
          />
          <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
            {visibleClasses.map((c) => (
              <li key={`${c.namespaceName}.${c.className}`}>
                <button onClick={() => pickClass(c.namespaceName, c.className)}>
                  {c.namespaceName ? `${c.namespaceName}.${c.className}` : c.className}
                </button>
              </li>
            ))}
            {classes.length === 0 && <li className="muted">No classes found in this assembly.</li>}
            {classes.length > 0 && visibleClasses.length === 0 && (
              <li className="muted">No classes match &quot;{classFilter}&quot;.</li>
            )}
          </ul>
        </>
      )}

      <h3>Or type it directly</h3>
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
      <button onClick={() => resolve(namespaceName, className)} disabled={!className || resolving}>
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

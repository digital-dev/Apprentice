import { useEffect, useState } from 'react'

interface ProcessInfo {
  pid: number
  name: string
}

export default function ProcessPicker({
  onAttached
}: {
  onAttached: (exeName: string) => void
}) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.tamper.listProcesses().then(setProcesses)
  }, [])

  async function pick(p: ProcessInfo) {
    setError(null)
    try {
      await window.tamper.attach(p.pid)
      onAttached(p.name)
    } catch {
      setError(`Could not attach to ${p.name}. It may have closed, or access was denied.`)
    }
  }

  const filtered = processes.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div>
      <h2>Select a process</h2>
      <input
        placeholder="Search running processes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p style={{ color: 'var(--error)' }}>{error}</p>}
      <ul>
        {filtered.map((p) => (
          <li key={p.pid} onClick={() => pick(p)}>
            {p.name} ({p.pid})
          </li>
        ))}
      </ul>
    </div>
  )
}

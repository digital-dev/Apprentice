import { useEffect, useState } from 'react'

interface ProcessInfo {
  pid: number
  name: string
}

// Windows session/security infrastructure that is never a game and whose
// attach can range from useless to destabilizing (csrss/wininit/winlogon
// crash the session; services/lsass hold access tokens the OS is fussy
// about). Hiding them keeps the picker to processes worth attaching to.
const HIDDEN_PROCESSES = new Set([
  'system',
  'system idle process',
  'registry',
  'memcompression',
  'csrss.exe',
  'smss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'lsaiso.exe',
  'svchost.exe',
  'dwm.exe',
  'fontdrvhost.exe',
  'sihost.exe',
  'taskhostw.exe',
  'wudfhost.exe'
])

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

  const filtered = processes.filter(
    (p) =>
      !HIDDEN_PROCESSES.has(p.name.toLowerCase()) &&
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

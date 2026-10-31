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
  'wudfhost.exe',
  // Wine/Proton's own plumbing under Linux: these run the Windows-process
  // emulation itself (wineserver, the preloader, Wine's stand-ins for
  // Windows' own session services above, and Proton's sandboxing wrapper),
  // never the game.
  'wineserver',
  'wine64-preloader',
  'winedevice.exe',
  'explorer.exe',
  'plugplay.exe',
  'rpcss.exe',
  'conhost.exe',
  'steam.exe',
  'pressure-vessel*' // prefix: Proton's container runtime spawns pressure-vessel-wrap, -launcher, etc.
])

// A trailing '*' in HIDDEN_PROCESSES marks a prefix match (there is no other
// wildcard use), since Proton's pressure-vessel tooling runs under several
// different exact names rather than one.
function isHiddenProcess(name: string): boolean {
  const n = name.toLowerCase()
  if (HIDDEN_PROCESSES.has(n)) return true
  for (const entry of HIDDEN_PROCESSES) {
    if (entry.endsWith('*') && n.startsWith(entry.slice(0, -1))) return true
  }
  return false
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

  const filtered = processes.filter(
    (p) => !isHiddenProcess(p.name) && p.name.toLowerCase().includes(query.toLowerCase())
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

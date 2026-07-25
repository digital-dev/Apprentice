import { useState } from 'react'
import type { CheatDefinition, ChainTarget, CheatMode, DataType } from '../../../main/store'
import type { Candidate } from '../tamper.d'

type Filter = 'exact' | 'changed' | 'unchanged' | 'increased' | 'decreased'
type ResolveStatus = 'resolving' | 'resolved' | 'no-chain'

export default function Scanner({
  exeName,
  onSaved
}: {
  exeName: string
  onSaved: () => void
}) {
  const [dataType, setDataType] = useState<DataType>('float')
  const [value, setValue] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  // Naive memory scanning sometimes finds a chain that only looks static
  // and stops resolving after a few seconds even though other candidates
  // from the same scan keep working. Letting the user select several
  // candidates and bundling their resolved chains into one cheat (written
  // to every target on each tick, broken only if ALL of them fail) makes a
  // saved cheat resilient to any single chain going stale.
  const [selectedAddresses, setSelectedAddresses] = useState<Set<string>>(new Set())
  const [targets, setTargets] = useState<Map<string, ChainTarget>>(new Map())
  const [resolveStatus, setResolveStatus] = useState<Map<string, ResolveStatus>>(new Map())
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CheatMode>('freeze')
  // scanFirst/resolveChain run on a background thread in the native addon
  // and can take a few seconds against a real game's memory, so the UI
  // shows progress instead of looking frozen while awaiting them.
  const [scanning, setScanning] = useState(false)
  const [resolvingAll, setResolvingAll] = useState(false)

  async function firstScan() {
    setScanning(true)
    try {
      const found = await window.tamper.scanFirst(dataType, Number(value))
      setCandidates(found)
      setSelectedAddresses(new Set())
      setTargets(new Map())
      setResolveStatus(new Map())
    } finally {
      setScanning(false)
    }
  }

  // Relative filters (changed/increased/...) compare each candidate against
  // its OWN previously-recorded value (carried alongside its address), not
  // a single value typed into the UI — candidates can have diverged from
  // each other since the last scan, so a single broadcast "previous" would
  // be wrong for any candidate beyond the first post-first-scan step.
  async function nextScan(filter: Filter) {
    const filterPayload =
      filter === 'exact' ? { mode: 'exact' as const, value: Number(value) } : { mode: filter }
    const found = await window.tamper.scanNext(candidates, dataType, filterPayload)
    setCandidates(found)
  }

  function toggleSelected(address: string) {
    setSelectedAddresses((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })
  }

  async function resolveSelected() {
    setResolvingAll(true)
    const addresses = Array.from(selectedAddresses)
    setResolveStatus((prev) => {
      const next = new Map(prev)
      for (const address of addresses) next.set(address, 'resolving')
      return next
    })
    try {
      await Promise.all(
        addresses.map(async (address) => {
          const result = await window.tamper.resolveChain(address, 5)
          setResolveStatus((prev) => new Map(prev).set(address, result ? 'resolved' : 'no-chain'))
          if (result) {
            setTargets((prev) =>
              new Map(prev).set(address, {
                moduleName: result.moduleName,
                baseOffset: result.offsets[0],
                offsets: result.offsets.slice(1)
              })
            )
          }
        })
      )
    } finally {
      setResolvingAll(false)
    }
  }

  async function save() {
    if (targets.size === 0) return
    const cheat: CheatDefinition = {
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      dataType,
      mode,
      targets: Array.from(targets.values()),
      value: Number(value)
    }
    await window.tamper.saveCheat(exeName, cheat)
    onSaved()
  }

  return (
    <div>
      <h2>Scan for a new cheat — {exeName}</h2>

      <select
        value={dataType}
        onChange={(e) => setDataType(e.target.value as DataType)}
        disabled={candidates.length > 0}
      >
        <option value="float">Float (most common — health, stamina, position)</option>
        <option value="int32">Whole number (gold, item count)</option>
      </select>
      <input
        placeholder="Current value in-game"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button onClick={firstScan} disabled={scanning}>
        {scanning ? 'Scanning…' : 'First Scan'}
      </button>
      {scanning && <p>Scanning game memory — this can take a few seconds…</p>}

      {candidates.length > 0 && (
        <>
          <p>{candidates.length} candidate(s)</p>
          <input
            placeholder="New value after changing it in-game"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button onClick={() => nextScan('exact')}>Exact value</button>
          <button onClick={() => nextScan('increased')}>Increased</button>
          <button onClick={() => nextScan('decreased')}>Decreased</button>
          <button onClick={() => nextScan('changed')}>Changed</button>
          <button onClick={() => nextScan('unchanged')}>Unchanged</button>
        </>
      )}

      {candidates.length > 0 && candidates.length <= 20 && (
        <>
          <ul>
            {candidates.map((c) => {
              const status = resolveStatus.get(c.address)
              return (
                <li key={c.address}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedAddresses.has(c.address)}
                      onChange={() => toggleSelected(c.address)}
                    />
                    {' '}
                    {c.address} = {c.value}{' '}
                    {status === 'resolving' && 'resolving…'}
                    {status === 'resolved' && '✓ chain resolved'}
                    {status === 'no-chain' && '— no static chain found'}
                  </label>
                </li>
              )
            })}
          </ul>
          <button
            onClick={resolveSelected}
            disabled={selectedAddresses.size === 0 || resolvingAll}
          >
            {resolvingAll
              ? 'Resolving…'
              : `Resolve ${selectedAddresses.size || ''} Selected`.trim()}
          </button>
        </>
      )}

      {targets.size > 0 && (
        <div>
          <p>{targets.size} of {selectedAddresses.size} selected candidate(s) resolved to a static chain — the cheat will write to all of them, and stay working as long as any one keeps resolving.</p>
          <input placeholder="Cheat name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={mode} onChange={(e) => setMode(e.target.value as CheatMode)}>
            <option value="freeze">Freeze (continuous)</option>
            <option value="oneshot">One-shot</option>
          </select>
          <button onClick={save} disabled={!name}>Save as Cheat</button>
        </div>
      )}
    </div>
  )
}

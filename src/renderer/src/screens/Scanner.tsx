import { useState } from 'react'
import type { CheatDefinition, CheatMode, DataType } from '../../../main/store'
import type { Candidate } from '../tamper.d'

type Filter = 'exact' | 'changed' | 'unchanged' | 'increased' | 'decreased'

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
  const [selected, setSelected] = useState<string | null>(null)
  const [chain, setChain] = useState<{ moduleName: string; offsets: string[] } | null>(null)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CheatMode>('freeze')

  async function firstScan() {
    const found = await window.tamper.scanFirst(dataType, Number(value))
    setCandidates(found)
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

  async function resolve(address: string) {
    setSelected(address)
    const result = await window.tamper.resolveChain(address, 5)
    setChain(result)
  }

  async function save() {
    if (!chain) return
    const cheat: CheatDefinition = {
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      dataType,
      mode,
      moduleName: chain.moduleName,
      baseOffset: chain.offsets[0],
      offsets: chain.offsets.slice(1),
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
      <button onClick={firstScan}>First Scan</button>

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
        <ul>
          {candidates.map((c) => (
            <li key={c.address} onClick={() => resolve(c.address)}>
              {c.address} = {c.value}{' '}
              {selected === c.address && chain && '✓ chain resolved'}
              {selected === c.address && chain === null && '— no static chain found'}
            </li>
          ))}
        </ul>
      )}

      {chain && (
        <div>
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

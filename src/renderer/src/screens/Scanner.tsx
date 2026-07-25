import { useState } from 'react'
import type { CheatDefinition, CheatMode, DataType } from '../../../main/store'

type Filter = 'exact' | 'changed' | 'unchanged' | 'increased' | 'decreased'

export default function Scanner({
  exeName,
  onSaved
}: {
  exeName: string
  onSaved: () => void
}) {
  const [dataType] = useState<DataType>('int32')
  const [value, setValue] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [previousValue, setPreviousValue] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [chain, setChain] = useState<{ moduleName: string; offsets: string[] } | null>(null)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CheatMode>('freeze')

  async function firstScan() {
    const found = await window.tamper.scanFirst(dataType, Number(value))
    setCandidates(found)
    setPreviousValue(Number(value))
  }

  async function nextScan(filter: Filter) {
    const filterPayload =
      filter === 'exact'
        ? { mode: 'exact' as const, value: Number(value) }
        : { mode: filter, previous: candidates.map(() => previousValue ?? 0) }
    const found = await window.tamper.scanNext(candidates, dataType, filterPayload)
    setCandidates(found)
    setPreviousValue(Number(value))
  }

  async function resolve(address: string) {
    setSelected(address)
    const result = await window.tamper.resolveChain(address, 3)
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
          {candidates.map((addr) => (
            <li key={addr} onClick={() => resolve(addr)}>
              {addr} {selected === addr && chain && '✓ chain resolved'}
              {selected === addr && chain === null && '— no static chain found'}
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

import { useEffect, useState } from 'react'
import type { CheatDefinition, ChainTarget, CheatMode, DataType } from '../../../main/store'
import type { Candidate, CaughtInstruction } from '../tamper.d'

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
  // Find-what-writes capture: arm a watch on a candidate address, poll for
  // instructions the game executes that write to it, and let the user turn
  // one of the caught instructions into a rooted pointer-chain cheat.
  const [watchAddress, setWatchAddress] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const [caught, setCaught] = useState<CaughtInstruction[]>([])
  const [captureName, setCaptureName] = useState('')
  const [captureError, setCaptureError] = useState<string | null>(null)

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

  async function startWatch(address: string) {
    setWatchAddress(address)
    setCaught([])
    setWatching(true)
    await window.tamper.startWriteWatch(address)
  }

  useEffect(() => {
    if (!watching) return
    const id = setInterval(async () => {
      setCaught(await window.tamper.pollWriteWatch())
    }, 250)
    return () => clearInterval(id)
  }, [watching])

  async function stopWatch() {
    const finalList = await window.tamper.stopWriteWatch()
    setCaught(finalList)
    setWatching(false)
  }

  // Turn a caught instruction into a cheat target: resolve a chain to the
  // object base the game used, then reach the exact field. This is the
  // rooted, high-quality path.
  async function createCheatFromInstruction(insn: CaughtInstruction) {
    if (!captureName) return
    setCaptureError(null)
    const chain = await window.tamper.resolveChain(insn.baseAddress, 5)
    if (!chain) {
      setCaptureError(
        `No static pointer chain found to the object base (${insn.baseAddress}). ` +
          `Try a different caught instruction.`
      )
      return
    }
    // The chain resolves — with its FINAL offset added but NOT dereferenced —
    // to the object base address. The value we want sits at
    // baseAddress + displacement. We must FOLD the displacement into the
    // chain's last offset, NOT append it as a new offset: appending would
    // make the previously-final offset get dereferenced, landing the walk on
    // *(baseAddress) + displacement (garbage) instead of
    // baseAddress + displacement.
    const offsets = chain.offsets.slice()
    const lastIdx = offsets.length - 1
    offsets[lastIdx] =
      '0x' + (BigInt(offsets[lastIdx]) + BigInt(insn.displacement)).toString(16)
    const target: ChainTarget = {
      moduleName: chain.moduleName,
      baseOffset: offsets[0],
      offsets: offsets.slice(1)
    }
    const cheat: CheatDefinition = {
      id: captureName.toLowerCase().replace(/\s+/g, '-'),
      name: captureName,
      dataType,
      mode: 'freeze',
      targets: [target],
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
                  <button onClick={() => startWatch(c.address)}>Find what writes this</button>
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

      {watchAddress && (
        <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
          <h3>Find what writes {watchAddress}</h3>
          {watching ? (
            <>
              <p>Watching — trigger the value change in-game (take damage, use stamina…).</p>
              <button onClick={stopWatch}>Stop</button>
            </>
          ) : (
            <button onClick={() => startWatch(watchAddress)}>Re-arm</button>
          )}
          <p>{caught.length} instruction(s) caught</p>
          <ul>
            {caught.map((insn) => (
              <li key={insn.instructionAddress}>
                <span className="address-chip">
                  {insn.moduleName ?? '?'}+{insn.moduleOffset ?? insn.instructionAddress}
                </span>
                <span>
                  base {insn.baseRegister} + {insn.displacement} → {insn.baseAddress}
                </span>
                <button
                  disabled={!captureName || !insn.baseRegister || insn.baseRegister === 'rip'}
                  onClick={() => createCheatFromInstruction(insn)}
                >
                  Create pointer cheat
                </button>
                {!insn.baseRegister && (
                  <span className="muted"> (can't chain this instruction)</span>
                )}
                <button disabled title="Coming in the AOB update">Create patch</button>
              </li>
            ))}
          </ul>
          {caught.length > 0 && (
            <input
              placeholder="Cheat name"
              value={captureName}
              onChange={(e) => setCaptureName(e.target.value)}
            />
          )}
          {captureError && <p style={{ color: 'var(--error)' }}>{captureError}</p>}
        </div>
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

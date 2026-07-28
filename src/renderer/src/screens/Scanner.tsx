import { useEffect, useState } from 'react'
import type { CheatDefinition, ChainTarget, CheatMode, DataType, PatchCheat } from '../../../main/store'
import type { Candidate, CaughtInstruction } from '../tamper.d'

type Filter = 'exact' | 'changed' | 'unchanged' | 'increased' | 'decreased'
type ResolveStatus = 'resolving' | 'resolved' | 'no-chain'

export default function Scanner({
  exeName,
  onDone
}: {
  exeName: string
  onDone: () => void
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
  const [patchModeChoice, setPatchModeChoice] = useState<'nop' | 'force' | 'capture'>('nop')
  const [forceValue, setForceValue] = useState('')
  const [captureError, setCaptureError] = useState<string | null>(null)
  // Saving used to navigate straight back to the cheat list, which unmounted
  // this screen and threw away the scan and the caught instructions with it.
  // Finding a working cheat normally means trying several of the caught
  // writers in turn, so saving now leaves everything in place and just says
  // so — the user decides when to leave or clear.
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

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
    setSavedNotice(`Saved "${name}" to your cheat list.`)
  }

  // The native side only accepts a caught instruction whose computed
  // effective address COVERS the address we armed the watch on
  // (write_watch.cc's FindWriteInstruction) — a wide SIMD/struct store's
  // effective address is the start of the block, not the watched field
  // itself. `baseAddress + displacement` is NOT useful for this check: since
  // `displacement` is derived FROM the watched address (see write_watch.cc),
  // that sum equals watchAddress by construction for every row, which is why
  // this used to be dead code. `effectiveAddress`/`accessBytes` carry the
  // actually-decoded destination and width instead, so this asserts the real
  // native invariant — if it ever fails, the instruction we identified is
  // NOT the one that tripped the breakpoint, and NOPping it would corrupt
  // whatever function it belongs to.
  function writesWatchedAddress(insn: CaughtInstruction): boolean {
    if (!watchAddress || !insn.baseRegister) return true // nothing to check against
    try {
      const watched = BigInt(watchAddress)
      const effective = BigInt(insn.effectiveAddress)
      const accessBytes = BigInt(insn.accessBytes)
      return effective <= watched && watched < effective + accessBytes
    } catch {
      return true // unparseable — don't cry wolf on a formatting problem
    }
  }

  // Leaving the scanner ends any capture. An armed capture keeps a debugger
  // attached with hardware breakpoints set on every thread of the game, and
  // if Tamper is killed rather than closed in that state, nothing can take
  // them back down and the game dies. Triggering the value in-game doesn't
  // require leaving this screen, so anyone navigating away is done capturing
  // — narrowing that window is free.
  async function leaveScanner() {
    if (watching) await stopWatch()
    onDone()
  }

  // Throwing away a scan is now an explicit act rather than a side effect of
  // saving. Stops an in-flight capture first, so clearing can't strand the
  // debugger attached to the game.
  async function clearScan() {
    if (watching) await stopWatch()
    setCandidates([])
    setSelectedAddresses(new Set())
    setTargets(new Map())
    setResolveStatus(new Map())
    setWatchAddress(null)
    setCaught([])
    setCaptureName('')
    setCaptureError(null)
    setSavedNotice(null)
    setName('')
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
    setSavedNotice(`Saved pointer cheat "${captureName}" to your cheat list.`)
  }

  // Turn a caught instruction into a code patch. Unlike the pointer-cheat
  // path this needs no chain — only the instruction's own bytes, length,
  // signature and module anchor — so a NOP patch works for rip-relative and
  // otherwise-undecoded writes too. A force patch is the exception: it still
  // needs a base register, to address the field it writes through.
  async function createPatchFromInstruction(insn: CaughtInstruction) {
    if (!captureName) return
    setCaptureError(null)
    const patch: PatchCheat = {
      kind: 'patch',
      mode: patchModeChoice,
      // Prefixed so a patch and a pointer cheat named the same thing never
      // collide on id — saveCheat/deleteCheat key purely off id, so an
      // unprefixed slug shared with createCheatFromInstruction would let one
      // silently overwrite the other.
      id: `patch-${captureName.toLowerCase().replace(/\s+/g, '-')}`,
      name: captureName,
      originalBytes: insn.bytes,
      length: insn.length,
      signature: insn.signature,
      signatureOffset: insn.signatureOffset,
      moduleName: insn.moduleName,
      moduleOffset: insn.moduleOffset,
      ...(patchModeChoice === 'force'
        ? {
            baseRegister: insn.baseRegister,
            fieldOffset: insn.displacement,
            value: Number(forceValue),
            dataType
          }
        : {}),
      ...(patchModeChoice === 'capture' ? { baseRegister: insn.baseRegister } : {})
    }
    await window.tamper.saveCheat(exeName, patch)
    setSavedNotice(
      `Saved patch "${captureName}". Test it in the cheat list, then come back — these instructions are still here.`
    )
  }

  return (
    <div>
      <h2>Scan for a new cheat — {exeName}</h2>

      <div style={{ marginBottom: 12 }}>
        <button onClick={leaveScanner}>← Cheat list</button>
        <button onClick={clearScan} disabled={candidates.length === 0 && caught.length === 0}>
          Clear scan
        </button>
      </div>

      {savedNotice && (
        <p style={{ color: 'var(--active)' }}>
          {savedNotice} <button onClick={leaveScanner}>Go to cheat list</button>
        </p>
      )}

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
          {caught.length > 0 && (
            <div>
              <select
                value={patchModeChoice}
                onChange={(e) =>
                  setPatchModeChoice(e.target.value as 'nop' | 'force' | 'capture')
                }
              >
                <option value="nop">Disable this write</option>
                <option value="force">Force a value</option>
                <option value="capture">Capture this object (for a persistent value cheat)</option>
              </select>
              {patchModeChoice === 'force' && (
                <input
                  placeholder={`Value to force (${dataType})`}
                  value={forceValue}
                  onChange={(e) => setForceValue(e.target.value)}
                />
              )}
            </div>
          )}
          <ul>
            {caught.map((insn) => (
              <li key={insn.instructionAddress}>
                <span className="address-chip">
                  {insn.moduleName ?? '?'}+{insn.moduleOffset ?? insn.instructionAddress}
                </span>
                <span>
                  base {insn.baseRegister} + {insn.displacement} → {insn.baseAddress}
                </span>
                {!writesWatchedAddress(insn) && (
                  <span style={{ color: 'var(--error)' }}>
                    ⚠ writes {insn.effectiveAddress} (+{insn.accessBytes} bytes), not the
                    watched {watchAddress} — don't patch this
                  </span>
                )}
                {insn.indexed && (
                  <span className="muted">
                    {' '}
                    (indexed write — the offset folded a runtime index and may not be stable
                    across runs)
                  </span>
                )}
                <button
                  disabled={!captureName || !insn.baseRegister || insn.baseRegister === 'rip'}
                  onClick={() => createCheatFromInstruction(insn)}
                >
                  Create pointer cheat
                </button>
                {!insn.baseRegister && (
                  <span className="muted"> (can't chain this instruction)</span>
                )}
                <button
                  disabled={
                    !captureName ||
                    insn.length === 0 ||
                    !writesWatchedAddress(insn) ||
                    (patchModeChoice === 'force' &&
                      (forceValue.trim() === '' ||
                        !Number.isFinite(Number(forceValue)) ||
                        !insn.baseRegister)) ||
                    (patchModeChoice === 'capture' && !insn.baseRegister)
                  }
                  title={
                    patchModeChoice === 'force'
                      ? 'Redirect this instruction to force the field to the given value instead'
                      : patchModeChoice === 'capture'
                        ? 'Redirect this instruction to also record the object pointer for a persistent value cheat'
                        : 'Replace this instruction with no-ops so the write never happens'
                  }
                  onClick={() => createPatchFromInstruction(insn)}
                >
                  Create patch
                </button>
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

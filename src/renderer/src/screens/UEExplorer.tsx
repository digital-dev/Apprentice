import { useEffect, useState } from 'react'
import type { UeConfig } from '../tamper.d'

interface Props {
  onUseAsUeTarget: (className: string, fieldName: string) => void
  onDone: () => void
}

const EMPTY_GNAMES: UeConfig['gNames'] = {
  gNamesBase: '',
  blockOffsetBits: 16,
  nameEntryStride: 2,
  stringOffset: 2,
  headerOffset: 0,
  lengthShiftCount: 1
}

const EMPTY_GOBJECT_ARRAY: UeConfig['gObjectArray'] = {
  chunksArrayBase: '',
  numElementsPerChunk: 0x10000,
  itemStride: 0x10,
  itemInitialOffset: 0x0
}

// UE reflection has no cheap "browse everything" the way Mono's per-assembly
// class list does (a real UE5 game can have 100,000+ live UObjects) and
// needs a ten-number calibration config Mono never required (monoDllBase
// alone is enough there) -- see
// docs/superpowers/specs/2026-09-17-ue-explorer-ui-design.md for why this
// screen is resolve-by-exact-name only, not a MonoExplorer.tsx copy.
export default function UEExplorer({ onUseAsUeTarget, onDone }: Props) {
  const [gNames, setGNames] = useState<UeConfig['gNames']>(EMPTY_GNAMES)
  const [gObjectArray, setGObjectArray] = useState<UeConfig['gObjectArray']>(EMPTY_GOBJECT_ARRAY)
  const [hasConfig, setHasConfig] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(true)

  const [className, setClassName] = useState('')
  const [fieldName, setFieldName] = useState('')
  const [maxObjectsToScan, setMaxObjectsToScan] = useState('100000')
  const [classAddress, setClassAddress] = useState<string | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [fieldFilter, setFieldFilter] = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const config = await window.tamper.ueGetConfig()
      if (cancelled) return
      if (config !== null) {
        setGNames(config.gNames)
        setGObjectArray(config.gObjectArray)
        setHasConfig(true)
      }
      setLoadingConfig(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  async function saveConfig() {
    await window.tamper.ueSaveConfig({ gNames, gObjectArray })
    setHasConfig(true)
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

  async function resolve() {
    setError(null)
    setResolving(true)
    setClassAddress(null)
    setFields([])
    try {
      const scanLimit = Number(maxObjectsToScan)
      if (!Number.isFinite(scanLimit) || scanLimit <= 0) {
        setError('maxObjectsToScan must be a positive number.')
        return
      }
      const address = await window.tamper.ueResolveClass(className.trim(), scanLimit)
      if (address === null) {
        setError(
          `Could not resolve "${className}" — is the runtime attached, is UeConfig calibrated, and does this class exist within the first ${scanLimit} scanned objects?`
        )
        return
      }
      setClassAddress(address)
      setFields((await window.tamper.ueListFieldNames(address)).sort((a, b) => a.localeCompare(b)))
      setFieldFilter(fieldName)
    } finally {
      setResolving(false)
    }
  }

  const filteredFields = fields.filter((f) => f.toLowerCase().includes(fieldFilter.toLowerCase()))

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>UE Explorer</h2>
        <button onClick={onDone}>Done</button>
      </div>

      <section className="panel">
        <h3>1. GNames / GUObjectArray config</h3>
        {!hasConfig && !loadingConfig && (
          <p className="muted" style={{ fontSize: 12 }}>
            No config saved for this game yet. These ten numbers are build-specific and can&apos;t be
            auto-discovered — find them once via the manual recipe in{' '}
            <code>docs/superpowers/specs/2026-09-17-ue-reflection-decode-design.md</code> (locate the
            GNames pool via a known string like &quot;/Script/CoreUObject&quot;, calibrate the decode
            formula against entry 0 = &quot;None&quot;, then locate GUObjectArray the same way), then
            fill them in below and Save.
          </p>
        )}
        <div className="field-row">
          <label>GNames base</label>
          <input
            value={gNames.gNamesBase}
            onChange={(e) => setGNames({ ...gNames, gNamesBase: e.target.value })}
            placeholder="0x..."
          />
        </div>
        <div className="field-row">
          <label>Block offset bits</label>
          <input
            type="number"
            value={gNames.blockOffsetBits}
            onChange={(e) => setGNames({ ...gNames, blockOffsetBits: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>Name entry stride</label>
          <input
            type="number"
            value={gNames.nameEntryStride}
            onChange={(e) => setGNames({ ...gNames, nameEntryStride: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>String offset</label>
          <input
            type="number"
            value={gNames.stringOffset}
            onChange={(e) => setGNames({ ...gNames, stringOffset: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>Header offset</label>
          <input
            type="number"
            value={gNames.headerOffset}
            onChange={(e) => setGNames({ ...gNames, headerOffset: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>Length shift count</label>
          <input
            type="number"
            value={gNames.lengthShiftCount}
            onChange={(e) => setGNames({ ...gNames, lengthShiftCount: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>GUObjectArray chunks base</label>
          <input
            value={gObjectArray.chunksArrayBase}
            onChange={(e) => setGObjectArray({ ...gObjectArray, chunksArrayBase: e.target.value })}
            placeholder="0x..."
          />
        </div>
        <div className="field-row">
          <label>Elements per chunk</label>
          <input
            type="number"
            value={gObjectArray.numElementsPerChunk}
            onChange={(e) =>
              setGObjectArray({ ...gObjectArray, numElementsPerChunk: Number(e.target.value) })
            }
          />
        </div>
        <div className="field-row">
          <label>Item stride</label>
          <input
            type="number"
            value={gObjectArray.itemStride}
            onChange={(e) => setGObjectArray({ ...gObjectArray, itemStride: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>Item initial offset</label>
          <input
            type="number"
            value={gObjectArray.itemInitialOffset}
            onChange={(e) =>
              setGObjectArray({ ...gObjectArray, itemInitialOffset: Number(e.target.value) })
            }
          />
        </div>
        <button onClick={saveConfig}>{configSaved ? 'Saved ✓' : 'Save config'}</button>
      </section>

      <section className="panel">
        <h3>2. Resolve by name</h3>
        <div className="field-row">
          <label>Class</label>
          <input value={className} onChange={(e) => setClassName(e.target.value)} placeholder="e.g. Player" />
        </div>
        <div className="field-row">
          <label>Field (optional, pre-filters the list below)</label>
          <input value={fieldName} onChange={(e) => setFieldName(e.target.value)} placeholder="e.g. Health" />
        </div>
        <div className="field-row">
          <label>Max objects to scan</label>
          <input value={maxObjectsToScan} onChange={(e) => setMaxObjectsToScan(e.target.value)} />
        </div>
        <button onClick={resolve} disabled={resolving || !className.trim()}>
          {resolving ? 'Resolving…' : 'Resolve'}
        </button>
        {error && <p style={{ color: 'var(--error)' }}>{error}</p>}
        {classAddress !== null && (
          <>
            <p className="muted" style={{ fontSize: 12 }}>
              Resolved: <code>{classAddress}</code>
            </p>
            <input
              placeholder="Filter fields…"
              value={fieldFilter}
              onChange={(e) => setFieldFilter(e.target.value)}
            />
            <ul className="scroll-list">
              {filteredFields.map((f) => (
                <li key={f}>
                  <span>{f}</span>
                  <button className="btn-sm" onClick={() => onUseAsUeTarget(className.trim(), f)}>
                    Use as UE target
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

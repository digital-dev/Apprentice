import { useEffect, useRef, useState } from 'react'
import { decodeAt, toArrayBuffer } from '../dissect'
import type { DataType } from '../../../main/store'

const PAGE_SIZE = 256 // 16 bytes/row x 16 rows
const POLL_MS = 250

const MAX_ADDRESS = 0xffffffffffffffffn // 64-bit ceiling

function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()
  if (!/^(0x)?[0-9a-fA-F]+$/.test(trimmed)) return null
  const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`
  // The regex above already forbids a leading '-', so this only guards the
  // upper bound: a value that parses fine as a BigInt but is wider than a
  // real pointer would otherwise sail through and blow up later math (e.g.
  // page() or the dissect offset add) the same way a negative one does.
  const value = BigInt(hex)
  if (value < 0n || value > MAX_ADDRESS) return null
  return hex
}

export default function MemoryViewer({
  initialAddress,
  onDone,
  onConsumeJumpToAddress
}: {
  initialAddress?: string
  onDone: () => void
  // Clears App.tsx's jumpToAddress once this visit has consumed it as its
  // seed address — without this, a later, unrelated visit to this screen
  // (e.g. from the sidebar, with no fresh "View in Memory" click) would
  // silently re-seed from whatever address was clicked earlier in the
  // session. Mirrors CheatList's onConsumePendingMonoSelection pattern.
  onConsumeJumpToAddress?: () => void
}) {
  const [addressInput, setAddressInput] = useState(initialAddress ?? '0x0')
  const [baseAddress, setBaseAddress] = useState<string | null>(
    initialAddress ? normalizeAddress(initialAddress) : null
  )
  const [block, setBlock] = useState<ArrayBuffer | null>(null)
  // Distinct from "block is null" (reachable process, address unreadable):
  // this means the attached process itself is gone — a read/write rejected
  // rather than resolving. The stale grid is left on screen; only this
  // banner changes, and it clears on the next successful read (e.g. after
  // reattaching to the same address).
  const [detachedError, setDetachedError] = useState<string | null>(null)
  // The address currently being inline-edited, if any — the poll below
  // skips refetching while this is set, so a half-typed hex value is
  // never stomped by the next tick's refresh.
  const [editingOffset, setEditingOffset] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const editingRef = useRef<number | null>(null)
  editingRef.current = editingOffset

  // Consume the seed address exactly once, right after using it — mirrors
  // CheatList's pendingMonoSelection consumption. Mount-only: a later
  // change to initialAddress mid-visit (there isn't one today) should not
  // re-fire this.
  useEffect(() => {
    onConsumeJumpToAddress?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  interface DissectRow {
    offset: string // hex, relative to baseAddress
    dataType: DataType
    label: string
  }

  const [dissectRows, setDissectRows] = useState<DissectRow[]>([])
  const [newOffset, setNewOffset] = useState('0x0')
  const [newDataType, setNewDataType] = useState<DataType>('int32')
  const [newLabel, setNewLabel] = useState('')

  useEffect(() => {
    if (!baseAddress) return
    let cancelled = false
    async function poll() {
      if (editingRef.current !== null) return
      try {
        const result = await window.tamper.readMemoryBlock(baseAddress!, PAGE_SIZE)
        if (cancelled) return
        setBlock(result ? toArrayBuffer(result) : null)
        setDetachedError(null)
      } catch (err) {
        // The attached process is gone (memory:readBlock throws 'not
        // attached' once ipc.ts's watcher.onVanish/attachTo paths null out
        // attachedHandle). Leave `block` as-is — the interval keeps
        // retrying every tick, and a reattach to the same address clears
        // this on its next successful read.
        if (!cancelled) {
          void err // the underlying message is an IPC-wrapped 'not attached' — not worth surfacing verbatim
          setDetachedError('Lost connection to the attached process.')
        }
      }
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [baseAddress])

  function jump() {
    const normalized = normalizeAddress(addressInput)
    if (normalized) setBaseAddress(normalized)
  }

  function page(deltaPages: number) {
    if (!baseAddress) return
    const delta = BigInt(deltaPages * PAGE_SIZE)
    let next = BigInt(baseAddress) + delta
    if (next < 0n) next = 0n
    const normalized = '0x' + next.toString(16)
    setBaseAddress(normalized)
    setAddressInput(normalized)
  }

  function startEdit(offset: number, currentByte: number) {
    setEditingOffset(offset)
    setEditValue(currentByte.toString(16).padStart(2, '0'))
  }

  async function commitEdit(offset: number) {
    if (!baseAddress || !/^[0-9a-fA-F]{1,2}$/.test(editValue)) {
      setEditingOffset(null)
      return
    }
    const value = parseInt(editValue, 16)
    const byteAddress = '0x' + (BigInt(baseAddress) + BigInt(offset)).toString(16)
    setEditingOffset(null)
    try {
      const ok = await window.tamper.writeMemoryByte(byteAddress, value)
      if (!ok) {
        setDetachedError(`Write to ${byteAddress} failed — the page may be read-only.`)
      } else {
        setDetachedError(null)
      }
      const refreshed = await window.tamper.readMemoryBlock(baseAddress, PAGE_SIZE)
      setBlock(refreshed ? toArrayBuffer(refreshed) : null)
    } catch {
      setDetachedError('Lost connection to the attached process.')
    }
  }

  const bytes = block ? new Uint8Array(block) : null

  return (
    <div className="screen">
      <h2>Memory Viewer</h2>
      <div className="toolbar">
        <input
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && jump()}
          placeholder="0x..."
        />
        <button onClick={jump}>Jump</button>
        <button onClick={() => page(-1)} disabled={!baseAddress}>
          Prev page
        </button>
        <button onClick={() => page(1)} disabled={!baseAddress}>
          Next page
        </button>
        <button onClick={onDone}>Done</button>
      </div>

      {detachedError && (
        <p className="muted" style={{ color: 'var(--error)' }}>
          {detachedError}
        </p>
      )}

      {baseAddress && !bytes && <p className="muted">Unreadable at this address.</p>}

      {baseAddress && bytes && (
        <table className="hex-grid">
          <tbody>
            {Array.from({ length: PAGE_SIZE / 16 }, (_, row) => {
              const rowOffset = row * 16
              const rowAddress = '0x' + (BigInt(baseAddress) + BigInt(rowOffset)).toString(16)
              return (
                <tr key={row}>
                  <td className="addr">{rowAddress}</td>
                  {Array.from({ length: 16 }, (_, col) => {
                    const offset = rowOffset + col
                    const value = bytes[offset]
                    return (
                      <td key={col}>
                        {editingOffset === offset ? (
                          <input
                            autoFocus
                            size={2}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitEdit(offset)
                              if (e.key === 'Escape') setEditingOffset(null)
                            }}
                            onBlur={() => setEditingOffset(null)}
                          />
                        ) : (
                          <span onClick={() => startEdit(offset, value)}>
                            {value.toString(16).padStart(2, '0')}
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td className="ascii">
                    {Array.from({ length: 16 }, (_, col) => {
                      const value = bytes[rowOffset + col]
                      return value >= 32 && value < 127 ? String.fromCharCode(value) : '.'
                    }).join('')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {baseAddress && bytes && (
        <div className="dissect-panel">
          <h3>Structure Dissect</h3>
          <div className="toolbar">
            <input value={newOffset} onChange={(e) => setNewOffset(e.target.value)} placeholder="offset (hex)" />
            <select value={newDataType} onChange={(e) => setNewDataType(e.target.value as DataType)}>
              <option value="int8">int8</option>
              <option value="int16">int16</option>
              <option value="int32">int32</option>
              <option value="int64">int64</option>
              <option value="float">float</option>
              <option value="double">double</option>
            </select>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="label" />
            <button
              onClick={() => {
                const normalized = normalizeAddress(newOffset)
                if (!normalized) return
                setDissectRows((rows) => [
                  ...rows,
                  { offset: normalized, dataType: newDataType, label: newLabel || normalized }
                ])
                setNewLabel('')
              }}
            >
              Add
            </button>
          </div>
          <ul>
            {dissectRows.map((row, i) => {
              const decoded = decodeAt(block!, Number(BigInt(row.offset)), row.dataType)
              return (
                <li key={`${row.offset}-${i}`}>
                  <span>{row.label}</span>
                  <span className="muted"> ({row.dataType} @ {row.offset}): </span>
                  <strong>{decoded === null ? 'out of range' : decoded.toString()}</strong>
                  <button onClick={() => setDissectRows((rows) => rows.filter((_, idx) => idx !== i))}>
                    Remove
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { decodeAt, toArrayBuffer } from '../dissect'
import { pickThread } from '../registers'
import type { DataType } from '../../../main/store'
import type { DisasmRow } from '../tamper.d'

const HEX_INITIAL_BYTES = 2048 // 16 bytes/row x 128 rows, first paint
const HEX_CHUNK_BYTES = 2048 // fetched each time the scroll nears an edge
const HEX_MAX_WINDOW_BYTES = 32768 // sliding-window cap (2048 rows) — old bytes drop off the far end

const DISASM_INITIAL_BYTES = 4096
const DISASM_CHUNK_BYTES = 4096
const DISASM_MAX_ROWS = 2000 // sliding-window cap on decoded rows

const DISSECT_BLOCK_SIZE = 256 // Structure Dissect reads a small block AT baseAddress, independent of the scrolling window below — see its own comment

// Scroll-triggered loads fire this many px before the real edge, so the
// next chunk is usually in place before the user reaches blank space.
const SCROLL_TRIGGER_PX = 300

const POLL_MS = 250

// Thread lists churn constantly in a live game — refreshing the dropdown
// at the same 250ms cadence as the register poll itself would be wasted
// re-renders for something that doesn't need to be that fresh.
const THREAD_LIST_POLL_MS = 2000

const MAX_ADDRESS = 0xffffffffffffffffn // 64-bit ceiling

type ViewMode = 'hex' | 'disasm'

// The byte span disasmRows actually covers, derived from the rows
// themselves rather than tracked incrementally — see the drift bug this
// replaced, in the poll effect's own comment.
function disasmSpanOf(rows: DisasmRow[], start: bigint): number {
  const last = rows[rows.length - 1]
  return Number(BigInt(last.address) + BigInt(last.length) - start)
}

function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()
  if (!/^(0x)?[0-9a-fA-F]+$/.test(trimmed)) return null
  const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`
  // The regex above already forbids a leading '-', so this only guards the
  // upper bound: a value that parses fine as a BigInt but is wider than a
  // real pointer would otherwise sail through and blow up later math the
  // same way a negative one does.
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
  const [viewMode, setViewMode] = useState<ViewMode>('hex')

  // The scrolling window: a single contiguous region starting at
  // windowStart, growing in either direction as the user scrolls near an
  // edge (loadMoreBackward/loadMoreForward below), capped at *_MAX_WINDOW_*
  // so neither the native read nor the DOM grows unbounded. Distinct from
  // `baseAddress` (the address bar / jump target) — windowStart moves as
  // you scroll, baseAddress only moves on an explicit Jump/View-in-Memory.
  const [windowStart, setWindowStart] = useState<bigint | null>(null)
  const [hexBytes, setHexBytes] = useState<Uint8Array | null>(null)
  const [disasmRows, setDisasmRows] = useState<DisasmRow[]>([])
  // Raw bytes the currently-decoded disasmRows were built from — needed to
  // know how many bytes to re-read+re-decode on the next poll tick (unlike
  // hex mode, row count doesn't map 1:1 to a fixed byte width).
  const [disasmByteSpan, setDisasmByteSpan] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  // Distinct from "still loading": memory:readBlock came back null, i.e.
  // the address itself isn't mapped/readable.
  const [unreadable, setUnreadable] = useState(false)

  // Distinct from unreadable: this means the attached process itself is
  // gone — a read/write rejected rather than resolving. The stale grid is
  // left on screen; only this banner changes, and it clears on the next
  // successful read (e.g. after reattaching to the same address).
  const [detachedError, setDetachedError] = useState<string | null>(null)

  // The address currently being inline-edited, if any — polling AND
  // scroll-triggered extension both skip while this is set, so a
  // half-typed hex value is never stomped, and the row it belongs to never
  // shifts out from under it (extension prepends bytes ahead of the
  // window, which would silently repoint editingOffset at the wrong byte).
  const [editingOffset, setEditingOffset] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const editingRef = useRef<number | null>(null)
  editingRef.current = editingOffset

  // Refs mirroring the state above, read inside the poll interval and the
  // scroll-triggered loaders — both need the CURRENT window, not the value
  // captured when their closure was created (the interval is set up once
  // per baseAddress/viewMode change and lives for many ticks; the loaders
  // are plain event handlers, not effects, so they'd otherwise close over
  // stale state from whenever they were last recreated).
  const windowStartRef = useRef<bigint | null>(null)
  const hexBytesRef = useRef<Uint8Array | null>(null)
  const disasmRowsRef = useRef<DisasmRow[]>([])
  const disasmSpanRef = useRef(0)
  windowStartRef.current = windowStart
  hexBytesRef.current = hexBytes
  disasmRowsRef.current = disasmRows
  disasmSpanRef.current = disasmByteSpan

  // Scroll-position compensation: prepending rows/bytes at the top of the
  // scroll container otherwise yanks the viewport down by exactly the
  // height added (the browser keeps scrollTop, not "what's on screen",
  // constant across a DOM mutation). Standard fix: record scrollHeight
  // right before the state update that will prepend content, then in a
  // layout effect after the DOM reflects it, add back the height delta.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollFixRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (pendingScrollFixRef.current !== null && scrollRef.current) {
      const delta = scrollRef.current.scrollHeight - pendingScrollFixRef.current
      scrollRef.current.scrollTop += delta
      pendingScrollFixRef.current = null
    }
  }, [hexBytes, disasmRows])

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
  const [dissectBlock, setDissectBlock] = useState<ArrayBuffer | null>(null)

  const [threads, setThreads] = useState<{ tid: number }[]>([])
  const [selectedTid, setSelectedTid] = useState<number | null>(null)
  const [registers, setRegisters] = useState<Record<string, string> | null>(null)
  const selectedTidRef = useRef<number | null>(null)
  selectedTidRef.current = selectedTid

  // Thread list refresh — independent of baseAddress/windowStart, since
  // threads aren't tied to any address range. Runs whenever a process is
  // attached at all, which this screen has no direct signal for; it polls
  // regardless and simply gets [] back until something is attached (same
  // shape as the dissect block's own poll).
  useEffect(() => {
    let cancelled = false
    async function poll() {
      const list = await window.tamper.listThreads()
      if (cancelled) return
      setThreads(list)
      setSelectedTid((current) => pickThread(current, list))
    }
    void poll()
    const id = setInterval(poll, THREAD_LIST_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Register poll for the selected thread — its own 250ms interval,
  // independent of the hex/disasm window poll and the thread-list poll
  // above (three independent polling loops already coexist in this file;
  // see the Structure Dissect panel's own poll for precedent).
  useEffect(() => {
    if (selectedTid === null) {
      setRegisters(null)
      return
    }
    let cancelled = false
    async function poll() {
      const tid = selectedTidRef.current
      if (tid === null) return
      const regs = await window.tamper.getThreadRegisters(tid)
      if (cancelled) return
      if (regs === null) {
        // The thread exited between the last list refresh and this read —
        // clear the selection so the next thread-list tick picks a live
        // one, rather than polling a dead tid until that tick arrives.
        setSelectedTid(null)
        setRegisters(null)
        return
      }
      setRegisters(regs)
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selectedTid])

  // Structure Dissect's own small, fixed-address poll — deliberately NOT
  // tied to the scrolling window above (windowStart moves as the user
  // scrolls; a dissect offset is meant relative to the address you jumped
  // to, not wherever the viewport happens to be).
  useEffect(() => {
    if (!baseAddress) {
      setDissectBlock(null)
      return
    }
    let cancelled = false
    async function poll() {
      try {
        const result = await window.tamper.readMemoryBlock(baseAddress!, DISSECT_BLOCK_SIZE)
        if (!cancelled) setDissectBlock(result ? toArrayBuffer(result) : null)
      } catch {
        // The main window/hex-disasm poll below already surfaces
        // detachedError for a lost connection — no need to duplicate it.
      }
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [baseAddress])

  // The scrolling window's load + refresh cycle. Resets to a fresh window
  // at baseAddress whenever baseAddress or viewMode changes (a new
  // jump/tab switch, not a scroll), then re-fetches the CURRENT window
  // (which may have grown via loadMoreBackward/Forward since this effect
  // last ran) every tick after that.
  useEffect(() => {
    if (!baseAddress) return
    let cancelled = false
    const start = BigInt(baseAddress)
    windowStartRef.current = start
    hexBytesRef.current = null
    disasmRowsRef.current = []
    disasmSpanRef.current = 0
    setWindowStart(start)
    setHexBytes(null)
    setDisasmRows([])
    setDisasmByteSpan(0)
    setUnreadable(false)

    async function poll() {
      if (editingRef.current !== null) return
      const curStart = windowStartRef.current
      if (curStart === null) return
      const curLen = viewMode === 'disasm' ? disasmSpanRef.current : (hexBytesRef.current?.length ?? 0)
      const fetchLen = curLen > 0 ? curLen : viewMode === 'disasm' ? DISASM_INITIAL_BYTES : HEX_INITIAL_BYTES
      try {
        const result = await window.tamper.readMemoryBlock('0x' + curStart.toString(16), fetchLen)
        if (cancelled) return
        if (!result) {
          // A fresh jump landing on nothing is a real "unreadable here".
          // An already-established window failing to fully reread is a
          // different case — most often the window grew to butt up against
          // an unmapped page at one edge (see loadMoreForward/Backward's
          // own reads, which only ever grow into memory that itself just
          // read successfully) combined with a transient hiccup on this
          // tick's re-read of the WHOLE span. Wiping a large, mostly-good
          // window to "Unreadable" over that would be worse than just
          // skipping this tick's refresh and trying again in 250ms.
          if (curLen === 0) {
            setHexBytes(null)
            setDisasmRows([])
            setUnreadable(true)
          }
          setDetachedError(null)
          return
        }
        setUnreadable(false)
        setDetachedError(null)
        const buf = toArrayBuffer(result)
        if (viewMode === 'hex') {
          setHexBytes(new Uint8Array(buf))
        } else {
          const rows = await window.tamper.disassemble(buf, '0x' + curStart.toString(16), DISASM_MAX_ROWS)
          if (!cancelled) {
            setDisasmRows(rows)
            // Derived from the actual decoded rows, not the requested
            // fetchLen — DISASM_MAX_ROWS can cap decoding before the whole
            // buffer is consumed, and recording fetchLen anyway would have
            // the next tick ask for more bytes than were ever decoded (see
            // this file's history for the drift bug that caused).
            setDisasmByteSpan(rows.length > 0 ? disasmSpanOf(rows, curStart) : 0)
          }
        }
      } catch (err) {
        // The attached process is gone (memory:readBlock throws 'not
        // attached' once ipc.ts's watcher.onVanish/attachTo paths null out
        // attachedHandle). Leave the grid as-is — the interval keeps
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
  }, [baseAddress, viewMode])

  // Extends the window backward (toward lower addresses) by one chunk,
  // triggered by scrolling near the top. Skipped while mid-edit — see
  // editingOffset's comment: prepending bytes would silently repoint it at
  // the wrong byte.
  async function loadMoreBackward() {
    if (loadingMore || editingRef.current !== null) return
    const start = windowStartRef.current
    if (start === null || start <= 0n) return
    setLoadingMore(true)
    try {
      const chunk = BigInt(viewMode === 'disasm' ? DISASM_CHUNK_BYTES : HEX_CHUNK_BYTES)
      let newStart = start - chunk
      if (newStart < 0n) newStart = 0n
      const actualChunkBytes = Number(start - newStart)
      if (actualChunkBytes <= 0) return
      const result = await window.tamper.readMemoryBlock('0x' + newStart.toString(16), actualChunkBytes)
      if (!result) return
      const buf = toArrayBuffer(result)

      if (scrollRef.current) pendingScrollFixRef.current = scrollRef.current.scrollHeight

      if (viewMode === 'hex') {
        const prepend = new Uint8Array(buf)
        const prev = hexBytesRef.current ?? new Uint8Array(0)
        let combined = new Uint8Array(prepend.length + prev.length)
        combined.set(prepend, 0)
        combined.set(prev, prepend.length)
        if (combined.length > HEX_MAX_WINDOW_BYTES) {
          // Cap by dropping from the far (bottom) end — newStart is still
          // the correct address for what's kept.
          combined = combined.slice(0, HEX_MAX_WINDOW_BYTES)
        }
        setHexBytes(combined)
        setWindowStart(newStart)
      } else {
        const decoded = await window.tamper.disassemble(buf, '0x' + newStart.toString(16), DISASM_MAX_ROWS)
        // Splice where a decoded instruction's end lines up exactly with
        // the OLD top row's address, for a clean, correctly-aligned join.
        // If nothing lines up (the chunk boundary landed inside what used
        // to be an instruction, from the OLD side), fall back to every
        // decoded row strictly before the old start — a row or two near
        // the seam may show as "??" until the decoder resyncs with the
        // real byte stream, the same self-correcting wrinkle documented on
        // the Prev-page button below.
        let spliceIdx = -1
        for (let i = 0; i < decoded.length; i++) {
          if (BigInt(decoded[i].address) + BigInt(decoded[i].length) === start) {
            spliceIdx = i
            break
          }
        }
        const toPrepend =
          spliceIdx >= 0 ? decoded.slice(0, spliceIdx + 1) : decoded.filter((r) => BigInt(r.address) < start)
        let combined = [...toPrepend, ...disasmRowsRef.current]
        if (combined.length > DISASM_MAX_ROWS) combined = combined.slice(0, DISASM_MAX_ROWS)
        setDisasmRows(combined)
        setDisasmByteSpan(combined.length > 0 ? disasmSpanOf(combined, newStart) : 0)
        setWindowStart(newStart)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  // Extends the window forward (toward higher addresses) by one chunk,
  // triggered by scrolling near the bottom. No scroll-position fix needed
  // here — appending after the visible content doesn't move it.
  async function loadMoreForward() {
    if (loadingMore || editingRef.current !== null) return
    setLoadingMore(true)
    try {
      if (viewMode === 'hex') {
        const prev = hexBytesRef.current
        const start = windowStartRef.current
        if (!prev || start === null) return
        const chunkStart = start + BigInt(prev.length)
        const result = await window.tamper.readMemoryBlock('0x' + chunkStart.toString(16), HEX_CHUNK_BYTES)
        if (!result) return
        const appended = new Uint8Array(toArrayBuffer(result))
        let combined = new Uint8Array(prev.length + appended.length)
        combined.set(prev, 0)
        combined.set(appended, prev.length)
        let finalStart = start
        if (combined.length > HEX_MAX_WINDOW_BYTES) {
          // Cap by dropping from the near (top) end — windowStart must
          // advance by however much was trimmed, or every remaining byte's
          // reported address would be wrong.
          const trim = combined.length - HEX_MAX_WINDOW_BYTES
          combined = combined.slice(trim)
          finalStart = start + BigInt(trim)
        }
        setHexBytes(combined)
        setWindowStart(finalStart)
      } else {
        const rows = disasmRowsRef.current
        if (rows.length === 0) return
        const last = rows[rows.length - 1]
        // Exact resync, same reasoning as the Next-page button: the address
        // right after the last decoded instruction, not a guessed delta.
        const chunkStart = BigInt(last.address) + BigInt(last.length)
        const result = await window.tamper.readMemoryBlock('0x' + chunkStart.toString(16), DISASM_CHUNK_BYTES)
        if (!result) return
        const buf = toArrayBuffer(result)
        const decoded = await window.tamper.disassemble(buf, '0x' + chunkStart.toString(16), DISASM_MAX_ROWS)
        let combined = [...rows, ...decoded]
        let finalStart = windowStartRef.current
        if (combined.length > DISASM_MAX_ROWS) {
          const trim = combined.length - DISASM_MAX_ROWS
          combined = combined.slice(trim)
          finalStart = BigInt(combined[0].address)
        }
        setDisasmRows(combined)
        if (finalStart !== null) {
          setDisasmByteSpan(combined.length > 0 ? disasmSpanOf(combined, finalStart) : 0)
          setWindowStart(finalStart)
        }
      }
    } finally {
      setLoadingMore(false)
    }
  }

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (editingRef.current !== null) return
    const el = e.currentTarget
    if (el.scrollTop < SCROLL_TRIGGER_PX) void loadMoreBackward()
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_TRIGGER_PX) void loadMoreForward()
  }

  function jump() {
    const normalized = normalizeAddress(addressInput)
    if (normalized) setBaseAddress(normalized)
  }

  // Prev/Next page: a bigger, immediate jump — resets to a fresh window at
  // the new address, rather than incrementally scroll-loading there.
  function page(deltaPages: number) {
    if (!baseAddress) return
    let next: bigint
    if (viewMode === 'disasm' && deltaPages > 0 && disasmRows.length > 0) {
      // Exact resync: the address right after the last decoded instruction,
      // rather than a guessed byte delta — instructions aren't fixed-width,
      // so anything else risks landing mid-instruction on the next page.
      const last = disasmRows[disasmRows.length - 1]
      next = BigInt(last.address) + BigInt(last.length)
    } else {
      // Backward paging (either mode) and all of hex mode: a fixed byte
      // delta. For disassembly this can land mid-instruction — the decoder
      // resyncs with the real byte stream within a row or two (each
      // misaligned byte is shown as its own "??" row, same as any other
      // undecodable byte), so a stray row at the top of a page-up is a
      // known, self-correcting cosmetic wrinkle, not a bug.
      const delta = BigInt(
        deltaPages * (viewMode === 'disasm' ? DISASM_INITIAL_BYTES : HEX_INITIAL_BYTES)
      )
      next = BigInt(baseAddress) + delta
    }
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
    if (windowStart === null || !/^[0-9a-fA-F]{1,2}$/.test(editValue)) {
      setEditingOffset(null)
      return
    }
    const value = parseInt(editValue, 16)
    const byteAddress = '0x' + (windowStart + BigInt(offset)).toString(16)
    setEditingOffset(null)
    try {
      const ok = await window.tamper.writeMemoryByte(byteAddress, value)
      if (!ok) {
        setDetachedError(`Write to ${byteAddress} failed — the page may be read-only.`)
      } else {
        setDetachedError(null)
      }
      const len = hexBytes?.length ?? HEX_INITIAL_BYTES
      const refreshed = await window.tamper.readMemoryBlock('0x' + windowStart.toString(16), len)
      setHexBytes(refreshed ? new Uint8Array(toArrayBuffer(refreshed)) : null)
    } catch {
      setDetachedError('Lost connection to the attached process.')
    }
  }

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
        <div className="tabbar" style={{ height: 34, border: 'none' }}>
          <button
            className={`tab btn-sm ${viewMode === 'hex' ? 'active' : ''}`}
            onClick={() => setViewMode('hex')}
          >
            Hex
          </button>
          <button
            className={`tab btn-sm ${viewMode === 'disasm' ? 'active' : ''}`}
            onClick={() => setViewMode('disasm')}
          >
            Disassembly
          </button>
        </div>
        <button className="btn-quiet" onClick={onDone}>
          Done
        </button>
      </div>

      {detachedError && <p className="banner banner-error">{detachedError}</p>}

      {baseAddress && unreadable && <p className="muted">Unreadable at this address.</p>}

      {baseAddress && !unreadable && viewMode === 'hex' && (
        <div className="hex-grid-scroll" ref={scrollRef} onScroll={onScroll}>
          {hexBytes && (
            <table className="hex-grid">
              <tbody>
                {Array.from({ length: hexBytes.length / 16 }, (_, row) => {
                  const rowOffset = row * 16
                  const rowAddress = '0x' + (windowStart! + BigInt(rowOffset)).toString(16)
                  return (
                    <tr key={rowAddress}>
                      <td className="addr">{rowAddress}</td>
                      {Array.from({ length: 16 }, (_, col) => {
                        const offset = rowOffset + col
                        const value = hexBytes[offset]
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
                          const value = hexBytes[rowOffset + col]
                          return value >= 32 && value < 127 ? String.fromCharCode(value) : '.'
                        }).join('')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {baseAddress && !unreadable && viewMode === 'disasm' && (
        <div className="disasm-scroll" ref={scrollRef} onScroll={onScroll}>
          <table className="disasm-list">
            <tbody>
              {disasmRows.map((row) => (
                <tr key={row.address} className={row.text === '??' ? 'undecoded' : undefined}>
                  <td className="addr">{row.address}</td>
                  <td className="disasm-bytes">{row.bytes}</td>
                  <td className="disasm-text">{row.text}</td>
                </tr>
              ))}
              {disasmRows.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    Decoding…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {baseAddress && dissectBlock && (
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
              const decoded = decodeAt(dissectBlock, Number(BigInt(row.offset)), row.dataType)
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

      <div className="registers-panel">
        <h3>Registers</h3>
        <div className="toolbar">
          <select
            value={selectedTid ?? ''}
            onChange={(e) => setSelectedTid(e.target.value === '' ? null : Number(e.target.value))}
            disabled={threads.length === 0}
          >
            {threads.length === 0 && <option value="">No threads</option>}
            {threads.map((t) => (
              <option key={t.tid} value={t.tid}>
                Thread {t.tid}
              </option>
            ))}
          </select>
        </div>
        {selectedTid !== null && registers === null && <p className="muted">Reading…</p>}
        {registers && (
          <table className="registers-grid">
            <tbody>
              {(
                [
                  ['rax', 'rbx', 'rcx', 'rdx'],
                  ['rsi', 'rdi', 'rbp', 'rsp'],
                  ['rip', 'r8', 'r9', 'r10'],
                  ['r11', 'r12', 'r13', 'r14'],
                  ['r15', 'rflags']
                ] as const
              ).map((row, i) => (
                <tr key={i}>
                  {row.map((name) => (
                    <td key={name}>
                      <span className="reg-name">{name}</span>
                      <span className="reg-value">{registers[name]}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

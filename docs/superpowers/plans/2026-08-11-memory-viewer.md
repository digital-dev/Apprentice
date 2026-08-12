# Memory Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, scrollable hex+ASCII viewer of the attached process's memory, with an inline byte editor and a session-only structure-dissect panel, reachable from the Scanner and cheat list.

**Architecture:** Extend the existing `patch_ops.cc` `ReadBytes` native export (raise its cap, add a raw-buffer mode) instead of adding a parallel export; add two IPC channels (`memory:readBlock`, `memory:writeByte`); a new pure `dissect.ts` module decodes a fetched byte block into typed rows in the renderer (a second, independently-tested implementation of `value_type.h`'s width rules, since renderer code cannot call into the native addon's C++ inline functions); a new `MemoryViewer.tsx` screen polls a 256-byte page every 250ms and renders it as hex+ASCII plus the dissect panel.

**Tech Stack:** TypeScript/React (renderer), TypeScript (main/IPC), C++ N-API (native addon), Vitest.

## Global Constraints

- Reuse `patch_ops.cc`'s existing `ReadBytes`/`readBytes` — do not add a second, parallel native read export.
- The new read path throws on failure exactly like the existing `readBytes`/`ReadBytes` do; a non-throwing wrapper (`tryReadBytes`-style) sits at the `nativeAddon.ts` layer, matching the existing `tryReadValue`/`tryReadBytes` split.
- Page size for the viewer is fixed at 256 bytes (16 bytes/row × 16 rows).
- Poll interval is 250ms, matching `Scanner.tsx`'s existing write-watch poll.
- Dissect rows are session-only: never persisted to the profile, reset when `MemoryViewer` unmounts.
- `dissect.ts`'s decoding must agree with `native/src/value_type.h`'s width/signedness rules exactly (int8 unsigned, int16/int32/int64 signed, float/double IEEE-754 little-endian) — get its own test rather than trusting it by inspection.
- `int64` decodes to a `BigInt`, not a `number` — a hex viewer must not lose precision the way `value_type.h`'s `InterpretAsDouble` deliberately does for scan comparisons.
- Every new IPC channel gets an entry in both `src/preload/index.ts` and `src/renderer/src/tamper.d.ts`, per this app's existing convention.

---

### Task 1: Native — raise `ReadBytes`'s cap and add a raw-buffer mode

**Files:**
- Modify: `native/src/patch_ops.cc:179-198` (the `ReadBytes` function)
- Test: `tests/native/patch_ops.test.ts` (extend the existing `describe('readBytes / writeBytes', ...)` block)

**Interfaces:**
- Produces: `ReadBytes(handle, address, length, raw?)` — with `raw` omitted or `false`, behavior is byte-for-byte unchanged (hex string, existing callers untouched); with `raw: true`, returns a `Napi::Buffer<uint8_t>` of `length` bytes instead of a hex string. Cap raised from 64 to 4096 bytes (both modes).

- [ ] **Step 1: Write the failing test**

Add to `tests/native/patch_ops.test.ts`, inside the existing `describe('readBytes / writeBytes', ...)` block (it already has `harness`/`handle` set up in a shared `beforeAll` — follow the exact pattern the surrounding tests in that file use for spawning/attaching to `test-harness/harness.exe`):

```ts
it('reads up to 4096 bytes now, not just 64', () => {
  const bytes: string = (addon as any).readBytes(handle, baseAddress, 4096)
  expect(bytes.length).toBe(4096 * 2) // hex-encoded, 2 chars/byte
})

it('still rejects a request over the new cap', () => {
  expect(() => (addon as any).readBytes(handle, baseAddress, 4097)).toThrow()
})

it('raw mode returns a Buffer of the requested length, matching the hex mode byte-for-byte', () => {
  const hex: string = (addon as any).readBytes(handle, baseAddress, 16)
  const raw: Buffer = (addon as any).readBytes(handle, baseAddress, 16, true)
  expect(Buffer.isBuffer(raw)).toBe(true)
  expect(raw.length).toBe(16)
  expect(raw.toString('hex')).toBe(hex)
})
```

Use whatever variable this file's existing tests already use for a known-readable address in the harness process (check the file's existing `beforeAll`/earlier tests for the established address — do not invent a new one).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/patch_ops.test.ts`
Expected: FAIL — `readBytes length must be 1..64` on the 4096-byte request, and the raw-mode test fails because a 5th positional isn't handled yet.

- [ ] **Step 3: Implement**

Replace `native/src/patch_ops.cc`'s `ReadBytes` (currently lines 179-198) with:

```cpp
Napi::Value ReadBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t address = ParseHex(info[1].As<Napi::String>().Utf8Value());
  size_t length = static_cast<size_t>(info[2].As<Napi::Number>().Uint32Value());
  // Raised from 64 to 4096: the memory viewer requests one 256-byte page
  // per poll tick, well under this cap; 4096 remains a safety bound
  // against a malformed call, not a real constraint on any caller.
  bool raw = info.Length() > 3 && info[3].As<Napi::Boolean>().Value();

  if (length == 0 || length > 4096) {
    Napi::Error::New(env, "readBytes length must be 1..4096").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<uint8_t> buffer(length);
  SIZE_T read = 0;
  if (!ReadProcessMemory(h, (LPCVOID)address, buffer.data(), length, &read) || read != length) {
    Napi::Error::New(env, "ReadProcessMemory failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (raw) {
    return Napi::Buffer<uint8_t>::Copy(env, buffer.data(), length);
  }
  return Napi::String::New(env, BytesToHex(buffer.data(), length));
}
```

- [ ] **Step 4: Rebuild the native addon and run the test**

Run: `cd native && node-gyp build && cd ..`
Run: `npx vitest run tests/native/patch_ops.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — the signature change is backward compatible)

- [ ] **Step 5: Commit**

```bash
git add native/src/patch_ops.cc tests/native/patch_ops.test.ts
git commit -m "Raise readBytes cap to 4096 and add a raw Buffer mode"
```

---

### Task 2: Main process — `readMemoryBlock`/`tryReadMemoryBlock` wrapper and IPC channels

**Files:**
- Modify: `src/main/nativeAddon.ts` (add a wrapper alongside the existing `readBytes`/`tryReadBytes`)
- Modify: `src/main/ipc.ts` (add `memory:readBlock` and `memory:writeByte` handlers inside `registerIpcHandlers`)
- Modify: `src/preload/index.ts` (bridge the two new channels)
- Modify: `src/renderer/src/tamper.d.ts` (declare the two new `window.tamper` methods)

**Interfaces:**
- Consumes: `nativeAddon.readBytes`/native `ReadBytes` raw mode from Task 1; `nativeAddon.writeValue` (existing, used unchanged for the byte write).
- Produces: `nativeAddon.readMemoryBlock(handle, address, length): Buffer` (throws), `nativeAddon.tryReadMemoryBlock(handle, address, length): Buffer | null` (never throws) — both consumed by Task 5's `MemoryViewer.tsx`. IPC channels `memory:readBlock(address, length) -> Buffer | null` and `memory:writeByte(address, value) -> boolean`, both throwing `'not attached'` when nothing is attached (matching `cheats:oneShot`'s convention).

- [ ] **Step 1: Add the wrappers to `nativeAddon.ts`**

Add directly below the existing `tryReadBytes` entry (`src/main/nativeAddon.ts:96-102`):

```ts
  // Raw-Buffer counterpart to readBytes/tryReadBytes, for a caller that
  // wants to decode the bytes itself (DataView, multiple widths at once)
  // instead of re-parsing a hex string — the memory viewer's whole reason
  // for existing. Same throw-on-failure contract as readBytes.
  readMemoryBlock: (handle: number, address: string, length: number): Buffer =>
    addon.readBytes(handle, address, length, true),
  // Non-throwing form for a 250ms poll landing on unmapped memory — an
  // expected, routine outcome for a viewer jumping to an arbitrary
  // address, not an error. Same split as tryReadBytes/tryReadValue.
  tryReadMemoryBlock: (handle: number, address: string, length: number): Buffer | null => {
    try {
      return addon.readBytes(handle, address, length, true)
    } catch {
      return null
    }
  },
```

- [ ] **Step 2: Add the IPC handlers to `ipc.ts`**

Add inside `registerIpcHandlers`, near the other `cheats:*`/`memory`-adjacent handlers (e.g. right after the `cheats:oneShot` handler at `src/main/ipc.ts:692-695`):

```ts
  ipcMain.handle(
    'memory:readBlock',
    (_e, address: string, length: number): Buffer | null => {
      if (attachedHandle === null) throw new Error('not attached')
      return nativeAddon.tryReadMemoryBlock(attachedHandle, address, length)
    }
  )

  ipcMain.handle('memory:writeByte', (_e, address: string, value: number): boolean => {
    if (attachedHandle === null) throw new Error('not attached')
    // Same call writeCheat makes for an int8 target — int8 is this app's
    // unsigned 1-byte width, exactly what a hex editor's 0-255 byte field
    // wants (see store.ts's DataType comment).
    return nativeAddon.writeValue(attachedHandle, address, [], 'int8', value)
  })
```

- [ ] **Step 3: Bridge the channels in `src/preload/index.ts`**

Add inside the `contextBridge.exposeInMainWorld('tamper', { ... })` object, near `startWriteWatch`/`pollWriteWatch` (`src/preload/index.ts:26-28`):

```ts
  readMemoryBlock: (address: string, length: number) =>
    ipcRenderer.invoke('memory:readBlock', address, length),
  writeMemoryByte: (address: string, value: number) =>
    ipcRenderer.invoke('memory:writeByte', address, value),
```

- [ ] **Step 4: Declare the channels in `src/renderer/src/tamper.d.ts`**

Add inside the `Window.tamper` interface, near `startWriteWatch`/`pollWriteWatch` (`src/renderer/src/tamper.d.ts:71-73`):

```ts
      // Fetches up to 4096 raw bytes starting at `address` from the attached
      // process, for the memory viewer. null when the read fails outright
      // (unmapped, wrong permissions) — the caller shows the page as
      // unreadable rather than treating this as an error.
      readMemoryBlock: (address: string, length: number) => Promise<ArrayBuffer | null>
      // Writes a single unsigned byte (0-255) at `address` — the memory
      // viewer's inline byte editor.
      writeMemoryByte: (address: string, value: number) => Promise<boolean>
```

(`Buffer` sent over Electron's `ipcRenderer.invoke` arrives in the renderer as a plain `ArrayBuffer`/`Uint8Array`-like structured-clone value, not Node's `Buffer` class, which doesn't exist in the renderer — declare it as `ArrayBuffer` here and wrap it in a `DataView` on the receiving end in Task 5.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/nativeAddon.ts src/main/ipc.ts src/preload/index.ts src/renderer/src/tamper.d.ts
git commit -m "Add memory:readBlock / memory:writeByte IPC channels"
```

---

### Task 3: `dissect.ts` — pure structure-dissect decoder

**Files:**
- Create: `src/renderer/src/dissect.ts`
- Test: `tests/renderer/dissect.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — a pure module.
- Produces: `decodeAt(block: ArrayBuffer, offset: number, dataType: DataType): number | bigint | null`, consumed by Task 6's dissect panel. `DataType` is imported from `../../src/main/store` (the same six-way union: `'int8' | 'int16' | 'int32' | 'int64' | 'float' | 'double'`).

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/dissect.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decodeAt } from '../../src/renderer/src/dissect'

// Byte layout, little-endian throughout:
// offset 0: int8 200 (0xC8)
// offset 1: int16 -1000 (0xFC18)
// offset 4: int32 -70000 (0xFFFEEE90)
// offset 8: int64 -1n (0xFFFFFFFFFFFFFFFF)
// offset 16: float 1.5 (0x3FC00000)
// offset 20: double 2.5 (0x4004000000000000)
function testBlock(): ArrayBuffer {
  const buf = new ArrayBuffer(28)
  const view = new DataView(buf)
  view.setUint8(0, 200)
  view.setInt16(1, -1000, true)
  view.setInt32(4, -70000, true)
  view.setBigInt64(8, -1n, true)
  view.setFloat32(16, 1.5, true)
  view.setFloat64(20, 2.5, true)
  return buf
}

describe('decodeAt', () => {
  it('decodes int8 as unsigned, matching value_type.h\'s UInt8 convention', () => {
    expect(decodeAt(testBlock(), 0, 'int8')).toBe(200)
  })

  it('decodes int16 as signed', () => {
    expect(decodeAt(testBlock(), 1, 'int16')).toBe(-1000)
  })

  it('decodes int32 as signed', () => {
    expect(decodeAt(testBlock(), 4, 'int32')).toBe(-70000)
  })

  it('decodes int64 as a BigInt, not a lossily-widened number', () => {
    expect(decodeAt(testBlock(), 8, 'int64')).toBe(-1n)
  })

  it('decodes float little-endian', () => {
    expect(decodeAt(testBlock(), 16, 'float')).toBeCloseTo(1.5)
  })

  it('decodes double little-endian', () => {
    expect(decodeAt(testBlock(), 20, 'double')).toBeCloseTo(2.5)
  })

  it('returns null when the type would read past the end of the block', () => {
    expect(decodeAt(testBlock(), 26, 'double')).toBeNull()
  })

  it('returns null for a negative offset', () => {
    expect(decodeAt(testBlock(), -1, 'int8')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/dissect.test.ts`
Expected: FAIL with "Cannot find module '../../src/renderer/src/dissect'"

- [ ] **Step 3: Implement**

Create `src/renderer/src/dissect.ts`:

```ts
import type { DataType } from '../../main/store'

// A second, independent implementation of native/src/value_type.h's
// width/signedness rules — a renderer module can't call into the native
// addon's C++ inline functions, so the structure-dissect panel decodes
// here instead. int8 is unsigned (matches value_type.h's UInt8 — the
// width a Mono bool field actually occupies); int16/int32 are signed;
// int64 stays a BigInt rather than widening to a lossy double, since a
// hex viewer showing a raw 64-bit value should not lose precision the way
// value_type.h's InterpretAsDouble deliberately does for scan comparisons;
// float/double are IEEE-754 little-endian. Every width is covered by
// tests/renderer/dissect.test.ts so this can't silently drift from
// value_type.h's rules.
const WIDTH: Record<DataType, number> = {
  int8: 1,
  int16: 2,
  int32: 4,
  int64: 8,
  float: 4,
  double: 8
}

export function decodeAt(
  block: ArrayBuffer,
  offset: number,
  dataType: DataType
): number | bigint | null {
  const width = WIDTH[dataType]
  if (offset < 0 || offset + width > block.byteLength) return null
  const view = new DataView(block)
  switch (dataType) {
    case 'int8':
      return view.getUint8(offset)
    case 'int16':
      return view.getInt16(offset, true)
    case 'int32':
      return view.getInt32(offset, true)
    case 'int64':
      return view.getBigInt64(offset, true)
    case 'float':
      return view.getFloat32(offset, true)
    case 'double':
      return view.getFloat64(offset, true)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/dissect.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/dissect.ts tests/renderer/dissect.test.ts
git commit -m "Add dissect.ts: pure structure-dissect byte decoder"
```

---

### Task 4: `MemoryViewer.tsx` — hex+ASCII grid with live poll and inline byte edit

**Files:**
- Create: `src/renderer/src/screens/MemoryViewer.tsx`
- Modify: `src/renderer/src/App.tsx` (add the `'memory'` screen and mount `MemoryViewer`)
- Modify: `src/renderer/src/components/Sidebar.tsx` (add the nav item)

**Interfaces:**
- Consumes: `window.tamper.readMemoryBlock`/`writeMemoryByte` (Task 2). `App.tsx`'s `Screen` union and lifted-state navigation pattern (`screen`/`setScreen`, exactly as `MonoExplorer`/`Scanner` already use).
- Produces: `MemoryViewer` accepts an optional `initialAddress?: string` prop (consumed by Task 6's entry points) and an `onDone: () => void` callback (mirrors `MonoExplorer`'s/`Scanner`'s existing `onDone` prop shape).

- [ ] **Step 1: Add the screen to `App.tsx` and `Sidebar.tsx`**

In `src/renderer/src/App.tsx`, extend the `Screen` union (line 9) to `'picker' | 'cheats' | 'scanner' | 'mono' | 'memory'`, add a `jumpToAddress` piece of lifted state next to `pendingMonoSelection` (same pattern), and mount the screen:

```ts
const [jumpToAddress, setJumpToAddress] = useState<string | null>(null)
```

```tsx
{screen === 'memory' && exeName && (
  <MemoryViewer
    initialAddress={jumpToAddress ?? undefined}
    onDone={() => setScreen('cheats')}
  />
)}
```

Import `MemoryViewer` alongside the other screen imports (line 4-7) and export a `navigateToMemoryViewer(address: string)` helper by lifting a setter down through props — concretely, pass `onViewInMemory={(address) => { setJumpToAddress(address); setScreen('memory') }}` into `Scanner` and `CheatList` in Task 6; this task only needs `jumpToAddress`/`setScreen` to exist and be wired into `MemoryViewer`'s mount above.

In `src/renderer/src/components/Sidebar.tsx`, add to `NAV_ITEMS` (line 3-8):

```ts
{ screen: 'memory', label: 'Memory Viewer' }
```

- [ ] **Step 2: Implement `MemoryViewer.tsx`**

Create `src/renderer/src/screens/MemoryViewer.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'

const PAGE_SIZE = 256 // 16 bytes/row x 16 rows
const POLL_MS = 250

function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()
  if (!/^(0x)?[0-9a-fA-F]+$/.test(trimmed)) return null
  return trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`
}

export default function MemoryViewer({
  initialAddress,
  onDone
}: {
  initialAddress?: string
  onDone: () => void
}) {
  const [addressInput, setAddressInput] = useState(initialAddress ?? '0x0')
  const [baseAddress, setBaseAddress] = useState<string | null>(
    initialAddress ? normalizeAddress(initialAddress) : null
  )
  const [block, setBlock] = useState<ArrayBuffer | null>(null)
  // The address currently being inline-edited, if any — the poll below
  // skips refetching while this is set, so a half-typed hex value is
  // never stomped by the next tick's refresh.
  const [editingOffset, setEditingOffset] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const editingRef = useRef<number | null>(null)
  editingRef.current = editingOffset

  useEffect(() => {
    if (!baseAddress) return
    let cancelled = false
    async function poll() {
      if (editingRef.current !== null) return
      const result = await window.tamper.readMemoryBlock(baseAddress!, PAGE_SIZE)
      if (!cancelled) setBlock(result)
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
    const next = BigInt(baseAddress) + BigInt(deltaPages * PAGE_SIZE)
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
    await window.tamper.writeMemoryByte(byteAddress, value)
    setEditingOffset(null)
    const refreshed = await window.tamper.readMemoryBlock(baseAddress, PAGE_SIZE)
    setBlock(refreshed)
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
    </div>
  )
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: both clean.

- [ ] **Step 4: Manual verification**

No renderer test harness exists for screen components in this app (consistent with `CheatList.tsx`/`Scanner.tsx`) — verify by hand: attach to `test-harness/harness.exe` (or a real game), navigate to Memory Viewer, type an address, confirm the grid renders and updates every 250ms, click a byte and confirm editing it writes through (check via the harness's `get`/`geti8` stdin commands or a second read), and confirm Prev/Next page move by exactly 256 bytes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/MemoryViewer.tsx src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "Add MemoryViewer screen: live hex+ASCII grid with inline byte edit"
```

---

### Task 5: Structure Dissect panel

**Files:**
- Modify: `src/renderer/src/screens/MemoryViewer.tsx`

**Interfaces:**
- Consumes: `decodeAt` from Task 3, `DataType` from `../../main/store`.

- [ ] **Step 1: Add dissect state and panel to `MemoryViewer.tsx`**

Add near the top of the `MemoryViewer` function, alongside the other `useState` calls:

```tsx
interface DissectRow {
  offset: string // hex, relative to baseAddress
  dataType: DataType
  label: string
}

const [dissectRows, setDissectRows] = useState<DissectRow[]>([])
const [newOffset, setNewOffset] = useState('0x0')
const [newDataType, setNewDataType] = useState<DataType>('int32')
const [newLabel, setNewLabel] = useState('')
```

Add the import at the top of the file:

```ts
import { decodeAt } from '../dissect'
import type { DataType } from '../../../main/store'
```

Add the panel's JSX, after the hex grid's closing `</table>` (still inside the `{baseAddress && bytes && (...)}` block, or as its own sibling conditional guarded the same way):

```tsx
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
```

`dissectRows` is component state only — never sent to `saveCheat`, never read from a profile, and is discarded the moment `MemoryViewer` unmounts, per this plan's Global Constraints.

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: both clean.

- [ ] **Step 3: Manual verification**

Add a dissect row for offset `0x0`, type `int32`, confirm it decodes and updates live as the page refreshes; add an `int64` row and confirm it displays as a full 64-bit value, not a rounded double; add a row whose offset+width exceeds the 256-byte page and confirm it shows "out of range" instead of crashing.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/screens/MemoryViewer.tsx
git commit -m "Add Structure Dissect panel to MemoryViewer"
```

---

### Task 6: Entry points from Scanner and CheatList

**Files:**
- Modify: `src/renderer/src/App.tsx` (pass `onViewInMemory` down)
- Modify: `src/renderer/src/screens/Scanner.tsx` (near `candidates.map` at `src/renderer/src/screens/Scanner.tsx:416-424`)
- Modify: `src/renderer/src/screens/CheatList.tsx` (near the target list rendering at `src/renderer/src/screens/CheatList.tsx:1406-1407`)

**Interfaces:**
- Consumes: `MemoryViewer`'s `initialAddress` prop and `App.tsx`'s `jumpToAddress`/`setScreen` from Task 4.
- Produces: nothing further — this is the plan's last task.

- [ ] **Step 1: Wire `onViewInMemory` through `App.tsx`**

In `App.tsx`, add the callback and pass it to both `Scanner` and `CheatList`:

```tsx
function onViewInMemory(address: string) {
  setJumpToAddress(address)
  setScreen('memory')
}
```

```tsx
<Scanner key={exeName} exeName={exeName} onDone={() => setScreen('cheats')} onViewInMemory={onViewInMemory} />
```

```tsx
<CheatList
  exeName={exeName}
  pendingMonoSelection={pendingMonoSelection}
  onConsumePendingMonoSelection={() => setPendingMonoSelection(null)}
  onViewInMemory={onViewInMemory}
/>
```

- [ ] **Step 2: Add the button to Scanner's candidate rows**

In `src/renderer/src/screens/Scanner.tsx`, add `onViewInMemory: (address: string) => void` to the component's props type, and inside the `candidates.map((c) => { ... })` block (around line 416-424), add next to the existing checkbox:

```tsx
<button onClick={() => onViewInMemory(c.address)}>View in Memory</button>
```

- [ ] **Step 3: Add the button to CheatList's target rows**

In `src/renderer/src/screens/CheatList.tsx`, add `onViewInMemory: (address: string) => void` to the component's props type. Inside `cheat.targets.map((t, i) => (...))` (around line 1406-1407), a `ChainTarget` doesn't carry a resolved absolute address by itself (only `moduleName`/`baseOffset`/`offsets`) — add the button only for the common case where `offsets.length === 0` (the target's own base IS the field, no further dereference), using the already-resolved `baseOffset` relative to that target's module. For `AnchorTarget`/`MonoTarget` or a `ChainTarget` with `offsets.length > 0`, skip the button — resolving those to a live absolute address is outside this task's scope (the target is a chain description, not a snapshot address, and correctly resolving it live would need a round trip through `resolveChain`/Mono resolution this task doesn't add).

```tsx
{!isAnchorTarget(t) && !isMonoTarget(t) && 'offsets' in t && t.offsets.length === 0 && (
  <button onClick={() => onViewInMemory(t.baseOffset)}>View in Memory</button>
)}
```

(`isAnchorTarget`/`isMonoTarget` are already imported from `store.ts` elsewhere in this file — reuse those imports rather than adding new ones.)

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit`
Run: `npm run build`
Expected: both clean.

- [ ] **Step 5: Manual verification**

From the Scanner, run a scan, click "View in Memory" on a candidate, confirm the viewer opens jumped to that address. From the cheat list, click it on a simple (no-offset) target, confirm the same.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/screens/Scanner.tsx src/renderer/src/screens/CheatList.tsx
git commit -m "Add \"View in Memory\" entry points from Scanner and CheatList"
```

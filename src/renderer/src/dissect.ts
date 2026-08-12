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

// Structured-clone over Electron IPC delivers a Node Buffer to the renderer
// as a Uint8Array, never a real ArrayBuffer (see tamper.d.ts's
// readMemoryBlock comment) — and that Uint8Array's byteOffset is not
// guaranteed to be 0. Handing `.buffer` straight to `new DataView` (as
// decodeAt does) would then read from entirely the wrong bytes, or throw if
// the view doesn't happen to span the whole buffer. This slices out exactly
// the view's own bytes into a genuine, independent ArrayBuffer, so every
// caller downstream (decodeAt, the hex grid) can trust what it's holding.
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
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

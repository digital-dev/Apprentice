// The native addon refuses reads over 4096 bytes (it returns null rather
// than a short read; found live on Schedule I, 8192 and up all failed). The
// IL2CPP enumeration reads far larger runs -- the whole class table, a
// class's field array -- so every read goes through this wrapper.
export const MAX_READ_BYTES = 4096

export type ReadFn = (address: string, length: number) => string | null

export function chunkedRead(read: ReadFn, address: string, length: number): string | null {
  const base = BigInt(address)
  let out = ''
  for (let done = 0; done < length; done += MAX_READ_BYTES) {
    const size = Math.min(MAX_READ_BYTES, length - done)
    const chunk = read('0x' + (base + BigInt(done)).toString(16), size)
    if (chunk === null) return null
    out += chunk
  }
  return out
}

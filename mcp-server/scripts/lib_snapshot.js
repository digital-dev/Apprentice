// Offline snapshot reader for the scripts (mirrors src/main/replay/snapshotFile.ts).
const fs = require('node:fs')
const zlib = require('node:zlib')

function loadSnapshot(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file))
  const headerLength = raw.readUInt32LE(0)
  const header = JSON.parse(raw.subarray(4, 4 + headerLength).toString('utf8'))
  let at = 4 + headerLength
  const regions = header.regions.map((r) => {
    at += r.preLength
    const bytes = raw.subarray(at, at + r.length)
    at += r.length + r.postLength
    return { base: BigInt(r.base), bytes }
  })
  return { ...header, regions }
}

// Yields [address(BigInt), rel32 target(BigInt), reg, rex] for every REX.W `mov reg,[rip+rel32]`
// and `lea reg,[rip+rel32]`.
function* ripRefs(snap) {
  for (const r of snap.regions) {
    const b = r.bytes
    for (let i = 0; i + 7 <= b.length; i++) {
      const rex = b[i]
      if (rex !== 0x48 && rex !== 0x4c) continue
      const op = b[i + 1]
      if (op !== 0x8b && op !== 0x8d) continue
      const modrm = b[i + 2]
      if ((modrm & 0xc7) !== 0x05) continue
      const addr = r.base + BigInt(i)
      yield { addr, target: addr + 7n + BigInt(b.readInt32LE(i + 3)), reg: ((modrm >> 3) & 7) | ((rex & 4) << 1), lea: op === 0x8d }
    }
  }
}

function readAt(snap, addr, len) {
  for (const r of snap.regions) {
    if (addr >= r.base && addr + BigInt(len) <= r.base + BigInt(r.bytes.length)) {
      const o = Number(addr - r.base)
      return r.bytes.subarray(o, o + len)
    }
  }
  return null
}

module.exports = { loadSnapshot, ripRefs, readAt }

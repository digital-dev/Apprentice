// Offline: for a static flag/global at <rva>, find code that reads it and grow a wildcarded,
// snapshot-unique signature whose first instruction's rip-relative operand resolves to it.
// usage: node deriveFlagRoot.js <snapshot> <moduleBase> <rva>
// prints: signature | rel32At | instrLen | the site's RVA
const path = require('node:path')
const { loadSnapshot, readAt } = require('./lib_snapshot')
const raw = require(path.resolve(__dirname, '../../native/build/Release/memory_addon.node'))
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, rvaArg] = process.argv.slice(2)
const snap = loadSnapshot(file)
const B = BigInt(base), target = B + BigInt(rvaArg)
const regions = snap.regions.map((r) => ({ base: '0x' + r.base.toString(16), bytes: r.bytes }))

// Positions of the 4-byte rip-relative field in an instruction, found by matching the printed absolute target.
function wildcardMask(row, bytes) {
  const mask = new Array(bytes.length).fill(false)
  const m = /0x0000([0-9A-F]{12})/.exec(row.text)
  if (!m) return mask
  const abs = BigInt('0x' + m[1])
  const end = BigInt(row.address) + BigInt(row.length)
  for (const imm of [0n, 1n, 2n, 4n]) {
    const rel = Number(abs - (end - imm))
    if (rel < -0x80000000 || rel > 0x7fffffff) continue
    for (let i = 0; i + 4 <= bytes.length; i++) if (bytes.readInt32LE(i) === rel) { for (let k = 0; k < 4; k++) mask[i + k] = true; return mask }
  }
  return mask
}

const sites = []
for (const r of snap.regions) {
  const b = r.bytes
  for (let i = 0; i + 7 <= b.length; i++) {
    // only forms with rel32 at +3 and length 7 (movzx r32,byte [rip+rel]; mov/lea r64,[rip+rel]) so the factory's root model applies
    const isMovzx = b[i] === 0x0f && (b[i + 1] === 0xb6 || b[i + 1] === 0xbe) && (b[i + 2] & 0xc7) === 0x05
    const isMov64 = (b[i] === 0x48 || b[i] === 0x4c) && (b[i + 1] === 0x8b || b[i + 1] === 0x8d) && (b[i + 2] & 0xc7) === 0x05
    if (!isMovzx && !isMov64) continue
    const at = r.base + BigInt(i)
    if (at + 7n + BigInt(b.readInt32LE(i + 3)) === target) sites.push(at)
  }
}
console.error(`${sites.length} candidate sites`)
for (const site of sites) {
  const bytes = readAt(snap, site, 160)
  if (!bytes) continue
  const rows = a.disassembleBuffer(Buffer.from(bytes), '0x' + site.toString(16), 24)
  let sig = [], used = 0
  for (const row of rows) {
    const rb = bytes.subarray(used, used + row.length)
    const mask = wildcardMask(row, rb)
    for (let i = 0; i < rb.length; i++) sig.push(mask[i] ? '??' : rb[i].toString(16).padStart(2, '0'))
    used += row.length
    if (used < 12) continue
    const text = sig.join(' ')
    const hits = raw.snapshotScanAob(regions, text)
    if (hits.length === 1) { console.log(`${text} | 3 | 7 | 0x${(site - B).toString(16)}`); process.exit(0) }
    if (hits.length === 0) break
  }
}
console.log('NONE')
process.exit(1)

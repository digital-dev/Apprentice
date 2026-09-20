// Offline+live: which byte flags in an RVA window does the code read, and how often?
// usage: node flagXrefs.js <snapshot> <moduleBase> <rvaStart> <rvaEnd> [pid module]   (pid/module: also print live byte values)
const path = require('node:path')
const { loadSnapshot } = require('./lib_snapshot')
const [file, base, s, e, pid, mod] = process.argv.slice(2)
const snap = loadSnapshot(file)
const B = BigInt(base), lo = B + BigInt(s), hi = B + BigInt(e)
const uses = new Map()
for (const r of snap.regions) {
  const b = r.bytes
  for (let i = 0; i + 8 <= b.length; i++) {
    let len = 0, rel = 0
    // cmp/test/mov/and/or byte [rip+rel32], imm8  : 80 3D rel8..  |  C6 05 rel32 imm8 | 80 25/0D/35 ...
    if ((b[i] === 0x80 && (b[i + 1] & 0xc7) === 0x05) || (b[i] === 0xc6 && b[i + 1] === 0x05)) { len = 6; rel = b.readInt32LE(i + 2) }
    else if ((b[i] === 0x0f && (b[i + 1] === 0xb6 || b[i + 1] === 0xbe) && (b[i + 2] & 0xc7) === 0x05)) { len = 7; rel = b.readInt32LE(i + 3) }
    else if (b[i] === 0x8a && (b[i + 1] & 0xc7) === 0x05) { len = 6; rel = b.readInt32LE(i + 2) }
    else continue
    const at = r.base + BigInt(i)
    // rel32 is relative to the end of the whole instruction; imm8 forms are 1 byte longer than the encoded head.
    const imm = (b[i] === 0x80 || b[i] === 0xc6) ? 1 : 0
    const target = at + BigInt(len + imm) + BigInt(rel)
    if (target < lo || target >= hi) continue
    const k = '0x' + (target - B).toString(16)
    const arr = uses.get(k) || []
    arr.push('0x' + (at - B).toString(16) + ':' + b.subarray(i, i + len + imm).toString('hex'))
    uses.set(k, arr)
  }
}
let live = null
if (pid) {
  const a = require(path.resolve(__dirname, '../dist/addon.js'))
  const { handle } = a.attach(Number(pid))
  const m = a.listModules(handle).find((x) => x.name === mod)
  live = (k) => a.tryReadBytes(handle, '0x' + (BigInt(m.base) + BigInt(k)).toString(16), 1)
}
for (const [k, v] of [...uses].sort((x, y) => Number(BigInt(x[0]) - BigInt(y[0])))) console.log(k, 'uses', v.length, live ? 'live=' + live(k) : '', v.slice(0, 2).join(' '))

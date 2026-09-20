// Offline: per debug flag byte, show its real consumers (not the sync loop, not the assertion preamble).
// usage: node flagReport.js <snapshot> <moduleBase> <rvaStart> <rvaEnd> [lines=12]
const path = require('node:path')
const { loadSnapshot, readAt } = require('./lib_snapshot')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, s, e, linesArg = '12'] = process.argv.slice(2)
const snap = loadSnapshot(file), B = BigInt(base), lo = B + BigInt(s), hi = B + BigInt(e)
const sites = new Map()
for (const r of snap.regions) {
  const b = r.bytes
  for (let i = 0; i + 8 <= b.length; i++) {
    let len = 0, rel = 0, imm = 0
    if ((b[i] === 0x80 && (b[i + 1] & 0xc7) === 0x05) || (b[i] === 0xc6 && b[i + 1] === 0x05)) { len = 6; imm = 1; rel = b.readInt32LE(i + 2) }
    else if (b[i] === 0x0f && (b[i + 1] === 0xb6 || b[i + 1] === 0xbe) && (b[i + 2] & 0xc7) === 0x05) { len = 7; rel = b.readInt32LE(i + 3) }
    else if (b[i] === 0x8a && (b[i + 1] & 0xc7) === 0x05) { len = 6; rel = b.readInt32LE(i + 2) }
    else if (b[i] === 0x88 && (b[i + 1] & 0xc7) === 0x05) { len = 6; rel = b.readInt32LE(i + 2) }
    else continue
    const at = r.base + BigInt(i), t = at + BigInt(len + imm) + BigInt(rel)
    if (t < lo || t >= hi) continue
    const k = t; (sites.get(k) || sites.set(k, []).get(k)).push(at)
  }
}
function trace(pc, max) {
  const out = []
  let n = 0
  while (n < max) {
    const bytes = readAt(snap, pc, 16); if (!bytes) break
    const row = a.disassembleBuffer(Buffer.from(bytes), '0x' + pc.toString(16), 1)[0]; if (!row) break
    const txt = row.text.replace(/0x0000([0-9A-F]{12})/g, (m, h) => { const v = BigInt('0x' + h) - B; return v > 0n && v < 0x6000000n ? 'RVA:0x' + v.toString(16) : m })
    const jm = /^jmp 0x0000([0-9A-F]{12})$/.exec(row.text)
    if (jm) { pc = BigInt('0x' + jm[1]); continue }
    out.push('0x' + (pc - B).toString(16) + ' ' + txt)
    if (/^(ret|int3)/.test(row.text)) break
    pc += BigInt(row.length); n++
  }
  return out
}
const NOISE = /3d66198|3d5ade8|1ec13e0|3292b38|29c7aa0|1eb97a0|mov edx, 0xB4|mov r9, rax$/
for (const [t, list] of [...sites].sort((x, y) => Number(x[0] - y[0]))) {
  console.log(`##### flag 0x${(t - B).toString(16)}`)
  let shown = 0
  for (const at of list) {
    const tr = trace(at, Number(linesArg) + 8)
    if (tr.some((l, i) => i > 0 && i < 6 && /^\S+ mov \[RVA:0x[0-9a-f]+\], al/.test(l))) continue // sync loop
    console.log('  @' + '0x' + (at - B).toString(16))
    for (const l of tr.filter((l) => !NOISE.test(l)).slice(0, Number(linesArg))) console.log('    ' + l)
    if (++shown >= 3) break
  }
}

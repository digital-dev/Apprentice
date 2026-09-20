// Offline: disassemble from an RVA following unconditional jmps (undoes control-flow scrambling).
// usage: node traceSnap.js <snapshot> <moduleBase> <rva> [maxInstr=60]
const path = require('node:path')
const { loadSnapshot, readAt } = require('./lib_snapshot')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, rva, maxArg = '60'] = process.argv.slice(2)
const snap = loadSnapshot(file)
const B = BigInt(base)
let pc = B + BigInt(rva), n = 0
const seen = new Set()
while (n < Number(maxArg)) {
  const bytes = readAt(snap, pc, 16)
  if (!bytes) { console.log('-- left snapshot at', '0x' + (pc - B).toString(16)); break }
  const row = a.disassembleBuffer(Buffer.from(bytes), '0x' + pc.toString(16), 1)[0]
  if (!row) break
  const rv = '0x' + (pc - B).toString(16)
  const jmp = /^jmp 0x0000([0-9A-F]{12})$/.exec(row.text)
  if (jmp) { const t = BigInt('0x' + jmp[1]); console.log(rv.padEnd(10), row.text.replace(/0x0000([0-9A-F]{12})/, (m, h) => 'RVA:0x' + (BigInt('0x' + h) - B).toString(16))); if (seen.has(t)) break; seen.add(t); pc = t; n++; continue }
  console.log(rv.padEnd(10), row.text.replace(/0x0000([0-9A-F]{12})/, (m, h) => { const v = BigInt('0x' + h) - B; return v > 0n && v < 0x6000000n ? 'RVA:0x' + v.toString(16) : m }))
  if (/^(ret|int3)/.test(row.text)) break
  pc += BigInt(row.length); n++
}

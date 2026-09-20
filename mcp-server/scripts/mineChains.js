// Offline: from every load of a static root, follow register-held pointers through
// [reg+disp] loads and report the offset chains the code really uses, by frequency.
// usage: node mineChains.js <snapshot> <moduleBase> <rva[,rva...]> [minCount]
const path = require('node:path')
const { loadSnapshot, ripRefs, readAt } = require('./lib_snapshot')
const addon = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, rvas, minArg = '3'] = process.argv.slice(2)
const snap = loadSnapshot(file)
const roots = new Map(rvas.split(',').map((r) => [BigInt(base) + BigInt(r), r]))
const MEM = /\[(r[a-z0-9]+)(?:\+(0x[0-9A-Fa-f]+))?\]/
const MOV64 = /^mov (r[a-z0-9]+), \[/
const R64 = /^r(ax|bx|cx|dx|si|di|bp|sp|8|9|1[0-5])$/

const chains = new Map() // "root>d1>d2 [leafkind]" -> count
const bump = (k) => chains.set(k, (chains.get(k) || 0) + 1)

for (const ref of ripRefs(snap)) {
  const rva = roots.get(ref.target)
  if (!rva || ref.lea) continue
  const bytes = readAt(snap, ref.addr, 96)
  if (!bytes) continue
  const rows = addon.disassembleBuffer(Buffer.from(bytes), '0x' + ref.addr.toString(16), 14)
  const dst = /^mov (r[a-z0-9]+),/.exec(rows[0].text)
  if (!dst) continue
  const tracked = new Map([[dst[1], [rva]]])
  for (const row of rows.slice(1)) {
    const m = MEM.exec(row.text)
    const written = /^(?:mov|lea|xor|pop) (r[a-z0-9]+),/.exec(row.text)
    if (m && tracked.has(m[1])) {
      const chain = [...tracked.get(m[1]), m[2] || '0x0']
      const mv = MOV64.exec(row.text)
      if (mv && R64.test(mv[1]) && row.text.indexOf('[') > row.text.indexOf(',')) {
        tracked.set(mv[1], chain) // pointer hop
        bump(chain.join('>') + ' hop')
        continue
      }
      bump(chain.join('>') + ' ' + row.text.split(' ')[0] + (/dword|word|byte|xmm|e[a-z]{2}|r\d+d/.test(row.text) ? ' small' : ''))
    }
    if (written && tracked.has(written[1]) && !(m && tracked.has(m[1]))) tracked.delete(written[1])
    if (/^(ret|jmp|call)/.test(row.text)) break
  }
}
const min = Number(minArg)
for (const [k, v] of [...chains].filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).slice(0, 200)) console.log(String(v).padStart(4), k)

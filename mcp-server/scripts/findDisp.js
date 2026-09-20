// Offline: every instruction whose memory operand is [reg+disp32==DISP] (any opcode, incl. SSE), with its RVA.
// usage: node findDisp.js <snapshot> <moduleBase> <disp>
const path = require('node:path')
const { loadSnapshot } = require('./lib_snapshot')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, dispArg] = process.argv.slice(2)
const snap = loadSnapshot(file), B = BigInt(base), d = Number(dispArg)
const pat = Buffer.alloc(4); pat.writeInt32LE(d)
const want = '0x' + d.toString(16).toUpperCase() + ']'
const seen = new Set()
for (const r of snap.regions) {
  const b = r.bytes
  let j = b.indexOf(pat)
  while (j >= 0) {
    for (let back = 3; back <= 8 && j - back >= 0; back++) {
      const start = j - back
      const row = a.disassembleBuffer(Buffer.from(b.subarray(start, start + 15)), '0x' + (r.base + BigInt(start)).toString(16), 1)[0]
      if (row && row.text.includes(want) && row.length >= back + 4) {
        const rva = '0x' + (r.base + BigInt(start) - B).toString(16)
        if (!seen.has(rva)) { seen.add(rva); console.log(rva.padEnd(11), row.text) }
        break
      }
    }
    j = b.indexOf(pat, j + 1)
  }
}

// Offline: disassemble around an RVA in a snapshot.  usage: node disSnap.js <snapshot> <moduleBase> <rva> [before=24] [after=64]
const path = require('node:path')
const { loadSnapshot, readAt } = require('./lib_snapshot')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, rva, before = '24', after = '64'] = process.argv.slice(2)
const snap = loadSnapshot(file)
const start = BigInt(base) + BigInt(rva) - BigInt(before)
const bytes = readAt(snap, start, Number(before) + Number(after))
if (!bytes) { console.log('not in snapshot'); process.exit(1) }
for (const r of a.disassembleBuffer(Buffer.from(bytes), '0x' + start.toString(16), 40)) console.log('0x' + (BigInt(r.address) - BigInt(base)).toString(16), r.text)

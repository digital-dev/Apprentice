// Read-only: dump float32 fields near 1.0 (0.05..8) of a struct reached by a pointer chain.
// usage: node dumpFloats.js <pid> <module> <rva> <length> <offsets,...>   (each offset: deref then add; the LAST result is the struct base after one more deref unless 'raw:' prefix)
const path = require('node:path')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [pid, mod, rva, len, offs = ''] = process.argv.slice(2)
const { handle } = a.attach(Number(pid))
const m = a.listModules(handle).find((x) => x.name === mod)
const q = (addr) => { const h = a.tryReadBytes(handle, '0x' + addr.toString(16), 8); return h ? Buffer.from(h, 'hex').readBigUInt64LE(0) : null }
let p = BigInt(m.base) + BigInt(rva)
for (const o of offs.split(',').filter(Boolean)) { p = q(p); if (p === null) { console.log('chain broke'); process.exit(1) } p += BigInt(o) }
p = q(p)
const parts = []
for (let o = 0; o < Number(len); o += 0x800) { const h = a.tryReadBytes(handle, '0x' + (p + BigInt(o)).toString(16), 0x800); parts.push(h ? Buffer.from(h, 'hex') : Buffer.alloc(0x800)) }
const bytes = Buffer.concat(parts)
console.log('struct 0x' + p.toString(16))
for (let i = 0; i + 4 <= bytes.length; i += 4) { const f = bytes.readFloatLE(i); if (f >= 0.05 && f <= 8 && Number.isFinite(f)) console.log('0x' + i.toString(16), f) }
a.detach && a.detach(handle)

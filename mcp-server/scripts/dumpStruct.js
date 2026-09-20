// Read-only: dump a struct reached through a pointer chain as int32 values.
// usage: node dumpStruct.js <pid> <moduleName> <rva> <length> [offset,offset,...]   (each offset derefs then adds)
const path = require('node:path')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [pid, mod, rva, len, offs = ''] = process.argv.slice(2)
const { handle } = a.attach(Number(pid))
const m = a.listModules(handle).find((x) => x.name === mod)
const q = (addr) => { const h = a.tryReadBytes(handle, '0x' + addr.toString(16), 8); return h ? Buffer.from(h, 'hex').readBigUInt64LE(0) : null }
let p = q(BigInt(m.base) + BigInt(rva))
for (const o of offs.split(',').filter(Boolean)) { if (p === null) break; p = q(p + BigInt(o)) }
if (p === null) { console.log('chain broke'); process.exit(1) }
const h = a.tryReadBytes(handle, '0x' + p.toString(16), Number(len))
const b = Buffer.from(h, 'hex')
console.log('struct at 0x' + p.toString(16))
let out = ''
for (let i = 0; i + 4 <= b.length; i += 4) { out += `0x${i.toString(16)}=${b.readInt32LE(i)} `; if (i % 32 === 28) out += '\n' }
console.log(out)
a.detach && a.detach(handle)

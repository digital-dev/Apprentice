// Live, reversible: set one bit/byte for N seconds so the user can observe it, then restore the original.
// usage: node flagLab.js <pid> <module> <rva> <offsets,comma|-> <bit|-> <seconds>
// offsets walk like a Tamper chain (deref each, the last one is added, not dereferenced). "-" = none.
const path = require('node:path')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [pid, mod, rva, offs, bitArg, secs] = process.argv.slice(2)
const { handle } = a.attach(Number(pid))
const m = a.listModules(handle).find((x) => x.name === mod)
const q = (addr) => { const h = a.tryReadBytes(handle, '0x' + addr.toString(16), 8); return h ? Buffer.from(h, 'hex').readBigUInt64LE(0) : null }
let p = BigInt(m.base) + BigInt(rva)
const list = offs === '-' ? [] : offs.split(',')
for (const off of list) { p = q(p); if (p === null) { console.log('chain broke'); process.exit(1) } p += BigInt(off) }
const addr = '0x' + p.toString(16)
const orig = a.tryReadBytes(handle, addr, 1)
const val = parseInt(orig, 16)
const bit = bitArg === '-' ? null : Number(bitArg)
const set = bit === null ? 1 : (val | (1 << bit))
console.log(`addr ${addr} orig 0x${orig} -> 0x${set.toString(16)} for ${secs}s`)
a.writeBytes(handle, addr, set.toString(16).padStart(2, '0'))
const end = Date.now() + Number(secs) * 1000
const keep = setInterval(() => { const cur = parseInt(a.tryReadBytes(handle, addr, 1) || '00', 16); if (bit === null ? cur !== set : !(cur & (1 << bit))) a.writeBytes(handle, addr, set.toString(16).padStart(2, '0')) }, 100)
setTimeout(() => { clearInterval(keep); a.writeBytes(handle, addr, orig); console.log('restored 0x' + orig, 'now', a.tryReadBytes(handle, addr, 1)) ; process.exit(0) }, Number(secs) * 1000)

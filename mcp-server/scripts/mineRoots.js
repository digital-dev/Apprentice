// Offline: find every code site that loads a static root and print what follows.
// usage: node mineRoots.js <snapshot> <moduleBase> <rva[,rva...]> [followBytes]
const { loadSnapshot, ripRefs, readAt } = require('./lib_snapshot')
const [file, base, rvas, follow = '40'] = process.argv.slice(2)
const snap = loadSnapshot(file)
const want = new Map(rvas.split(',').map((r) => [BigInt(base) + BigInt(r), r]))
let n = 0
for (const ref of ripRefs(snap)) {
  const rva = want.get(ref.target)
  if (!rva) continue
  n++
  const bytes = readAt(snap, ref.addr, Number(follow))
  console.log(rva, '0x' + (ref.addr - BigInt(base)).toString(16), ref.lea ? 'lea' : 'mov', 'reg' + ref.reg, bytes ? bytes.toString('hex') : '?')
}
console.error('refs', n)

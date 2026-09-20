// Offline: find call/jmp rel32 sites targeting given RVAs.  usage: node findCallersSnap.js <snapshot> <moduleBase> <rva,rva,...>
const { loadSnapshot } = require('./lib_snapshot')
const [file, base, rvas] = process.argv.slice(2)
const snap = loadSnapshot(file)
const B = BigInt(base)
const want = new Map(rvas.split(',').map((r) => [B + BigInt(r), r]))
for (const r of snap.regions) {
  const b = r.bytes
  for (let i = 0; i + 5 <= b.length; i++) {
    if (b[i] !== 0xe8 && b[i] !== 0xe9) continue
    const t = r.base + BigInt(i) + 5n + BigInt(b.readInt32LE(i + 1))
    const w = want.get(t)
    if (w) console.log(w, b[i] === 0xe8 ? 'call' : 'jmp ', '0x' + (r.base + BigInt(i) - B).toString(16))
  }
}

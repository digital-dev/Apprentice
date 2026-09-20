// Offline: link the game's debug-flag NAME strings to the flag bytes they are registered with.
// The exe on disk supplies the strings (UTF-16) and section map; the snapshot supplies the code that references them.
// usage: node nameFlags.js <exe> <snapshot> <moduleBase> <flagRvaStart> <flagRvaEnd> <nameSubstring,...>
const fs = require('node:fs')
const { loadSnapshot, readAt } = require('./lib_snapshot')
const [exe, file, base, fs0, fe0, wordsArg] = process.argv.slice(2)
const b = fs.readFileSync(exe)
const pe = b.readUInt32LE(0x3c), nSec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20)
const secs = []
for (let i = 0; i < nSec; i++) { const o = pe + 24 + optSize + i * 40; secs.push({ va: b.readUInt32LE(o + 12), raw: b.readUInt32LE(o + 20), rawSize: b.readUInt32LE(o + 16) }) }
const toRva = (fo) => { const s = secs.find((s) => fo >= s.raw && fo < s.raw + s.rawSize); return s ? s.va + (fo - s.raw) : null }
// every UTF-16 string starting with GameData./Game./GameRule. in the name area
const names = []
let cur = '', start = 0
for (let i = 0x2be9e00; i < 0x2beb200; i += 2) {
  const c = b.readUInt16LE(i)
  if (c >= 32 && c < 127) { if (!cur) start = i; cur += String.fromCharCode(c) } else { if (cur.length >= 6 && /^(GameData|Game|GameRule)\./.test(cur)) names.push({ name: cur, rva: toRva(start) }); cur = '' }
}
const snap = loadSnapshot(file), B = BigInt(base)
const lo = B + BigInt(fs0), hi = B + BigInt(fe0)
const wants = new Map(names.map((n) => [B + BigInt(n.rva), n.name]))
const flagRefs = []   // every rip-rel lea/mov/cmp/etc into the flag window, with position
const nameRefs = []
for (const r of snap.regions) {
  const bb = r.bytes
  for (let i = 0; i + 7 <= bb.length; i++) {
    if ((bb[i] === 0x48 || bb[i] === 0x4c) && bb[i + 1] === 0x8d && (bb[i + 2] & 0xc7) === 0x05) {
      const at = r.base + BigInt(i), t = at + 7n + BigInt(bb.readInt32LE(i + 3))
      if (wants.has(t)) nameRefs.push({ at, name: wants.get(t) })
      if (t >= lo && t < hi) flagRefs.push({ at, t })
    }
  }
}
const path = require('node:path')
const disasm = require(path.resolve(__dirname, '../dist/addon.js'))
function follow(pc, max) {
  const out = []
  for (let n = 0; n < max; n++) {
    const bytes = readAt(snap, pc, 16); if (!bytes) break
    const row = disasm.disassembleBuffer(Buffer.from(bytes), '0x' + pc.toString(16), 1)[0]; if (!row) break
    const jm = /^jmp 0x0000([0-9A-F]{12})$/.exec(row.text)
    if (jm) { pc = BigInt('0x' + jm[1]); continue }
    out.push({ pc, text: row.text })
    if (/^(ret|int3)/.test(row.text)) break
    pc += BigInt(row.length)
  }
  return out
}
const absOf = (text, re) => { const m = re.exec(text); return m ? BigInt('0x' + m[1]) : null }
// 1. flag -> thunk: `movzx ecx, byte [flag]` followed (through jmps) by `call thunk` then `mov [flag], al`
const flagToThunk = new Map()
for (const r of snap.regions) {
  const bb = r.bytes
  for (let i = 0; i + 7 <= bb.length; i++) {
    if (bb[i] !== 0x0f || bb[i + 1] !== 0xb6 || bb[i + 2] !== 0x0d) continue
    const at = r.base + BigInt(i), t = at + 7n + BigInt(bb.readInt32LE(i + 3))
    if (t < lo || t >= hi) continue
    const tr = follow(at, 6)
    const call = tr.find((x) => /^call 0x0000/.test(x.text))
    const store = tr.find((x) => /^mov \[0x0000[0-9A-F]{12}\], al$/.test(x.text))
    if (!call || !store) continue
    const sf = absOf(store.text, /\[0x0000([0-9A-F]{12})\]/)
    if (sf !== t) continue
    flagToThunk.set(t, absOf(call.text, /^call 0x0000([0-9A-F]{12})/))
  }
}
// 2. thunk -> name: the thunk (through jmps) loads the name string with `lea rdx, [name]`
const nameOf = (thunk) => {
  for (const x of follow(thunk, 60)) {
    const m = /^lea r[a-z0-9]+, \[0x0000([0-9A-F]{12})\]/.exec(x.text)
    if (m && wants.has(BigInt('0x' + m[1]))) return wants.get(BigInt('0x' + m[1]))
  }
  return null
}
for (const [f, t] of [...flagToThunk].sort((x, y) => Number(x[0] - y[0]))) console.log('0x' + (f - B).toString(16), '0x' + (t - B).toString(16).padEnd(9), nameOf(t) || '-')
console.error(flagToThunk.size, 'flags mapped to thunks;', names.length, 'names')

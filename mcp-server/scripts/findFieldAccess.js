// Offline: find instructions that touch [reg+disp] for given displacements (byte ops with an imm mask: test/and/or/cmp/mov).
// usage: node findFieldAccess.js <snapshot> <moduleBase> <disp,disp,...>
// Prints per (disp, form, mask) counts and the first sites. Uses the disassembler on a window around each byte-pattern hit.
const path = require('node:path')
const { loadSnapshot } = require('./lib_snapshot')
const a = require(path.resolve(__dirname, '../dist/addon.js'))
const [file, base, dispArg] = process.argv.slice(2)
const snap = loadSnapshot(file)
const disps = dispArg.split(',').map((d) => Number(d))
const found = []
for (const r of snap.regions) {
  const b = r.bytes
  for (let i = 0; i + 8 <= b.length; i++) {
    for (const d of disps) {
      // ModRM with disp32 (mod=10): [reg+disp32]; disp bytes little-endian right after modrm (no SIB) or after SIB
      const lo = d & 0xff, hi = (d >> 8) & 0xff
      for (const sib of [0, 1]) {
        const at = i + 2 + sib
        if (b[at] === lo && b[at + 1] === hi && b[at + 2] === 0 && b[at + 3] === 0 && (b[i + 1] & 0xc0) === 0x80 && (sib === 0 ? (b[i + 1] & 7) !== 4 : (b[i + 1] & 7) === 4)) {
          // candidate opcode at i; accept common byte/dword forms
          const op = b[i]
          if ([0xf6, 0x80, 0xc6, 0x0f, 0x8a, 0x88, 0x84, 0xf7, 0x83, 0x81, 0x8b, 0x89, 0x0a, 0x08, 0x38, 0x3a].includes(op)) found.push({ addr: r.base + BigInt(i), d })
        }
      }
    }
  }
}
const rows = []
for (const f of found) {
  const off = 0
  const r = snap.regions.find((x) => f.addr >= x.base && f.addr < x.base + BigInt(x.bytes.length))
  const o = Number(f.addr - r.base)
  const d = a.disassembleBuffer(Buffer.from(r.bytes.subarray(o, o + 12)), '0x' + f.addr.toString(16), 1)[0]
  if (d && d.text.includes('0x' + f.d.toString(16).toUpperCase() + ']')) rows.push({ rva: '0x' + (f.addr - BigInt(base)).toString(16), text: d.text, d: f.d })
}
const byKey = new Map()
for (const r of rows) {
  const k = r.text.replace(/\[r[a-z0-9]+/, '[R').replace(/^(\w+) (byte ptr|dword ptr)?/, '$1 $2')
  const arr = byKey.get(k) || []; arr.push(r.rva); byKey.set(k, arr)
}
for (const [k, v] of [...byKey].sort((x, y) => y[1].length - x[1].length)) console.log(String(v.length).padStart(3), k, v.slice(0, 3).join(' '))

// Mono: which methods of these classes touch these field offsets? Compiles each method (the game would JIT it anyway),
// disassembles the body up to its padding, and prints the instructions whose memory operand is one of the offsets.
// usage: node monoReaders.js <pid> "<classRegex>" <offset,offset,...>     e.g. PlaneContainer 0x74,0x6c
const path = require('node:path')
const root = path.resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const raw = require(path.resolve(__dirname, '../../native/build/Release/memory_addon.node'))
const { classifyEngine } = require(root + '/engineFingerprint.js')
const [pid, re, offs] = process.argv.slice(2)
const classRe = new RegExp(re)
const needles = offs.split(',').map((o) => '+0x' + o.replace(/^0x/, '').toUpperCase() + ']')
const { handle } = addon.attach(Number(pid))
const mono = classifyEngine(addon.listModules(handle)).monoDllBase
;(async () => {
  const images = (await addon.monoListAssemblyNames(handle, mono)).filter((a) => /^Assembly-CSharp/i.test(a.name))
  for (const image of images) {
    for (const c of await addon.monoListClassesInImage(handle, mono, image.image)) {
      if (c.namespaceName !== '' || !classRe.test(c.className)) continue
      for (const m of await addon.monoListMethodNames(handle, mono, c.classHandle)) {
        if (m === '.cctor') continue
        let addr
        try { addr = await raw.monoCompileMethod(handle, mono, c.classHandle, m) } catch { continue }
        if (!addr || addr === '0x0') continue
        let hex = ''
        for (let o = 0; o < 0x800; o += 0x400) { const h = addon.tryReadBytes(handle, '0x' + (BigInt(addr) + BigInt(o)).toString(16), 0x400); if (!h) break; hex += h }
        let body = Buffer.from(hex, 'hex')
        // Methods end at int3 padding or, for tiny packed accessors, a run of zero bytes.
        const pads = [body.indexOf(Buffer.from('cccccc', 'hex')), body.indexOf(Buffer.alloc(8))].filter((i) => i > 0)
        if (pads.length) body = body.subarray(0, Math.min(...pads))
        let rows = addon.disassembleBuffer(body, addr, 400)
        // Small accessors are packed back to back without padding: end the method at a ret that is followed by a new prologue.
        const cut = rows.findIndex((r, i) => i > 0 && /^ret/.test(rows[i - 1].text) && /^(sub rsp|push r|mov \[rsp\])/.test(r.text))
        if (cut > 0) rows = rows.slice(0, cut)
        if (process.env.CALLEE) {
          const want = process.env.CALLEE.toLowerCase().replace(/^0x/, '')
          const hit = rows.filter((r) => /^mov r11, 0x/.test(r.text) && r.text.toLowerCase().endsWith(want))
          if (hit.length) console.log(`${c.className}.${m}  @${addr}  calls ${process.env.CALLEE} x${hit.length}`)
          continue
        }
        const ctx = Number(process.env.CONTEXT || 0)
        const idx = rows.map((r, i) => (needles.some((n) => r.text.includes(n)) ? i : -1)).filter((i) => i >= 0)
        if (idx.length) {
          console.log(`${c.className}.${m}  @${addr}`)
          for (const i of idx) { for (let k = Math.max(0, i - ctx); k < i; k++) console.log('       ', rows[k].text); console.log('    >>', rows[i].text) }
        }
      }
    }
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

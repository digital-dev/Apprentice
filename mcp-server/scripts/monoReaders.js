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
        const pad = body.indexOf(Buffer.from('cccccc', 'hex'))
        if (pad > 0) body = body.subarray(0, pad)
        const hits = addon.disassembleBuffer(body, addr, 400).filter((r) => needles.some((n) => r.text.includes(n)))
        if (hits.length) { console.log(`${c.className}.${m}  @${addr}`); for (const h of hits) console.log('    ', h.text) }
      }
    }
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

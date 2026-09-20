// Mono: compile one method and print its disassembly (cut at the next method's prologue).
// usage: node monoDisasm.js <pid> <Class> <method> [maxRows=120]
const path = require('node:path')
const addon = require(path.resolve(__dirname, '../dist/addon.js'))
const raw = require(path.resolve(__dirname, '../../native/build/Release/memory_addon.node'))
const { classifyEngine } = require(path.resolve(__dirname, '../dist/engineFingerprint.js'))
const [pid, cls, method, maxArg = '120'] = process.argv.slice(2)
const { handle } = addon.attach(Number(pid))
const mono = classifyEngine(addon.listModules(handle)).monoDllBase
;(async () => {
  for (const image of (await addon.monoListAssemblyNames(handle, mono)).filter((a) => /^Assembly-CSharp/i.test(a.name))) {
    for (const c of await addon.monoListClassesInImage(handle, mono, image.image)) {
      if (c.namespaceName !== '' || c.className !== cls) continue
      const addr = await raw.monoCompileMethod(handle, mono, c.classHandle, method)
      let hex = ''
      for (let o = 0; o < 0x1000; o += 0x400) { const h = addon.tryReadBytes(handle, '0x' + (BigInt(addr) + BigInt(o)).toString(16), 0x400); if (!h) break; hex += h }
      let full = Buffer.from(hex, 'hex')
      const pads = [full.indexOf(Buffer.from('cccccc', 'hex')), full.indexOf(Buffer.alloc(8))].filter((i) => i > 0)
      if (pads.length) full = full.subarray(0, Math.min(...pads))
      let rows = addon.disassembleBuffer(full, addr, 600)
      const cut = rows.findIndex((r, i) => i > 3 && /^ret/.test(rows[i - 1].text) && /^(sub rsp|push r|mov \[rsp\])/.test(r.text))
      if (cut > 0) rows = rows.slice(0, cut)
      console.log(`${cls}.${method} @${addr}  (${rows.length} instr)`)
      for (const r of rows.slice(0, Number(maxArg))) console.log('  ', r.text)
    }
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

// Who calls these methods? Scans method bodies up to their padding.
// usage: node findCallers.js <pid> "<classRegex>" Cls.method,Cls.method
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')

const { handle } = addon.attach(Number(process.argv[2]))
const classRe = new RegExp(process.argv[3])
const targets = process.argv[4].split(',')
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')
const up = (p) => BigInt(p).toString(16).toUpperCase().padStart(16, '0')

;(async () => {
  const exp = (n) => addon.resolveExport(handle, ga.base, n)
  const scratch = addon.allocateCave(handle, ga.base)
  const table = {
    domain_get: exp('il2cpp_domain_get'), assembly_open: exp('il2cpp_domain_assembly_open'),
    assembly_get_image: exp('il2cpp_assembly_get_image'), image_class_count: exp('il2cpp_image_get_class_count'),
    image_get_class: exp('il2cpp_image_get_class')
  }
  const ptrs = await findClassTable({
    call: (fn, a) => addon.callRemoteFunction(handle, table[fn], a),
    writeString: (t) => (addon.writeBytes(handle, scratch, Buffer.from(t + '\0').toString('hex')), scratch),
    scanQword: async (v) => (await addon.scanFirst(handle, 'int64', Number(v))).map((c) => c.address),
    readBytes: read
  })
  addon.freeMemory(handle, scratch)
  const en = enumerateIl2cpp({ readBytes: read }, ptrs, [classRe])
  const byName = new Map()
  for (const c of en.classes) for (const m of c.methods) byName.set(`${c.className}.${m.name}`, m)
  const callees = targets.map((t) => ({ t, m: byName.get(t) })).filter((x) => x.m)
  console.log('scanning', en.classes.length, 'classes; callees:', callees.map((x) => `${x.t}@${x.m.pointer}`).join(' '))
  for (const c of en.classes) {
    for (const m of c.methods) {
      const hex = read(m.pointer, 1400)
      if (!hex) continue
      const rows = addon.disassembleBuffer(Buffer.from(hex, 'hex'), m.pointer, 500)
      let pad = 0
      for (const r of rows) {
        if (/^int3/.test(r.text)) { if (++pad >= 3) break; continue }
        pad = 0
        if (!/^(call|jmp)/i.test(r.text)) continue
        for (const { t, m: callee } of callees) {
          if (r.text.toUpperCase().includes(up(callee.pointer))) console.log(`${c.className}.${m.name}  ->  ${t}   [${r.text}]`)
        }
      }
    }
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

// Which methods touch a field offset directly (inlined getter reads and writes)? Scans each method body up to its padding.
// usage: node findFieldReaders.js <pid> "<classRegex>" "<needle>"   e.g. "+0x68]"
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')

const { handle } = addon.attach(Number(process.argv[2]))
const classRe = new RegExp(process.argv[3])
const needle = process.argv[4]
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')

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
  console.log('scanning', en.classes.length, 'classes for', JSON.stringify(needle))
  for (const c of en.classes) {
    for (const m of c.methods) {
      const hex = read(m.pointer, 2400)
      if (!hex) continue
      const rows = addon.disassembleBuffer(Buffer.from(hex, 'hex'), m.pointer, 800)
      let pad = 0
      const hits = []
      for (const r of rows) {
        if (/^int3/.test(r.text)) { if (++pad >= 3) break; continue }
        pad = 0
        if (r.text.includes(needle)) hits.push(`${r.address}  ${r.text}`)
      }
      if (hits.length) console.log(`${c.className}.${m.name}\n    ${hits.slice(0, 6).join('\n    ')}`)
    }
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

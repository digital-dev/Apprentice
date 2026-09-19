// Disassemble named methods, e.g. to see what a getter reads or how a function starts.
// usage: CLASSES="^Cls$" ROWS=40 BYTES=200 node disasm.js <pid> Cls.method Cls.other
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')

const { handle } = addon.attach(Number(process.argv[2]))
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')
const want = new Set(process.argv.slice(3))

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
  const en = enumerateIl2cpp({ readBytes: read }, ptrs, (process.env.CLASSES || '^MoneyManager$|^CashInstance$').split('|').map((s) => new RegExp(s)))
  for (const c of en.classes) {
    for (const m of c.methods) {
      if (!want.has(`${c.className}.${m.name}`)) continue
      const hex = read(m.pointer, Number(process.env.BYTES || 96))
      const rows = addon.disassembleBuffer(Buffer.from(hex, 'hex'), m.pointer, Number(process.env.ROWS || 22))
      console.log(`--- ${c.className}.${m.name} @ ${m.pointer}`)
      for (const r of rows) console.log('  ', r.text)
    }
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

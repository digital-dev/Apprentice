// What does a method call? Resolves call/jmp targets to method names (virtual calls are shown raw).
// usage: node callTree.js <pid> "<classRegex>" Cls.method,Cls.method
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')

const { handle } = addon.attach(Number(process.argv[2]))
const classRe = new RegExp(process.argv[3])
const roots = process.argv[4].split(',')
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')
const key = (p) => BigInt(p).toString(16).toUpperCase().padStart(16, '0')

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
  const byAddr = new Map()
  const byName = new Map()
  for (const c of en.classes) for (const m of c.methods) { byAddr.set(key(m.pointer), `${c.className}.${m.name}`); byName.set(`${c.className}.${m.name}`, m) }
  for (const r of roots) {
    const m = byName.get(r)
    if (!m) { console.log('--', r, 'not found'); continue }
    const rows = addon.disassembleBuffer(Buffer.from(read(m.pointer, 1600), 'hex'), m.pointer, 500)
    const calls = []
    let pad = 0
    for (const row of rows) {
      if (/^int3/.test(row.text)) { if (++pad >= 3) break; continue }
      pad = 0
      const mm = row.text.match(/^(call|jmp)\s+0x([0-9A-Fa-f]{16})/)
      if (mm) calls.push(`${mm[1]} ${byAddr.get(mm[2].toUpperCase()) || '(unnamed ' + mm[2].slice(-8) + ')'}`)
      else if (/^call\s+\[/i.test(row.text)) calls.push(`vcall ${row.text}`)
    }
    console.log(`== ${r}: ${[...new Set(calls)].join(' | ')}`)
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

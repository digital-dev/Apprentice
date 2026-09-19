// Survey classes by name regex: fields (type, offset), statics and methods, to a text file.
// usage: node survey.js <pid> <outFile> "<classRegex>"
const fs = require('fs')
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')

const { handle } = addon.attach(Number(process.argv[2]))
const out = process.argv[3]
const classRe = new RegExp(process.argv[4], 'i')
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')

;(async () => {
  const exp = (n) => addon.resolveExport(handle, ga.base, n)
  const scratch = addon.allocateCave(handle, ga.base)
  const table = {
    domain_get: exp('il2cpp_domain_get'),
    assembly_open: exp('il2cpp_domain_assembly_open'),
    assembly_get_image: exp('il2cpp_assembly_get_image'),
    image_class_count: exp('il2cpp_image_get_class_count'),
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
  const lines = []
  for (const c of en.classes) {
    const f = c.fields.filter((x) => !x.isStatic).map((x) => `${x.fieldName}:${x.dataType || '?'}@0x${x.offset.toString(16)}`)
    const st = c.fields.filter((x) => x.isStatic).map((x) => x.fieldName)
    const m = c.methods.filter((x) => !x.isStatic).map((x) => x.name)
    lines.push(`## ${c.namespaceName ? c.namespaceName + '.' : ''}${c.className}  (fields ${c.fields.length}, methods ${c.methods.length})`)
    lines.push('  F: ' + f.join(' '))
    if (st.length) lines.push('  S: ' + st.join(' '))
    lines.push('  M: ' + m.join(' '))
  }
  fs.writeFileSync(out, lines.join('\n'))
  console.log('classes', en.classes.length, 'of', en.classesTotal, 'written', out)
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

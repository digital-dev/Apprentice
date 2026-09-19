// Build a `capture` patch (rcx = this) on a class's best hook site, exactly as the factory would.
// usage: node makeCapture.js <pid> "<classRegex>" <ClassName> <methodHint> <patchId>
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')
const { chooseHookSite } = require(root + '/factory/hookSite.js')

const [pid, classRe, className, hint, patchId] = process.argv.slice(2)
const { handle } = addon.attach(Number(pid))
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')
const moduleEnd = '0x' + (BigInt(ga.base) + BigInt(ga.size)).toString(16)

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
  const en = enumerateIl2cpp({ readBytes: read }, ptrs, [new RegExp(classRe)])
  const cls = en.classes.find((c) => c.className === className)
  if (!cls) { console.error('class not found'); process.exit(1) }
  const hookOps = {
    readBytes: read,
    disasm: (hex, address) => addon.disassembleBuffer(Buffer.from(hex, 'hex'), address, 32),
    scanAob: (sig) => addon.scanAob(handle, sig, ga.base, moduleEnd)
  }
  const site = await chooseHookSite(cls.methods, hookOps, { base: ga.base, size: ga.size }, hint)
  if (!site) { console.error('no hook site'); process.exit(1) }
  console.error('hook:', `${className}.${site.method.name}`, 'rva', site.rva)
  console.log(JSON.stringify({
    kind: 'patch', mode: 'capture', id: patchId,
    name: `Capture: ${className}.${site.method.name} instance`,
    originalBytes: site.originalBytes, length: site.length, signature: site.signature, signatureOffset: 0,
    moduleName: 'GameAssembly.dll', moduleOffset: site.rva, baseRegister: 'rcx', internal: true
  }, null, 2))
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

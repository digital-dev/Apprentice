// Build a persistent `replace` patch for an instruction span inside a method (e.g. make a function return early).
// usage: MINLEN=5 node makeReplace.js <pid> "<classRegex>" <method> "<instrTextRegex>" <replacementHex> <id> "<name>" [instructionsBefore=6]
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')
const { analyzeInstruction } = require(root + '/factory/hookSite.js')

const [pid, classRe, methodName, instrRe, replacementHex, id, name, beforeArg] = process.argv.slice(2)
const BEFORE = Number(beforeArg || 6)
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
  const method = en.classes.flatMap((c) => c.methods).find((m) => m.name === methodName)
  if (!method) { console.error('method not found'); process.exit(1) }

  const rows = addon.disassembleBuffer(Buffer.from(read(method.pointer, 1200), 'hex'), method.pointer, 400)
    .map((r) => ({ address: BigInt(r.address), bytes: r.bytes.replace(/\s+/g, ''), text: r.text, length: r.length }))
  const idx = rows.findIndex((r) => new RegExp(instrRe, 'i').test(r.text))
  if (idx < 0) { console.error('instruction not found'); process.exit(1) }
  const MINLEN = Number(process.env.MINLEN || 0)
  let covered = 1
  let coveredLen = rows[idx].length
  while (coveredLen < MINLEN && idx + covered < rows.length) coveredLen += rows[idx + covered++].length
  const target = {
    address: rows[idx].address,
    bytes: rows.slice(idx, idx + covered).map((r) => r.bytes).join(''),
    text: rows.slice(idx, idx + covered).map((r) => r.text).join(' ; '),
    length: coveredLen
  }
  console.error('target:', '0x' + target.address.toString(16), target.text, target.bytes)

  const replacement = replacementHex.padEnd(target.bytes.length, '9')
  const padded = replacementHex + '90'.repeat((target.bytes.length - replacementHex.length) / 2)
  if (padded.length !== target.bytes.length) { console.error('replacement longer than the instruction'); process.exit(1) }

  // Signature: BEFORE instructions of lead-in, the target, then as many after as needed to be unique.
  const start = Math.max(0, idx - BEFORE)
  const lead = rows.slice(start, idx)
  const leadTokens = lead.flatMap((r) => analyzeInstruction(r.bytes).tokens)
  let signature = null
  for (let after = 4; after <= 56 && idx + covered + after <= rows.length; after += 4) {
    const tokens = [...leadTokens, ...rows.slice(idx, idx + covered + after).flatMap((r) => analyzeInstruction(r.bytes).tokens)]
    const sig = tokens.join(' ')
    const matches = await addon.scanAob(handle, sig, ga.base, moduleEnd)
    console.error(`signature (${tokens.length}B, ${lead.length} before, ${after} after) -> ${matches.length} match(es)`)
    if (matches.length === 1 && BigInt(matches[0]) + BigInt(leadTokens.length) === target.address) { signature = sig; break }
  }
  if (!signature) { console.error('no unique signature'); process.exit(1) }

  console.log(JSON.stringify({
    kind: 'patch',
    mode: 'replace',
    id,
    name,
    originalBytes: target.bytes,
    length: target.length,
    replacementBytes: padded,
    signature,
    signatureOffset: leadTokens.length,
    moduleName: 'GameAssembly.dll',
    moduleOffset: '0x' + (target.address - BigInt(ga.base)).toString(16)
  }, null, 2))
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

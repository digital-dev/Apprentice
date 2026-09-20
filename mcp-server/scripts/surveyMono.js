// Mono: for every game class with a live singleton, list its fields with offsets and current values.
// usage: node surveyMono.js <pid> <outFile> [classRegex]
const fs = require('fs')
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { classifyEngine } = require(root + '/engineFingerprint.js')
const [pid, out, re = '.'] = [process.argv[2], process.argv[3], process.argv[4]]
const classRe = new RegExp(re, 'i')
const { handle } = addon.attach(Number(pid))
const cls = classifyEngine(addon.listModules(handle))
if (cls.engine !== 'unity-mono') { console.error('not unity-mono:', cls.engine); process.exit(1) }
const mono = cls.monoDllBase
const ROOTS = ['m_Instance', '_instance', 'instance', 's_Instance', 'Instance', '_Instance', 'm_instance']
const u64 = (hex) => Buffer.from(hex, 'hex').readBigUInt64LE(0)
;(async () => {
  const images = (await addon.monoListAssemblyNames(handle, mono)).filter((a) => /^Assembly-CSharp/i.test(a.name))
  const lines = []
  let n = 0
  for (const image of images) {
    for (const c of await addon.monoListClassesInImage(handle, mono, image.image)) {
      if (c.namespaceName !== '' || !classRe.test(c.className)) continue
      let inst = null, rootName = null
      for (const r of ROOTS) {
        const a = await addon.monoStaticFieldAddress(handle, mono, c.classHandle, r)
        if (!a) continue
        const p = addon.tryReadBytes(handle, a, 8)
        if (p && u64(p) !== 0n) { inst = u64(p); rootName = r; break }
      }
      if (inst === null) continue
      n++
      lines.push(`## ${c.className}  (${rootName} -> 0x${inst.toString(16)})`)
      for (const f of await addon.monoListFieldNames(handle, mono, c.classHandle)) {
        const info = await addon.monoResolveField(handle, mono, c.classHandle, f)
        if (!info) { lines.push(`   ${f}  (unresolved)`); continue }
        const b = addon.tryReadBytes(handle, '0x' + (inst + BigInt(info.offset)).toString(16), 8)
        if (!b) { lines.push(`   0x${info.offset.toString(16).padStart(3, '0')} ${f}  (unreadable)`); continue }
        const buf = Buffer.from(b, 'hex')
        const fl = buf.readFloatLE(0), i32 = buf.readInt32LE(0), q = buf.readBigUInt64LE(0)
        const ptr = q > 0x10000n && q < 0x7fffffffffffn && (q & 7n) === 0n
        lines.push(`   0x${info.offset.toString(16).padStart(3, '0')} ${f}  i32=${i32} f32=${Number.isFinite(fl) && Math.abs(fl) < 1e9 && Math.abs(fl) > 1e-6 ? +fl.toFixed(4) : '-'} b=${buf[0]}${ptr ? ' ptr' : ''}`)
      }
    }
  }
  fs.writeFileSync(out, lines.join('\n'))
  console.log(`${n} classes with a live singleton -> ${out}`)
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

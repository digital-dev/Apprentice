// Read-only triage after a game update: does each patch in a profile still find its bytes?
// usage: [SCAN_ONLY=1] node checkPatches.js <pid> <profilePath>   (SCAN_ONLY skips Mono-keyed patches, so nothing is compiled in the game)
// Mono-keyed patches: compile the method and compare the bytes at monoMethodOffset (compiling is what the game would do anyway).
// Signature patches: scan the signature (must match once) and compare the bytes at signatureOffset.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const raw = require(path.resolve(__dirname, '../../native/build/Release/memory_addon.node'))
const { classifyEngine } = require(root + '/engineFingerprint.js')
const [pid, profilePath] = process.argv.slice(2)
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
const { handle } = addon.attach(Number(pid))
const cls = classifyEngine(addon.listModules(handle))
const mono = cls.engine === 'unity-mono' ? cls.monoDllBase : null
const hexAt = (addr, n) => addon.tryReadBytes(handle, '0x' + BigInt(addr).toString(16), n)
;(async () => {
  const classes = new Map()
  if (mono) for (const i of (await addon.monoListAssemblyNames(handle, mono)).filter((a) => /^(Assembly-CSharp|assembly_)/i.test(a.name)))
    for (const c of await addon.monoListClassesInImage(handle, mono, i.image)) if (c.namespaceName === '') (classes.get(c.className) || classes.set(c.className, []).get(c.className)).push(c.classHandle)
  for (const c of profile.cheats.filter((c) => c.kind === 'patch')) {
    const want = (c.originalBytes || '').toLowerCase()
    let where = '', got = null, matches = ''
    try {
      if (c.monoClass && process.env.SCAN_ONLY) { console.log('SKIPPED'.padEnd(9), c.id, '(needs a method compile; SCAN_ONLY)'); continue }
      if (c.monoClass) {
        const handles = classes.get(c.monoClass) || []
        if (!handles.length) { console.log('MISSING'.padEnd(9), c.id, `class ${c.monoClass} not found`); continue }
        let ch = null
        for (const h of handles) if ((await addon.monoListMethodNames(handle, mono, h)).includes(c.monoMethod)) { ch = h; break }
        if (!ch) { console.log('MISSING'.padEnd(9), c.id, `${c.monoClass}.${c.monoMethod} not found in ${handles.length} class(es) of that name`); continue }
        const addr = await raw.monoCompileMethod(handle, mono, ch, c.monoMethod)
        where = `${c.monoClass}.${c.monoMethod}+${c.monoMethodOffset || '0x0'}`
        got = hexAt(BigInt(addr) + BigInt(c.monoMethodOffset || 0), want.length / 2)
        if (c.signature) {
          const sig = c.signature.replace(/\s+/g, '').toLowerCase()
          const whole = hexAt(BigInt(addr) + BigInt(c.monoMethodOffset || 0) - BigInt(c.signatureOffset || 0), sig.length / 2)
          matches = whole ? ` signature@site ${sigMatches(sig, whole) ? 'ok' : 'DIFFERS'}` : ' signature unreadable'
        }
      } else if (c.signature) {
        const hits = await addon.scanAob(handle, c.signature)
        where = `signature x${hits.length}`
        if (hits.length === 1) got = hexAt(BigInt(hits[0]) + BigInt(c.signatureOffset || 0), want.length / 2)
        else { console.log((hits.length === 0 ? 'GONE' : 'AMBIGUOUS').padEnd(9), c.id, where); continue }
      } else { where = c.moduleOffset ? `module ${c.moduleName}+${c.moduleOffset}` : '?'; got = null }
    } catch (e) { console.log('ERROR'.padEnd(9), c.id, String(e).slice(0, 80)); continue }
    console.log((got === want ? 'OK' : 'CHANGED').padEnd(9), c.id.slice(0, 52).padEnd(52), where, got === want ? '' : `want ${want} got ${got}`, matches)
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })
function sigMatches(sig, hex) { for (let i = 0; i < sig.length; i += 2) { const s = sig.slice(i, i + 2); if (s !== '??' && s !== hex.slice(i, i + 2)) return false } return true }

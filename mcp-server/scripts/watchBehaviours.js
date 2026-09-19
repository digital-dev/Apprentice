// Example live watcher: which behaviour is ACTIVE on each PoliceOfficer (logs changes only). Adapt the class/offsets for other games.
// usage: node watchBehaviours.js <pid> <seconds>
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { chunkedRead } = require(root + '/factory/chunkedRead.js')
const { findClassTable } = require(root + '/factory/il2cppBootstrap.js')
const { enumerateIl2cpp } = require(root + '/factory/il2cppEnumerator.js')
const { leU64, toHex } = require(root + '/factory/il2cppLayout.js')

const { handle } = addon.attach(Number(process.argv[2]))
const seconds = Number(process.argv[3])
const read = (a, n) => chunkedRead((x, m) => addon.tryReadBytes(handle, x, m), a, n)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')
const t0 = Date.now()
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

async function liveInstances(classPtr) {
  const hits = (await addon.scanFirst(handle, 'int64', Number(BigInt(classPtr)))).map((c) => BigInt(c.address))
  const cls = BigInt(classPtr)
  const out = []
  for (const a of hits) {
    if (a >= cls && a < cls + 0x130n) continue
    const head = read(toHex(a + 8n), 0x10)
    if (!head) continue
    const b = Buffer.from(head, 'hex')
    if (b.readBigUInt64LE(0) !== 0n) continue                 // monitor must be null
    if (b.readBigUInt64LE(8) === 0n) continue                 // Unity native pointer nonzero = alive
    out.push(a)
  }
  return out
}

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
  const en = enumerateIl2cpp({ readBytes: read }, ptrs, [/^PoliceOfficer$/, /^PlayerCrimeData$/])
  const by = Object.fromEntries(en.classes.map((c) => [c.className, c]))
  console.log(`${stamp()} classes ok; scanning officers...`)

  const officers = new Set()
  let crime = null
  const rescan = async () => {
    for (const a of await liveInstances(by.PoliceOfficer.classPtr)) officers.add(a)
    const c = await liveInstances(by.PlayerCrimeData.classPtr)
    if (c.length) crime = c[0]
  }
  await rescan()
  console.log(`${stamp()} watching ${officers.size} officer(s); crimeData ${crime ? toHex(crime) : 'none'}`)

  const NAMES = [['pursuit', 0x2b0], ['vehiclePursuit', 0x2b8], ['bodySearch', 0x2c0], ['checkpoint', 0x2c8], ['footPatrol', 0x2d0]]
  const last = new Map()
  const tick = () => {
    for (const o of officers) {
      const raw = read(toHex(o), 0x2e0)
      if (!raw) continue
      const buf = Buffer.from(raw, 'hex')
      const active = []
      for (const [name, off] of NAMES) {
        const p = buf.readBigUInt64LE(off)
        if (p < 0x10000n) continue
        const flag = read(toHex(p + 0x12en), 1)
        if (flag && Buffer.from(flag, 'hex')[0] !== 0) active.push(name)
      }
      const state = active.length ? active.join('+') : 'idle'
      const key = toHex(o)
      if (last.get(key) !== state) { console.log(`${stamp()} officer ${key}: ${state}`); last.set(key, state) }
    }
    if (crime) {
      const raw = read(toHex(crime + 0x130n), 0x40)
      if (raw) {
        const b = Buffer.from(raw, 'hex')
        const now = `pursuitLevel=${b.readInt32LE(0)} arrestProgress=${b.readFloatLE(0x18).toFixed(2)} bodySearchProgress=${b.readFloatLE(0x1c).toFixed(2)} pending=${read(toHex(crime + 0x168n), 1)}`
        if (last.get('crime') !== now) { console.log(`${stamp()} PLAYER ${now}`); last.set('crime', now) }
      }
    }
    if (Date.now() - t0 < seconds * 1000) setTimeout(tick, 300)
    else console.log(`${stamp()} watcher done`)
  }
  tick()
  const loop = async () => { while (Date.now() - t0 < seconds * 1000) { await new Promise((r) => setTimeout(r, 25000)); await rescan() } }
  loop()
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

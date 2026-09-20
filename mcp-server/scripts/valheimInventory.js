// Read-only: list the local player's inventory items with stack/durability/quality vs their maxima and the m_cheated flag.
// usage: node valheimInventory.js <pid>
const path = require('node:path')
const addon = require(path.resolve(__dirname, '../dist/addon.js'))
const { classifyEngine } = require(path.resolve(__dirname, '../dist/engineFingerprint.js'))
const { handle } = addon.attach(Number(process.argv[2]))
const mono = classifyEngine(addon.listModules(handle)).monoDllBase
const rd = (a, n) => { const h = addon.tryReadBytes(handle, '0x' + BigInt(a).toString(16), n); return h ? Buffer.from(h, 'hex') : null }
const ptr = (a) => { const b = rd(a, 8); return b ? b.readBigUInt64LE(0) : 0n }
const monoStr = (p) => { if (!p) return '?'; const l = rd(BigInt(p) + 0x10n, 4); if (!l) return '?'; const n = Math.min(l.readInt32LE(0), 64); const b = rd(BigInt(p) + 0x14n, n * 2); return b ? b.toString('utf16le') : '?' }
;(async () => {
  const cls = {}
  for (const i of (await addon.monoListAssemblyNames(handle, mono)).filter((a) => /^(Assembly-CSharp|assembly_)/i.test(a.name)))
    for (const c of await addon.monoListClassesInImage(handle, mono, i.image)) if (c.namespaceName === '' && ['Player', 'Inventory', 'ItemData', 'SharedData'].includes(c.className)) (cls[c.className] = cls[c.className] || []).push(c.classHandle)
  const off = async (cn, f) => { for (const h of cls[cn] || []) { const r = await addon.monoResolveField(handle, mono, h, f); if (r) return { h, o: BigInt(r.offset) } } return null }
  const lp = await off('Player', 'm_localPlayer')
  const st = await addon.monoStaticFieldAddress(handle, mono, lp.h, 'm_localPlayer')
  const player = ptr(BigInt(st))
  const pInv = await off('Player', 'm_inventory'), iList = await off('Inventory', 'm_inventory')
  const inv = ptr(player + pInv.o)
  const list = ptr(inv + iList.o)
  const items = ptr(list + 0x10n), size = rd(list + 0x18n, 4).readInt32LE(0)
  const f = { shared: await off('ItemData', 'm_shared'), stack: await off('ItemData', 'm_stack'), dur: await off('ItemData', 'm_durability'), qual: await off('ItemData', 'm_quality'), ch: await off('ItemData', 'm_cheated') }
  const s = { name: await off('SharedData', 'm_name'), maxStack: await off('SharedData', 'm_maxStackSize'), maxDur: await off('SharedData', 'm_maxDurability'), maxQ: await off('SharedData', 'm_maxQuality') }
  console.log(`${size} items; offsets shared=0x${f.shared.o.toString(16)} cheated=0x${f.ch.o.toString(16)} | shared: name=0x${s.name.o.toString(16)} maxStack=0x${s.maxStack.o.toString(16)} maxDur=0x${s.maxDur.o.toString(16)}`)
  for (let i = 0; i < size; i++) {
    const it = ptr(items + 0x20n + BigInt(i) * 8n)
    if (!it) continue
    const sh = ptr(it + f.shared.o)
    const name = monoStr(ptr(sh + s.name.o))
    const stack = rd(it + f.stack.o, 4).readInt32LE(0), dur = rd(it + f.dur.o, 4).readFloatLE(0), q = rd(it + f.qual.o, 4).readInt32LE(0)
    const maxStack = rd(sh + s.maxStack.o, 4).readInt32LE(0), maxDur = rd(sh + s.maxDur.o, 4).readFloatLE(0), maxQ = s.maxQ ? rd(sh + s.maxQ.o, 4).readInt32LE(0) : 0
    const cheated = rd(it + f.ch.o, 1)[0]
    const flags = [stack > maxStack ? 'STACK>MAX' : '', dur > maxDur + 0.01 ? 'DUR>MAX' : '', q > maxQ ? 'QUALITY>MAX' : '', cheated ? 'CHEATED' : ''].filter(Boolean).join(' ')
    console.log(String(i).padStart(2), name.padEnd(28), `stack ${stack}/${maxStack}`.padEnd(14), `dur ${dur.toFixed(0)}/${maxDur.toFixed(0)}`.padEnd(14), `q ${q}/${maxQ}`.padEnd(8), flags)
  }
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

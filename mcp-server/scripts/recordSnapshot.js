// Record a snapshot of a running game's executable memory, for offline replay
// of signature building and patch relocation (tests/replay).
// usage: [MODULE=<name>] node recordSnapshot.js <pid> <game> <build> <out.snap> [siteId:address:length ...]
//
// Read-only: it enumerates executable regions and reads them, nothing else.
// Snapshots contain the game's code, so they must not be committed: the
// output path is refused inside the repo unless it is fixtures/snapshots/.
//
// <build> is a label you choose for the game build (e.g. the main module's
// TimeDateStamp); it only has to differ between builds of the same game.
// Each site is a patch you want regression-tested: its id, address and the
// length of the instruction it replaces.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

const REPO = path.resolve(__dirname, '../..')
const ALLOWED = path.join(REPO, 'fixtures', 'snapshots')

// Margins: the most the signature builder ever reads before and after a site
// (see sigbuild.cc). Recorded so a read near a region edge behaves as it did
// live. Null when unreadable at record time, and then simply absent.
const PRE_MARGIN = 64
const POST_MARGIN = 128

// File layout, gzipped: u32le headerLength | header JSON | region bytes
// (per region: pre, body, post). Must match src/main/replay/snapshotFile.ts;
// tests/replay/recorder.test.ts round-trips this writer through that reader.
function encodeSnapshotFile(s) {
  const header = {
    version: 1,
    game: s.game,
    build: s.build,
    modules: s.modules,
    sites: s.sites,
    regions: s.regions.map((r) => ({
      base: r.base,
      preLength: r.pre ? r.pre.length : 0,
      length: r.bytes.length,
      postLength: r.post ? r.post.length : 0
    }))
  }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(headerJson.length, 0)
  const parts = [prefix, headerJson]
  for (const r of s.regions) {
    if (r.pre) parts.push(r.pre)
    parts.push(r.bytes)
    if (r.post) parts.push(r.post)
  }
  return zlib.gzipSync(Buffer.concat(parts))
}

function writeSnapshotFile(snapshot, file) {
  const encoded = encodeSnapshotFile(snapshot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encoded)
  return crypto.createHash('sha256').update(encoded).digest('hex')
}

function assertSafeOutput(out) {
  const abs = path.resolve(out)
  const rel = path.relative(REPO, abs)
  const inRepo = !rel.startsWith('..') && !path.isAbsolute(rel)
  if (inRepo && !abs.startsWith(ALLOWED + path.sep)) {
    throw new Error(`refusing to write a snapshot inside the repo outside ${ALLOWED} (game code must not be committed)`)
  }
  return abs
}

function record(addon, pid, game, build, sitesArg) {
  const { handle } = addon.attach(pid)
  const modules = addon.listModules(handle).map((m) => ({
    name: m.name,
    base: m.base,
    size: m.size,
    timestamp: m.timestamp
  }))

  // MODULE=<name> confines the dump to that module's own image. Reading the
  // margins just outside a region touches memory nobody asked for, and an
  // anti-tamper game (Elden Ring) can fault afterwards if that was a guard
  // page. Inside the module, margins are only read where they stay in it.
  const only = process.env.MODULE ? modules.find((m) => m.name.toLowerCase() === process.env.MODULE.toLowerCase()) : null
  if (process.env.MODULE && !only) throw new Error(`module ${process.env.MODULE} is not loaded`)
  const lo = only ? BigInt(only.base) : 0n
  const hi = only ? BigInt(only.base) + BigInt(only.size) : (1n << 64n)

  const regions = []
  let skipped = 0
  for (const r of addon.listExecRegions(handle)) {
    const base = BigInt(r.base)
    if (base < lo || base + BigInt(r.size) > hi) { if (only) continue }
    const bytes = addon.readRegionBuffer(handle, r.base, r.size)
    if (!bytes) { skipped++; continue }
    const preAt = base - BigInt(PRE_MARGIN)
    const postAt = base + BigInt(r.size)
    const pre = preAt >= lo ? addon.readRegionBuffer(handle, '0x' + preAt.toString(16), PRE_MARGIN) : null
    const post = postAt + BigInt(POST_MARGIN) <= hi ? addon.readRegionBuffer(handle, '0x' + postAt.toString(16), POST_MARGIN) : null
    regions.push({ base: r.base, bytes, ...(pre ? { pre } : {}), ...(post ? { post } : {}) })
  }

  const sites = sitesArg.map((s) => {
    const [id, address, length] = s.split(':')
    if (!id || !address || !length) throw new Error(`bad site "${s}", want id:address:length`)
    return { id, address, length: Number(length) }
  })
  addon.detach(handle)
  return { snapshot: { version: 1, game, build, modules, regions, sites }, skipped }
}

module.exports = { encodeSnapshotFile, writeSnapshotFile, assertSafeOutput, record }

if (require.main === module) {
  const [pidArg, game, build, out, ...siteArgs] = process.argv.slice(2)
  if (!pidArg || !game || !build || !out) {
    console.error('usage: node recordSnapshot.js <pid> <game> <build> <out.snap> [siteId:address:length ...]')
    process.exit(2)
  }
  const abs = assertSafeOutput(out)
  const addon = require(path.join(REPO, 'native', 'build', 'Release', 'memory_addon.node'))
  const { snapshot, skipped } = record(addon, Number(pidArg), game, build, siteArgs)
  const sha = writeSnapshotFile(snapshot, abs)
  const mb = snapshot.regions.reduce((n, r) => n + r.bytes.length, 0) / 1048576
  console.log(`regions ${snapshot.regions.length} (${mb.toFixed(1)} MB), unreadable regions skipped ${skipped}`)
  console.log(`modules ${snapshot.modules.length}, sites ${snapshot.sites.length}`)
  console.log(`wrote ${abs}`)
  console.log(`sha256 ${sha}`)
}

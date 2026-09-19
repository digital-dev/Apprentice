// Run the built IL2CPP author path against an attached game without the MCP server.
// usage: node authorLive.js <pid> <profilePath> <category,category,...>
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { authorIl2cpp } = require(root + '/tools/authorIl2cpp.js')

const [pid, profilePath, wishlist] = [Number(process.argv[2]), process.argv[3], process.argv[4].split(',')]
const { handle } = addon.attach(pid)
const ga = addon.listModules(handle).find((m) => m.name === 'GameAssembly.dll')

;(async () => {
  const t0 = Date.now()
  const r = await authorIl2cpp({ handle, wishlist, profilePath }, ga.base)
  console.log(r.isError ? 'ERROR' : 'OK', `${Date.now() - t0}ms`)
  console.log(r.content[0].text)
  if (typeof addon.detach === 'function') addon.detach(handle)
})().catch((e) => {
  console.error('THROWN', e)
  process.exit(1)
})

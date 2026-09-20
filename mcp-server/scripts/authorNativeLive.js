// Run the built native author path against an attached game without the MCP server.
// usage: node authorNativeLive.js <pid> <profilePath> <category,category,...>
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { authorNative } = require(root + '/tools/authorNative.js')

const [pid, profilePath, wishlist] = [Number(process.argv[2]), process.argv[3], process.argv[4].split(',')]
const { handle } = addon.attach(pid)

;(async () => {
  const t0 = Date.now()
  const r = await authorNative({ handle, wishlist, profilePath })
  console.log(r.isError ? 'ERROR' : 'OK', `${Date.now() - t0}ms`)
  console.log(r.content[0].text)
  if (typeof addon.detach === 'function') addon.detach(handle)
})().catch((e) => {
  console.error('THROWN', e)
  process.exit(1)
})

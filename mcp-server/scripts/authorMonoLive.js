// Run the built author_cheats handler (Unity/Mono or IL2CPP dispatch) against an attached game without the MCP server.
// usage: node authorMonoLive.js <pid> <profilePath> <category,category,...>
const root = require('node:path').resolve(__dirname, '../dist')
const addon = require(root + '/addon.js')
const { registerAuthorTools } = require(root + '/tools/author.js')
let handler
registerAuthorTools({ registerTool: (name, _meta, fn) => { if (name === 'author_cheats') handler = fn } })
const [pid, profilePath, wishlist] = [Number(process.argv[2]), process.argv[3], process.argv[4].split(',')]
const { handle } = addon.attach(pid)
;(async () => {
  const t0 = Date.now()
  const r = await handler({ handle, wishlist, profilePath })
  console.log(r.isError ? 'ERROR' : 'OK', `${Date.now() - t0}ms`)
  console.log(r.content[0].text)
})().catch((e) => { console.error('THROWN', e); process.exit(1) })

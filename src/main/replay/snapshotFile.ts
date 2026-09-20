import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

// A recorded copy of a game's executable memory, for offline replay of
// signature building and patch relocation (see docs/superpowers/specs/
// 2026-09-19-fixture-replay-design.md). Snapshots contain game code, so they
// are local files, never committed.

export interface SnapshotRegion {
  // '0x'-prefixed hex, as the addon reports it.
  base: string
  // The region's bytes. One entry per region as the OS reported it: a live
  // scan searches one region at a time, so adjacent regions must not merge.
  bytes: Buffer
  // Readable bytes ending at `base` (<= 64) and starting at base + bytes.length
  // (<= 128). Absent when unreadable at record time. They exist only so a
  // window read near a region edge behaves as it does live (all-or-nothing,
  // crossing the edge); they are never scanned.
  pre?: Buffer
  post?: Buffer
}

export interface SnapshotModule {
  name: string
  base: string
  size: number
  timestamp: number
}

export interface SnapshotSite {
  id: string
  address: string
  length: number
}

export interface Snapshot {
  version: 1
  game: string
  build: string
  modules: SnapshotModule[]
  regions: SnapshotRegion[]
  sites: SnapshotSite[]
}

// File layout, gzipped: u32le headerLength | header JSON | region bytes.
// The header is the Snapshot with each region's buffers replaced by their
// lengths; the byte section holds, per region in order: pre, body, post.
interface HeaderRegion {
  base: string
  preLength: number
  length: number
  postLength: number
}
interface Header extends Omit<Snapshot, 'regions'> {
  regions: HeaderRegion[]
}

export function encodeSnapshot(s: Snapshot): Buffer {
  const header: Header = {
    version: s.version,
    game: s.game,
    build: s.build,
    modules: s.modules,
    sites: s.sites,
    regions: s.regions.map((r) => ({
      base: r.base,
      preLength: r.pre?.length ?? 0,
      length: r.bytes.length,
      postLength: r.post?.length ?? 0
    }))
  }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8')
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(headerJson.length, 0)
  const parts: Buffer[] = [lengthPrefix, headerJson]
  for (const r of s.regions) {
    if (r.pre) parts.push(r.pre)
    parts.push(r.bytes)
    if (r.post) parts.push(r.post)
  }
  return gzipSync(Buffer.concat(parts))
}

export function decodeSnapshot(file: Buffer): Snapshot {
  const raw = gunzipSync(file)
  if (raw.length < 4) throw new Error('snapshot: truncated header')
  const headerLength = raw.readUInt32LE(0)
  if (4 + headerLength > raw.length) throw new Error('snapshot: truncated header')
  const header = JSON.parse(raw.subarray(4, 4 + headerLength).toString('utf8')) as Header
  if (header.version !== 1) throw new Error(`snapshot: unsupported version ${header.version}`)

  let offset = 4 + headerLength
  const take = (n: number): Buffer => {
    if (offset + n > raw.length) throw new Error('snapshot: truncated region data')
    // Copy, so a snapshot does not pin the whole decompressed file in memory.
    const out = Buffer.from(raw.subarray(offset, offset + n))
    offset += n
    return out
  }
  const regions: SnapshotRegion[] = header.regions.map((h) => {
    const pre = h.preLength ? take(h.preLength) : undefined
    const bytes = take(h.length)
    const post = h.postLength ? take(h.postLength) : undefined
    return { base: h.base, bytes, ...(pre ? { pre } : {}), ...(post ? { post } : {}) }
  })
  return {
    version: 1,
    game: header.game,
    build: header.build,
    modules: header.modules,
    sites: header.sites,
    regions
  }
}

// Hex SHA-256 of the encoded file: what the manifest pins.
export function snapshotSha256(file: Buffer): string {
  return createHash('sha256').update(file).digest('hex')
}

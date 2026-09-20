import path from 'node:path'
import type { PatchOps } from '../patchEngine'
import type { Snapshot } from './snapshotFile'

// The slice of the native addon ReplayOps needs. Injected so tests and the
// real tier share one addon instance and this file stays free of a hard path.
export interface ReplayAddon {
  snapshotScanAob(regions: NativeRegion[], signature: string): string[]
  snapshotDecodeRun(
    regions: NativeRegion[],
    address: string,
    minBytes: number
  ): { length: number; decodable: boolean; relocatable: boolean; clobbers: string[] }
}

export interface NativeRegion {
  base: string
  bytes: Buffer
  pre?: Buffer
  post?: Buffer
}

// PatchOps over a recorded snapshot, so the real PatchEngine's locate() runs
// against a game's code without the game. Read-only by construction: the
// snapshot is history, so anything that would write, allocate or run code in
// the target throws rather than pretend.
export class ReplayOps implements PatchOps {
  private readonly regions: NativeRegion[]
  private readonly addon: ReplayAddon

  constructor(
    private readonly snapshot: Snapshot,
    addon?: ReplayAddon
  ) {
    this.addon =
      addon ?? require(path.join(__dirname, '../../../native/build/Release/memory_addon.node'))
    this.regions = snapshot.regions.map((r) => ({
      base: r.base,
      bytes: r.bytes,
      ...(r.pre ? { pre: r.pre } : {}),
      ...(r.post ? { post: r.post } : {})
    }))
  }

  getModuleBase(moduleName: string): string | null {
    const want = moduleName.toLowerCase()
    return this.snapshot.modules.find((m) => m.name.toLowerCase() === want)?.base ?? null
  }

  // All-or-nothing across bodies and margins, like a live ReadProcessMemory.
  readBytes(address: string, length: number): string | null {
    const out = Buffer.alloc(length)
    let done = 0
    const start = BigInt(address)
    while (done < length) {
      const at = start + BigInt(done)
      const seg = this.segmentAt(at)
      if (!seg) return null
      const off = Number(at - seg.start)
      const n = Math.min(length - done, seg.data.length - off)
      seg.data.copy(out, done, off, off + n)
      done += n
    }
    return out.toString('hex')
  }

  async scanAob(signature: string, rangeStart?: string, rangeEnd?: string): Promise<string[]> {
    const hits = this.addon.snapshotScanAob(this.regions, signature)
    const plen = signature.trim().split(/\s+/).length
    const lo = rangeStart !== undefined ? BigInt(rangeStart) : 0n
    const hi = rangeEnd !== undefined ? BigInt(rangeEnd) : 0n
    // Same rule as the live scan: rangeEnd 0 means unbounded; a hit must fit
    // fully inside the range.
    return hits.filter((h) => {
      const a = BigInt(h)
      return a >= lo && (hi === 0n || a + BigInt(plen) <= hi)
    })
  }

  decodeRun(address: string, minBytes: number) {
    return this.addon.snapshotDecodeRun(this.regions, address, minBytes)
  }

  private segmentAt(addr: bigint): { start: bigint; data: Buffer } | null {
    for (const r of this.snapshot.regions) {
      const base = BigInt(r.base)
      const segs: { start: bigint; data: Buffer | undefined }[] = [
        { start: base - BigInt(r.pre?.length ?? 0), data: r.pre },
        { start: base, data: r.bytes },
        { start: base + BigInt(r.bytes.length), data: r.post }
      ]
      for (const s of segs) {
        if (s.data && addr >= s.start && addr - s.start < BigInt(s.data.length)) {
          return { start: s.start, data: s.data }
        }
      }
    }
    return null
  }

  private unsupported(name: string): never {
    throw new Error(`ReplayOps: ${name} is not replayable (a snapshot is read-only history)`)
  }
  writeBytes(): boolean { return this.unsupported('writeBytes') }
  allocateCave(): string | null { return this.unsupported('allocateCave') }
  freeCave(): void { this.unsupported('freeCave') }
  encodeStore(): string { return this.unsupported('encodeStore') }
  encodeStoreRegister(): string { return this.unsupported('encodeStoreRegister') }
  encodeScale(): string { return this.unsupported('encodeScale') }
  encodeConditionalScale(): string { return this.unsupported('encodeConditionalScale') }
  encodeCaptureOnce(): string { return this.unsupported('encodeCaptureOnce') }
  encodeGuardedSkip(): string { return this.unsupported('encodeGuardedSkip') }
  encodeImmuneGuard(): string { return this.unsupported('encodeImmuneGuard') }
  encodeJump(): string { return this.unsupported('encodeJump') }
  suspendThreads(): boolean { return this.unsupported('suspendThreads') }
  resumeThreads(): void { this.unsupported('resumeThreads') }
}

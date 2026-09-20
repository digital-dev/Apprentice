import type { Snapshot } from '../../../src/main/replay/snapshotFile'

// A hand-assembled x86-64 image with the traps the signature heuristics have
// to survive. Every byte string is verified by decoding (see
// `assertDecodes` callers): a typo must fail loudly rather than test garbage.

const int3 = (n: number) => Buffer.alloc(n, 0xcc)
const b = (...bytes: number[]) => Buffer.from(bytes)

// push rbp; mov rbp,rsp; movss [rcx+0x3c],xmm0; pop rbp; ret
// The store is at +4. Mono emits byte-identical bodies for generic
// instantiations, so two copies of this is a realistic ambiguity.
export const TWIN_BODY = b(0x55, 0x48, 0x89, 0xe5, 0xf3, 0x0f, 0x11, 0x41, 0x3c, 0x5d, 0xc3)
export const TWIN_STORE_OFFSET = 4
export const TWIN_STORE_LEN = 5

// Method with a RIP-relative lea and an absolute movabs (both move between
// launches), then the store we care about at +21:
//   push rbp; mov rbp,rsp; lea rax,[rip+disp32]; movabs r11,imm64;
//   mov [rcx+0x18],eax; pop rbp; ret
export function relocBody(disp32: number, imm64: bigint): Buffer {
  const lea = Buffer.alloc(7)
  lea.set([0x48, 0x8d, 0x05], 0)
  lea.writeInt32LE(disp32, 3)
  const movabs = Buffer.alloc(10)
  movabs.set([0x49, 0xbb], 0)
  movabs.writeBigUInt64LE(imm64, 2)
  return Buffer.concat([b(0x55, 0x48, 0x89, 0xe5), lea, movabs, b(0x89, 0x41, 0x18, 0x5d, 0xc3)])
}
export const RELOC_STORE_OFFSET = 21
export const RELOC_STORE_LEN = 3

// A method whose store sits exactly 0x13 bytes into its region, the harness's
// own failure case (a 64-byte lead-in ran off the front of the region):
//   push rbx; sub rsp,0x20; mov rbx,rcx; xor eax,eax; mov ecx,0x12345678;
//   lea rdx,[rbx+8]            <- 19 bytes
//   mov [rbx+0x20],eax         <- the store
//   add rsp,0x20; pop rbx; ret
export const EDGE_BODY = b(
  0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x89, 0xcb, 0x31, 0xc0, 0xb9, 0x78, 0x56, 0x34, 0x12,
  0x48, 0x8d, 0x53, 0x08,
  0x89, 0x43, 0x20,
  0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3
)
export const EDGE_STORE_OFFSET = 0x13
export const EDGE_STORE_LEN = 3

export interface SynthOptions {
  // Base of the main region. The edge region sits 1MB above it.
  base?: bigint
  imm64?: bigint
  // Whether the bytes just before the edge region were readable when
  // "recorded": true records a pre margin, false records none.
  edgePre?: boolean
}

export interface SynthSites {
  twinA: bigint
  twinB: bigint
  reloc: bigint
  edge: bigint
  edgeBase: bigint
}

const hex = (n: bigint) => '0x' + n.toString(16)

export function buildSynthSnapshot(opts: SynthOptions = {}): { snapshot: Snapshot; sites: SynthSites } {
  const base = opts.base ?? 0x10000000n
  const imm64 = opts.imm64 ?? 0x0001c74de92310n

  // Main region: [pad][twinA][pad][twinB][pad][reloc][pad]
  let cursor = 0
  const parts: Buffer[] = []
  const place = (buf: Buffer): number => {
    const at = cursor
    parts.push(buf)
    cursor += buf.length
    return at
  }
  place(int3(32))
  const twinA = place(TWIN_BODY)
  place(int3(16))
  const twinB = place(TWIN_BODY)
  place(int3(16))
  // The lea targets a data slot 0x800 past the method; rel32 is measured from
  // the end of the lea (method start + 4 + 7), so the encoded value is the
  // same at any base. Vary it with the base to model a moved image anyway.
  const relocAt = cursor
  const disp32 = Number(0x800n + (base & 0xffffn))
  place(relocBody(disp32, imm64))
  place(int3(32))

  const edgeBase = base + 0x100000n
  const edgeBytes = EDGE_BODY

  const snapshot: Snapshot = {
    version: 1,
    game: 'synthetic',
    build: 'synth',
    modules: [{ name: 'synth.exe', base: hex(base), size: cursor, timestamp: 1 }],
    regions: [
      { base: hex(base), bytes: Buffer.concat(parts), pre: int3(64), post: int3(128) },
      {
        base: hex(edgeBase),
        bytes: edgeBytes,
        // 0x00 fill: readable-but-unrelated memory in front of a region.
        ...(opts.edgePre === false ? {} : { pre: Buffer.alloc(64, 0) }),
        post: int3(128)
      }
    ],
    sites: []
  }
  return {
    snapshot,
    sites: {
      twinA: base + BigInt(twinA + TWIN_STORE_OFFSET),
      twinB: base + BigInt(twinB + TWIN_STORE_OFFSET),
      reloc: base + BigInt(relocAt + RELOC_STORE_OFFSET),
      edge: edgeBase + BigInt(EDGE_STORE_OFFSET),
      edgeBase
    }
  }
}

// Fails loudly if a hand-assembled byte string does not decode into whole
// instructions ending exactly at its length. `disassemble` is the addon's
// disassembleBuffer.
export function assertDecodes(
  disassemble: (buf: Buffer, base: string, max?: number) => { text: string; length: number }[],
  name: string,
  buf: Buffer,
  expectTexts: RegExp[]
): void {
  const rows = disassemble(buf, '0x0', 64)
  const total = rows.reduce((n, r) => n + r.length, 0)
  if (total !== buf.length) throw new Error(`${name}: decoded ${total} of ${buf.length} bytes`)
  if (rows.some((r) => r.text === '??')) throw new Error(`${name}: undecodable instruction`)
  expectTexts.forEach((re, i) => {
    if (!rows[i] || !re.test(rows[i].text)) {
      throw new Error(`${name}: instruction ${i} is "${rows[i]?.text}", expected ${re}`)
    }
  })
}

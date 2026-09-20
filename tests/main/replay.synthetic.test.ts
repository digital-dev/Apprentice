import { describe, it, expect } from 'vitest'
import addon from '../../native/build/Release/memory_addon.node'
import { PatchEngine } from '../../src/main/patchEngine'
import type { PatchCheat } from '../../src/main/store'
import { ReplayOps, type ReplayAddon } from '../../src/main/replay/replayOps'
import type { Snapshot } from '../../src/main/replay/snapshotFile'
import {
  EDGE_BODY,
  EDGE_STORE_LEN,
  RELOC_STORE_LEN,
  TWIN_BODY,
  TWIN_STORE_LEN,
  assertDecodes,
  buildSynthSnapshot,
  relocBody
} from './fixtures/synthImage'

const a = addon as any
const native = addon as unknown as ReplayAddon

const hex = (n: bigint) => '0x' + n.toString(16)
const regionsOf = (s: Snapshot) => s.regions

// A patch that carries only what relocation needs: the signature and where the
// instruction sits inside it, plus the bytes that must be there.
function patchFor(
  id: string,
  sig: { signature: string; signatureOffset: number },
  originalBytes: string
): PatchCheat {
  return {
    kind: 'patch',
    id,
    name: id,
    originalBytes,
    length: originalBytes.length / 2,
    signature: sig.signature,
    signatureOffset: sig.signatureOffset,
    moduleName: null,
    moduleOffset: null
  }
}

const bytesAt = (s: Snapshot, addr: bigint, len: number) =>
  new ReplayOps(s, native).readBytes(hex(addr), len)!

describe('synthetic fixture: the images decode as intended', () => {
  it('every hand-assembled body is whole instructions', () => {
    const dis = a.disassembleBuffer
    assertDecodes(dis, 'twin', TWIN_BODY, [/push rbp/, /mov rbp, ?rsp/, /movss/, /pop rbp/, /ret/])
    assertDecodes(dis, 'reloc', relocBody(0x800, 0x1122334455667788n), [
      /push rbp/, /mov rbp, ?rsp/, /lea rax/, /mov r11/, /mov \[?dword ptr \[?rcx|mov .*rcx/i, /pop rbp/, /ret/
    ])
    assertDecodes(dis, 'edge', EDGE_BODY, [
      /push rbx/, /sub rsp/, /mov rbx, ?rcx/, /xor eax, ?eax/, /mov ecx/, /lea rdx/, /mov/, /add rsp/, /pop rbx/, /ret/
    ])
  })
})

describe('twin bodies (identical JIT copies)', () => {
  it('the signature is ambiguous and the engine refuses to patch a guess', async () => {
    const { snapshot, sites } = buildSynthSnapshot()
    const sig = a.snapshotBuildSignature(regionsOf(snapshot), hex(sites.twinA), TWIN_STORE_LEN)
    const ops = new ReplayOps(snapshot, native)

    expect((await ops.scanAob(sig.signature)).length).toBe(2)

    const status = await new PatchEngine(ops).locate(
      patchFor('twin', sig, bytesAt(snapshot, sites.twinA, TWIN_STORE_LEN))
    )
    expect(status.state).toBe('not-found')
    expect(status.matchCount).toBe(2)
    expect(status.address).toBeNull()
  })
})

describe('region edge (store 0x13 bytes into its region)', () => {
  it('with the neighbouring bytes readable, the lead-in clamps to the region and matches once', async () => {
    const { snapshot, sites } = buildSynthSnapshot({ edgePre: true })
    const sig = a.snapshotBuildSignature(regionsOf(snapshot), hex(sites.edge), EDGE_STORE_LEN)
    expect(sig.signatureOffset).toBeGreaterThan(0)
    expect(sig.signatureOffset).toBeLessThanOrEqual(0x13)

    const ops = new ReplayOps(snapshot, native)
    expect(await ops.scanAob(sig.signature)).toEqual([hex(sites.edge - BigInt(sig.signatureOffset))])

    const status = await new PatchEngine(ops).locate(
      patchFor('edge', sig, bytesAt(snapshot, sites.edge, EDGE_STORE_LEN))
    )
    expect(status.state).toBe('original')
    expect(status.address).toBe(hex(sites.edge))
  })

  it('with the bytes before the region unreadable, it falls back to forward-only and still matches once', async () => {
    const { snapshot, sites } = buildSynthSnapshot({ edgePre: false })
    const sig = a.snapshotBuildSignature(regionsOf(snapshot), hex(sites.edge), EDGE_STORE_LEN)
    expect(sig.signatureOffset).toBe(0)

    const ops = new ReplayOps(snapshot, native)
    expect(await ops.scanAob(sig.signature)).toEqual([hex(sites.edge)])
  })
})

describe('relocation across launches', () => {
  it('the same code at another base with another imm64 gives the same signature, found once', async () => {
    const one = buildSynthSnapshot({ base: 0x10000000n, imm64: 0x000247ca4f8a1000n })
    const two = buildSynthSnapshot({ base: 0x7ff600000000n, imm64: 0x000001c74de92310n })

    const s1 = a.snapshotBuildSignature(regionsOf(one.snapshot), hex(one.sites.reloc), RELOC_STORE_LEN)
    const s2 = a.snapshotBuildSignature(regionsOf(two.snapshot), hex(two.sites.reloc), RELOC_STORE_LEN)

    expect(s1.signature).toBe(s2.signature)
    expect(s1.signatureOffset).toBe(s2.signatureOffset)
    // The moving bytes (rel32 of the lea, imm64 of the movabs) must be blanked.
    expect(s1.signature.split(' ').filter((t: string) => t === '??').length).toBe(4 + 8)

    // Captured in launch one, located in launch two: the engine finds the
    // instruction at its new address.
    const original = bytesAt(one.snapshot, one.sites.reloc, RELOC_STORE_LEN)
    const status = await new PatchEngine(new ReplayOps(two.snapshot, native)).locate(
      patchFor('reloc', s1, original)
    )
    expect(status.state).toBe('original')
    expect(status.matchCount).toBe(1)
    expect(status.address).toBe(hex(two.sites.reloc))
  })
})

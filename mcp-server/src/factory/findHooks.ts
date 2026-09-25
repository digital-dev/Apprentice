// Disassembles a method body and flags any jmp/call whose target falls
// outside a given module's [base, base+size) range — a cheap, purely-static
// way to spot an already-installed hook (ours, a game update's own new
// code, or a THIRD-PARTY trainer's) before touching anything.
//
// This is how another already-installed trainer's own live patches on
// PlayerStamina/PlayerSanity/GhostAI.Update were found during the
// Phasmophobia session: its trampoline jumps land in a manually-mapped
// region outside GameAssembly.dll entirely (invisible to normal module
// enumeration), which this flags the same way it would flag our own
// capture cave. See il2cpp-engine-instance-discovery.md (session memory)
// for the finding.
export interface HookScanOps {
  readBytes(address: string, length: number): string | null
  disasm(bufferHex: string, baseAddress: string, maxCount?: number): { address: string; text: string }[]
}

export interface InjectedHook {
  address: string
  text: string
  target: string
}

const JMP_OR_CALL = /^(jmp|call)\s+0x([0-9A-Fa-f]+)/

export function findInjectedHooks(
  ops: HookScanOps,
  address: string,
  lengthBytes: number,
  moduleBase: string,
  moduleSize: number
): InjectedHook[] | { error: string } {
  const hex = ops.readBytes(address, lengthBytes)
  if (hex === null) return { error: `could not read ${lengthBytes} bytes at ${address}` }

  const rows = ops.disasm(hex, address, Math.ceil(lengthBytes / 2))
  const base = BigInt(moduleBase)
  const end = base + BigInt(moduleSize)

  const hooks: InjectedHook[] = []
  for (const row of rows) {
    const m = JMP_OR_CALL.exec(row.text)
    if (m === null) continue
    const target = BigInt('0x' + m[2])
    if (target < base || target >= end) {
      hooks.push({ address: row.address, text: row.text, target: '0x' + target.toString(16) })
    }
  }
  return hooks
}

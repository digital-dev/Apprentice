import type { CheatDefinition } from '../../main/store'

// An anchored cheat reads through a pointer its capture patch records, and that
// pointer only exists once the game has run the patched instruction. The
// "N/M live" readout is computed when Tamper attaches, before any capture has
// fired, so without a refresh every anchored cheat reads 0/M and shows as failed
// while working. These helpers decide when that readout is stale.

// Patch ids whose captured pointer is new or different since the last poll.
// A patch that has not captured yet (null pointer) is not "changed".
export function changedCapturePointers(
  previous: ReadonlyMap<string, string | null>,
  current: ReadonlyMap<string, { pointer: string | null }>
): string[] {
  const changed: string[] = []
  for (const [patchId, info] of current) {
    if (info.pointer === null) continue
    if (previous.get(patchId) !== info.pointer) changed.push(patchId)
  }
  return changed
}

// Cheats with at least one anchor target riding on any of these patches.
export function cheatsAnchoredTo(cheats: readonly CheatDefinition[], patchIds: readonly string[]): CheatDefinition[] {
  if (patchIds.length === 0) return []
  const wanted = new Set(patchIds)
  return cheats.filter((cheat) =>
    cheat.targets.some((t) => (t as { kind?: string }).kind === 'anchor' && wanted.has((t as { patchId: string }).patchId))
  )
}

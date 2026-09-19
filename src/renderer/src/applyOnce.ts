import type { CheatDefinition, PatchCheat } from '../../main/store'

// The one-shot "Apply" path for a value cheat. A cheat anchored to a capture
// patch cannot resolve its target unless that patch is installed AND the game
// has since run the hooked method (that run is what fills the slot the anchor
// reads through). The freeze toggle already handles the first half; a plain
// oneShot call did not, so an anchored one-shot silently wrote nothing.
//
// This installs the anchors' patches that are not already live, retries the
// write until the game has run the hook, then restores only what it installed
// (a patch a freeze cheat shares stays up for that cheat).

export const APPLY_ATTEMPTS = 32
export const APPLY_RETRY_MS = 250

export interface ApplyOnceDeps {
  patches: PatchCheat[]
  isPatchEnabled(patchId: string): boolean
  applyPatch(patch: PatchCheat): Promise<{ ok: boolean; error: string | null }>
  restorePatch(patch: PatchCheat): Promise<boolean>
  oneShot(cheat: CheatDefinition): Promise<boolean>
  // Lets the caller mirror install/restore into its own UI state.
  markPatch(patchId: string, enabled: boolean): void
  sleep(ms: number): Promise<void>
}

export type ApplyOnceResult = { ok: true } | { ok: false; error: string }

function anchorPatchIds(cheat: CheatDefinition): string[] {
  const ids = cheat.targets
    .filter((t): t is { kind: 'anchor'; patchId: string; offset: string } => (t as { kind?: string }).kind === 'anchor')
    .map((t) => t.patchId)
  return [...new Set(ids)]
}

export async function applyOnce(cheat: CheatDefinition, deps: ApplyOnceDeps): Promise<ApplyOnceResult> {
  const anchorIds = anchorPatchIds(cheat)

  // No anchors: nothing to install and nothing to wait for.
  if (anchorIds.length === 0) {
    return (await deps.oneShot(cheat))
      ? { ok: true }
      : { ok: false, error: 'The write failed. Check the cheat is attached and its targets resolve.' }
  }

  const installedHere: PatchCheat[] = []
  const cleanUp = async (): Promise<void> => {
    for (const patch of installedHere) {
      await deps.restorePatch(patch)
      deps.markPatch(patch.id, false)
    }
  }

  for (const id of anchorIds) {
    const patch = deps.patches.find((p) => p.id === id)
    if (patch === undefined) {
      await cleanUp()
      return { ok: false, error: `This cheat's capture patch (${id}) is missing.` }
    }
    if (deps.isPatchEnabled(id)) continue
    const result = await deps.applyPatch(patch)
    if (!result.ok) {
      await cleanUp()
      return { ok: false, error: result.error ?? 'Could not install the capture patch.' }
    }
    installedHere.push(patch)
    deps.markPatch(id, true)
  }

  let written = false
  for (let attempt = 0; attempt < APPLY_ATTEMPTS && !written; attempt++) {
    written = await deps.oneShot(cheat)
    if (!written) await deps.sleep(APPLY_RETRY_MS)
  }
  await cleanUp()

  return written
    ? { ok: true }
    : {
        ok: false,
        error:
          "The game never ran the capture hook, so there was nothing to write to. Load into a save and do something that touches it (e.g. spend or pick up cash), then press Apply again."
      }
}

import type { PatchCheat } from './store'

// A cheat can name `internal` patches that must be armed while it is on (CheatDefinition.companions / PatchCheat.companions).
// Several cheats may share one companion, so each is armed by the first cheat that needs it and disarmed only when the last
// of them turns off. Companions are best-effort: the cheat itself must never fail because one could not be armed.
export interface CompanionDeps {
  // The patch with this id in the attached game's profile, if there is one.
  findPatch(id: string): PatchCheat | undefined
  arm(patch: PatchCheat): void
  disarm(patch: PatchCheat): void
}

export class CompanionTracker {
  // companion patch id -> ids of the cheats currently keeping it armed
  private users = new Map<string, Set<string>>()
  // cheat id -> the companion ids it asked for, so disable() needs nothing but the id
  private wanted = new Map<string, string[]>()

  constructor(private readonly deps: CompanionDeps) {}

  enable(cheatId: string, companions: string[] | undefined): void {
    if (!companions || companions.length === 0) return
    this.wanted.set(cheatId, companions)
    for (const id of companions) {
      const set = this.users.get(id) ?? new Set<string>()
      const first = set.size === 0
      set.add(cheatId)
      this.users.set(id, set)
      if (!first) continue
      const patch = this.deps.findPatch(id)
      if (!patch) continue
      try {
        this.deps.arm(patch)
      } catch {
        // not attached, or the patch cannot be located right now: the cheat still runs
      }
    }
  }

  disable(cheatId: string): void {
    const companions = this.wanted.get(cheatId)
    if (!companions) return
    this.wanted.delete(cheatId)
    for (const id of companions) {
      const set = this.users.get(id)
      if (!set || !set.delete(cheatId)) continue
      if (set.size > 0) continue
      this.users.delete(id)
      const patch = this.deps.findPatch(id)
      if (!patch) continue
      try {
        this.deps.disarm(patch)
      } catch {
        // already restored
      }
    }
  }

  // The process went away: every companion was restored with the rest of the patches.
  reset(): void {
    this.users.clear()
    this.wanted.clear()
  }
}

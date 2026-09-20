// getModuleBase walks the target's whole module list, ~15ms on a game with ~120
// modules, and the freeze loop asked for it once per target per 100ms tick: a
// cheat with 100 targets spent over a second of the main thread per tick and the
// window stopped responding. A module's base only changes if it is unloaded and
// loaded again, so a short-lived cache removes the cost and still heals itself.

const DEFAULT_TTL_MS = 2000

export class ModuleBaseCache {
  private entries = new Map<string, { base: string; at: number }>()

  constructor(
    private readonly lookup: (handle: number, moduleName: string) => string | null,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(handle: number, moduleName: string): string | null {
    const key = `${handle}:${moduleName.toLowerCase()}`
    const hit = this.entries.get(key)
    if (hit !== undefined && this.now() - hit.at < this.ttlMs) return hit.base
    const base = this.lookup(handle, moduleName)
    // Never cache a miss: a module that is not loaded yet must be found the
    // moment it appears.
    if (base === null) this.entries.delete(key)
    else this.entries.set(key, { base, at: this.now() })
    return base
  }

  // A closed handle can be reused by the OS for a different process.
  forget(handle: number): void {
    const prefix = `${handle}:`
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }
}

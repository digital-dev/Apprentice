import { isPatchCheat, type CheatDefinition, type PatchCheat, type StoredCheat } from './store'

export interface HotkeyDeps {
  loadCheats(exeName: string): StoredCheat[]
  isFreezeEnabled(cheatId: string): boolean
  enableFreeze(cheat: CheatDefinition): void
  disableFreeze(cheatId: string): void
  oneShot(cheat: CheatDefinition): Promise<boolean>
  isPatchApplied(patchId: string): boolean
  armPatch(patch: PatchCheat): void
  disarmPatch(patch: PatchCheat): void
  // Wraps Electron's globalShortcut.register — returns false when the OS
  // or another app already owns this accelerator.
  registerShortcut(accelerator: string, callback: () => void): boolean
  // Wraps Electron's globalShortcut.unregisterAll(). Electron scopes this
  // to shortcuts THIS app registered, not system-wide across other apps.
  unregisterAllShortcuts(): void
}

export type HotkeyOutcome = 'on' | 'off' | 'applied' | 'error'

// Owns every globally-registered hotkey for the currently-attached exe's
// cheats. Registration always happens as a full replace (unregisterAll then
// register every hotkeyed cheat/patch fresh) rather than an incremental
// diff — the set of cheats with a hotkey changes rarely (only on save), so
// the simplicity of "always rebuild from the current profile" outweighs the
// complexity of tracking exactly what changed since last time.
export class HotkeyManager {
  private deps: HotkeyDeps
  private firedCb: ((cheatId: string, outcome: HotkeyOutcome, error?: string) => void) | null = null
  private conflictCb: ((failed: { name: string; hotkey: string }[]) => void) | null = null

  constructor(deps: HotkeyDeps) {
    this.deps = deps
  }

  onFired(cb: (cheatId: string, outcome: HotkeyOutcome, error?: string) => void): void {
    this.firedCb = cb
  }

  onConflict(cb: (failed: { name: string; hotkey: string }[]) => void): void {
    this.conflictCb = cb
  }

  registerAll(exeName: string): void {
    this.deps.unregisterAllShortcuts()
    const cheats = this.deps.loadCheats(exeName)
    const failed: { name: string; hotkey: string }[] = []

    for (const cheat of cheats) {
      if (!cheat.hotkey) continue
      const ok = this.deps.registerShortcut(cheat.hotkey, () => this.fire(cheat))
      if (!ok) failed.push({ name: cheat.name, hotkey: cheat.hotkey })
    }

    if (failed.length > 0) this.conflictCb?.(failed)
  }

  unregisterAll(): void {
    this.deps.unregisterAllShortcuts()
  }

  private fire(cheat: StoredCheat): void {
    if (isPatchCheat(cheat)) {
      this.firePatch(cheat)
    } else {
      this.fireValueCheat(cheat)
    }
  }

  private fireValueCheat(cheat: CheatDefinition): void {
    if (cheat.mode === 'oneshot') {
      void this.deps
        .oneShot(cheat)
        .then((ok) => this.firedCb?.(cheat.id, ok ? 'applied' : 'error'))
        .catch(() => this.firedCb?.(cheat.id, 'error'))
      return
    }
    // freeze mode: toggle.
    if (this.deps.isFreezeEnabled(cheat.id)) {
      this.deps.disableFreeze(cheat.id)
      this.firedCb?.(cheat.id, 'off')
    } else {
      this.deps.enableFreeze(cheat)
      this.firedCb?.(cheat.id, 'on')
    }
  }

  private firePatch(patch: PatchCheat): void {
    if (this.deps.isPatchApplied(patch.id)) {
      this.deps.disarmPatch(patch)
      this.firedCb?.(patch.id, 'off')
    } else {
      this.deps.armPatch(patch)
      this.firedCb?.(patch.id, 'on')
    }
  }
}

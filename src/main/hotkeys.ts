import {
  isPatchCheat,
  isScriptCheat,
  type CheatDefinition,
  type PatchCheat,
  type ScriptCheat,
  type StoredCheat
} from './store'

export interface HotkeyDeps {
  loadCheats(exeName: string): StoredCheat[]
  isFreezeEnabled(cheatId: string): boolean
  enableFreeze(cheat: CheatDefinition): void
  disableFreeze(cheatId: string): void
  oneShot(cheat: CheatDefinition): Promise<boolean>
  isPatchArmed(patchId: string): boolean
  armPatch(patch: PatchCheat): void
  disarmPatch(patch: PatchCheat): void
  isScriptEnabled(cheatId: string): boolean
  // Both resolve even on failure — HotkeyOutcome 'error' is used in that
  // case, mirroring fireValueCheat's existing one-shot path, since a
  // script run is async and fallible the same way a one-shot write is
  // (unlike freeze/patch toggling, which cannot fail).
  runScriptEnable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
  runScriptDisable(cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }>
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
  // The failures from the most recent registerAll() call, so a caller that
  // only starts existing (and subscribing to onConflict) AFTER registerAll
  // already ran — e.g. the renderer mounting after process:attach's
  // synchronous registerAll — can still pull whatever it missed.
  private lastConflicts: { name: string; hotkey: string }[] = []

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

    this.lastConflicts = failed
    if (failed.length > 0) this.conflictCb?.(failed)
  }

  getConflicts(): { name: string; hotkey: string }[] {
    return this.lastConflicts
  }

  unregisterAll(): void {
    this.deps.unregisterAllShortcuts()
  }

  private fire(cheat: StoredCheat): void {
    if (isPatchCheat(cheat)) {
      this.firePatch(cheat)
    } else if (isScriptCheat(cheat)) {
      this.fireScript(cheat)
    } else {
      this.fireValueCheat(cheat)
    }
  }

  // Modeled on fireValueCheat's ONE-SHOT branch (async, can fail), not its
  // freeze branch (sync, infallible) — a script run is always fallible.
  private fireScript(cheat: ScriptCheat): void {
    const wasEnabled = this.deps.isScriptEnabled(cheat.id)
    const action = wasEnabled ? this.deps.runScriptDisable(cheat) : this.deps.runScriptEnable(cheat)
    void action
      .then((result) => {
        if (result.ok) {
          this.firedCb?.(cheat.id, wasEnabled ? 'off' : 'on')
        } else {
          this.firedCb?.(cheat.id, 'error', result.error ?? 'Script failed.')
        }
      })
      .catch((err) =>
        this.firedCb?.(cheat.id, 'error', err instanceof Error ? err.message : 'Script failed.')
      )
  }

  private fireValueCheat(cheat: CheatDefinition): void {
    if (cheat.mode === 'oneshot') {
      void this.deps
        .oneShot(cheat)
        .then((ok) =>
          this.firedCb?.(
            cheat.id,
            ok ? 'applied' : 'error',
            ok
              ? undefined
              : 'One-shot write failed — check the cheat is still attached and its targets resolve.'
          )
        )
        .catch((err) =>
          this.firedCb?.(cheat.id, 'error', err instanceof Error ? err.message : 'One-shot write failed.')
        )
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
    if (this.deps.isPatchArmed(patch.id)) {
      this.deps.disarmPatch(patch)
      this.firedCb?.(patch.id, 'off')
    } else {
      this.deps.armPatch(patch)
      this.firedCb?.(patch.id, 'on')
    }
  }
}

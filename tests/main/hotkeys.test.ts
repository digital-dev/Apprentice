import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HotkeyManager, HotkeyDeps, HotkeyOutcome } from '../../src/main/hotkeys'
import type { CheatDefinition, PatchCheat, ScriptCheat, StoredCheat } from '../../src/main/store'

const freezeCheat: CheatDefinition = {
  id: 'freeze1',
  name: 'Infinite Health',
  dataType: 'int32',
  mode: 'freeze',
  targets: [],
  value: 100,
  hotkey: 'F1'
}

const oneShotCheat: CheatDefinition = {
  id: 'oneshot1',
  name: 'Full Heal',
  dataType: 'int32',
  mode: 'oneshot',
  targets: [],
  value: 100,
  hotkey: 'F2'
}

const patch: PatchCheat = {
  kind: 'patch',
  mode: 'nop',
  id: 'patch1',
  name: 'Stop Drain',
  originalBytes: 'aa',
  length: 1,
  signature: 'aa',
  moduleName: null,
  moduleOffset: null,
  hotkey: 'F3'
}

type FakePatchState = 'idle' | 'arming' | 'active' | 'degraded' | 'failed'

class FakeDeps implements HotkeyDeps {
  cheats: StoredCheat[] = [freezeCheat, oneShotCheat, patch]
  freezeEnabled = new Set<string>()
  patchState = new Map<string, FakePatchState>()
  registered: { accelerator: string; callback: () => void }[] = []
  registerShouldFail = new Set<string>()
  unregisterAllCalls = 0
  oneShotResult = true
  scriptEnabled = new Set<string>()
  runScriptEnable = vi.fn(async (_cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }> => ({
    ok: true
  }))
  runScriptDisable = vi.fn(async (_cheat: ScriptCheat): Promise<{ ok: boolean; error?: string }> => ({
    ok: true
  }))

  loadCheats(): StoredCheat[] {
    return this.cheats
  }
  isFreezeEnabled(cheatId: string): boolean {
    return this.freezeEnabled.has(cheatId)
  }
  enableFreeze(cheat: CheatDefinition): void {
    this.freezeEnabled.add(cheat.id)
  }
  disableFreeze(cheatId: string): void {
    this.freezeEnabled.delete(cheatId)
  }
  async oneShot(): Promise<boolean> {
    return this.oneShotResult
  }
  isPatchArmed(patchId: string): boolean {
    const state = this.patchState.get(patchId) ?? 'idle'
    return state === 'arming' || state === 'active' || state === 'degraded'
  }
  armPatch(patch: PatchCheat): void {
    this.patchState.set(patch.id, 'arming')
  }
  disarmPatch(patch: PatchCheat): void {
    this.patchState.set(patch.id, 'idle')
  }
  isScriptEnabled(cheatId: string): boolean {
    return this.scriptEnabled.has(cheatId)
  }
  registerShortcut(accelerator: string, callback: () => void): boolean {
    if (this.registerShouldFail.has(accelerator)) return false
    this.registered.push({ accelerator, callback })
    return true
  }
  unregisterAllShortcuts(): void {
    this.unregisterAllCalls++
    this.registered = []
  }
}

describe('HotkeyManager', () => {
  let deps: FakeDeps
  let manager: HotkeyManager

  beforeEach(() => {
    deps = new FakeDeps()
    manager = new HotkeyManager(deps)
  })

  it('registers one shortcut per cheat/patch with a hotkey', () => {
    manager.registerAll('game.exe')
    expect(deps.registered.map((r) => r.accelerator).sort()).toEqual(['F1', 'F2', 'F3'])
  })

  it('unregisters everything before registering again', () => {
    manager.registerAll('game.exe')
    manager.registerAll('game.exe')
    expect(deps.unregisterAllCalls).toBe(2)
    expect(deps.registered).toHaveLength(3)
  })

  it('toggles a freeze cheat on, then off, on successive fires', () => {
    manager.registerAll('game.exe')
    const outcomes: HotkeyOutcome[] = []
    manager.onFired((_id, outcome) => outcomes.push(outcome))

    deps.registered.find((r) => r.accelerator === 'F1')?.callback()
    expect(deps.freezeEnabled.has('freeze1')).toBe(true)
    expect(outcomes).toEqual(['on'])

    deps.registered.find((r) => r.accelerator === 'F1')?.callback()
    expect(deps.freezeEnabled.has('freeze1')).toBe(false)
    expect(outcomes).toEqual(['on', 'off'])
  })

  it('always reports a one-shot as applied, never on/off', async () => {
    manager.registerAll('game.exe')
    const outcomes: HotkeyOutcome[] = []
    manager.onFired((_id, outcome) => outcomes.push(outcome))

    deps.registered.find((r) => r.accelerator === 'F2')?.callback()
    await new Promise((r) => setTimeout(r, 0)) // let the async oneShot settle
    expect(outcomes).toEqual(['applied'])
  })

  it('reports error when a one-shot write fails', async () => {
    deps.oneShotResult = false
    manager.registerAll('game.exe')
    const outcomes: HotkeyOutcome[] = []
    manager.onFired((_id, outcome) => outcomes.push(outcome))

    deps.registered.find((r) => r.accelerator === 'F2')?.callback()
    await new Promise((r) => setTimeout(r, 0))
    expect(outcomes).toEqual(['error'])
  })

  it('arms, then disarms, a patch on successive fires', () => {
    manager.registerAll('game.exe')
    const outcomes: HotkeyOutcome[] = []
    manager.onFired((_id, outcome) => outcomes.push(outcome))

    deps.registered.find((r) => r.accelerator === 'F3')?.callback()
    expect(deps.patchState.get('patch1')).toBe('arming')
    expect(outcomes).toEqual(['on'])

    deps.registered.find((r) => r.accelerator === 'F3')?.callback()
    expect(deps.patchState.get('patch1')).toBe('idle')
    expect(outcomes).toEqual(['on', 'off'])
  })

  it('disarms (not re-arms) a patch stuck mid-arming on the next fire', () => {
    // Regression for the isPatchApplied bug: patchEngine.isApplied() only
    // flips true once a full locate+apply round trip succeeds, which lags
    // well behind arm()'s own no-op guard on 'arming'/'active'/'degraded'.
    // A patch stuck in 'arming' used to read as "not applied" forever, so
    // every press re-called armPatch (a no-op) and endlessly reported 'on'
    // — never disarming. isPatchArmed must treat 'arming' as armed.
    deps.patchState.set('patch1', 'arming')
    manager.registerAll('game.exe')
    const outcomes: HotkeyOutcome[] = []
    manager.onFired((_id, outcome) => outcomes.push(outcome))

    deps.registered.find((r) => r.accelerator === 'F3')?.callback()

    expect(deps.patchState.get('patch1')).toBe('idle')
    expect(outcomes).toEqual(['off'])
  })

  it('reports a registration failure as a conflict, and still registers the rest', () => {
    deps.registerShouldFail.add('F2')
    const conflicts: { name: string; hotkey: string }[][] = []
    manager.onConflict((failed) => conflicts.push(failed))

    manager.registerAll('game.exe')

    expect(deps.registered.map((r) => r.accelerator).sort()).toEqual(['F1', 'F3'])
    expect(conflicts).toEqual([[{ name: 'Full Heal', hotkey: 'F2' }]])
  })

  it('getConflicts returns the last registerAll failures', () => {
    deps.registerShouldFail.add('F2')
    const conflicts: { name: string; hotkey: string }[][] = []
    manager.onConflict((failed) => conflicts.push(failed))

    manager.registerAll('game.exe')

    expect(manager.getConflicts()).toEqual(conflicts[0])
    expect(manager.getConflicts()).toEqual([{ name: 'Full Heal', hotkey: 'F2' }])
  })

  it('getConflicts resets to empty after a clean registerAll', () => {
    deps.registerShouldFail.add('F2')
    manager.registerAll('game.exe')
    expect(manager.getConflicts()).toEqual([{ name: 'Full Heal', hotkey: 'F2' }])

    deps.registerShouldFail.clear()
    manager.registerAll('game.exe')
    expect(manager.getConflicts()).toEqual([])
  })

  it('unregisterAll clears everything', () => {
    manager.registerAll('game.exe')
    manager.unregisterAll()
    expect(deps.unregisterAllCalls).toBe(2)
  })

  it('fires a script cheat: runs enableScript when currently off, reports on', async () => {
    const script: ScriptCheat = {
      kind: 'script',
      id: 's1',
      name: 'S1',
      enableScript: 'writeInt32(0, 1)',
      disableScript: '',
      hotkey: 'F5'
    }
    deps.cheats = [script]
    manager.registerAll('game.exe')
    const outcomes: [string, HotkeyOutcome, string?][] = []
    manager.onFired((id, outcome, error) => outcomes.push([id, outcome, error]))

    deps.registered.find((r) => r.accelerator === 'F5')?.callback()
    await new Promise((r) => setTimeout(r, 0))

    expect(deps.runScriptEnable).toHaveBeenCalledWith(script)
    expect(outcomes).toEqual([['s1', 'on', undefined]])
  })

  it('reports outcome "error" when a script run fails', async () => {
    const script: ScriptCheat = {
      kind: 'script',
      id: 's1',
      name: 'S1',
      enableScript: 'error("boom")',
      disableScript: '',
      hotkey: 'F5'
    }
    deps.cheats = [script]
    deps.runScriptEnable = vi.fn(async () => ({ ok: false, error: 'boom' }))
    manager.registerAll('game.exe')
    const outcomes: [string, HotkeyOutcome, string?][] = []
    manager.onFired((id, outcome, error) => outcomes.push([id, outcome, error]))

    deps.registered.find((r) => r.accelerator === 'F5')?.callback()
    await new Promise((r) => setTimeout(r, 0))

    expect(outcomes).toEqual([['s1', 'error', 'boom']])
  })
})

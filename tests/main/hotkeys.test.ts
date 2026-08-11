import { describe, it, expect, beforeEach } from 'vitest'
import { HotkeyManager, HotkeyDeps, HotkeyOutcome } from '../../src/main/hotkeys'
import type { CheatDefinition, PatchCheat, StoredCheat } from '../../src/main/store'

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

class FakeDeps implements HotkeyDeps {
  cheats: StoredCheat[] = [freezeCheat, oneShotCheat, patch]
  freezeEnabled = new Set<string>()
  patchApplied = new Set<string>()
  registered: { accelerator: string; callback: () => void }[] = []
  registerShouldFail = new Set<string>()
  unregisterAllCalls = 0
  oneShotResult = true

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
  isPatchApplied(patchId: string): boolean {
    return this.patchApplied.has(patchId)
  }
  armPatch(patch: PatchCheat): void {
    this.patchApplied.add(patch.id)
  }
  disarmPatch(patch: PatchCheat): void {
    this.patchApplied.delete(patch.id)
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
    expect(deps.patchApplied.has('patch1')).toBe(true)
    expect(outcomes).toEqual(['on'])

    deps.registered.find((r) => r.accelerator === 'F3')?.callback()
    expect(deps.patchApplied.has('patch1')).toBe(false)
    expect(outcomes).toEqual(['on', 'off'])
  })

  it('reports a registration failure as a conflict, and still registers the rest', () => {
    deps.registerShouldFail.add('F2')
    const conflicts: { name: string; hotkey: string }[][] = []
    manager.onConflict((failed) => conflicts.push(failed))

    manager.registerAll('game.exe')

    expect(deps.registered.map((r) => r.accelerator).sort()).toEqual(['F1', 'F3'])
    expect(conflicts).toEqual([[{ name: 'Full Heal', hotkey: 'F2' }]])
  })

  it('unregisterAll clears everything', () => {
    manager.registerAll('game.exe')
    manager.unregisterAll()
    expect(deps.unregisterAllCalls).toBe(2)
  })
})

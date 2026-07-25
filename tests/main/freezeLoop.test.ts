import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FreezeLoop } from '../../src/main/freezeLoop'
import type { CheatDefinition } from '../../src/main/store'

const cheat: CheatDefinition = {
  id: 'stamina',
  name: 'Unlimited Stamina',
  dataType: 'float',
  mode: 'freeze',
  targets: [{ moduleName: 'valheim.exe', baseOffset: '0x1000', offsets: ['0x8'] }],
  value: 999
}

// Small threshold so tests don't have to advance 20 ticks.
const DEGRADE_AFTER = 3

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('FreezeLoop', () => {
  it('calls writeFn repeatedly for an enabled freeze cheat on each tick', () => {
    const writeFn = vi.fn().mockReturnValue(true)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    loop.start()
    loop.enable(cheat)

    vi.advanceTimersByTime(350)

    expect(writeFn).toHaveBeenCalledTimes(3)
    expect(writeFn).toHaveBeenCalledWith(cheat)
    loop.stop()
  })

  it('stops calling writeFn after disable', () => {
    const writeFn = vi.fn().mockReturnValue(true)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    loop.start()
    loop.enable(cheat)
    vi.advanceTimersByTime(150)
    loop.disable(cheat.id)
    vi.advanceTimersByTime(500)

    expect(writeFn).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('does not flag degraded before the failure threshold is reached', () => {
    const writeFn = vi.fn().mockReturnValue(false)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    loop.onDegraded(degraded)
    loop.start()
    loop.enable(cheat)

    vi.advanceTimersByTime(250) // 2 failed ticks, threshold is 3
    expect(degraded).not.toHaveBeenCalled()
    loop.stop()
  })

  it('flags degraded after threshold consecutive failures but keeps retrying', () => {
    const writeFn = vi.fn().mockReturnValue(false)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    loop.onDegraded(degraded)
    loop.start()
    loop.enable(cheat)

    vi.advanceTimersByTime(350) // 3 failed ticks -> degraded on the 3rd
    expect(degraded).toHaveBeenCalledTimes(1)
    expect(degraded).toHaveBeenCalledWith('stamina')

    // Still being retried after going degraded (self-heal requires it).
    const callsAtDegrade = writeFn.mock.calls.length
    vi.advanceTimersByTime(500)
    expect(writeFn.mock.calls.length).toBeGreaterThan(callsAtDegrade)
    // Degraded fires only once, not every subsequent failed tick.
    expect(degraded).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('recovers and clears degraded when writes succeed again', () => {
    let succeed = false
    const writeFn = vi.fn(() => succeed)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    const recovered = vi.fn()
    loop.onDegraded(degraded)
    loop.onRecovered(recovered)
    loop.start()
    loop.enable(cheat)

    vi.advanceTimersByTime(350)
    expect(degraded).toHaveBeenCalledTimes(1)

    succeed = true
    vi.advanceTimersByTime(100)
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(recovered).toHaveBeenCalledWith('stamina')

    // A later transient failure can degrade again (counter was reset).
    succeed = false
    vi.advanceTimersByTime(350)
    expect(degraded).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('resets the failure counter on any success, so brief blips do not degrade', () => {
    let succeed = true
    const writeFn = vi.fn(() => succeed)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    loop.onDegraded(degraded)
    loop.start()
    loop.enable(cheat)

    // Alternating fail/success never reaches 3 consecutive failures.
    for (let i = 0; i < 10; i++) {
      succeed = false
      vi.advanceTimersByTime(100)
      succeed = true
      vi.advanceTimersByTime(100)
    }
    expect(degraded).not.toHaveBeenCalled()
    loop.stop()
  })
})

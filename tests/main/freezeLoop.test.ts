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

// WriteFn is now async (Promise<boolean>) — tick() awaits each tick's
// writes via Promise.all before updating failCounts/degraded/recovered, so
// those side effects land as microtasks queued after the fake timer fires,
// not synchronously within it. vi.advanceTimersByTimeAsync drains
// microtasks between each fired timer (unlike the synchronous
// vi.advanceTimersByTime), so assertions after it observe up-to-date state.
// The loop's actual cadence/threshold logic is unchanged; only how the
// tests observe it changed.
describe('FreezeLoop', () => {
  it('calls writeFn repeatedly for an enabled freeze cheat on each tick', async () => {
    const writeFn = vi.fn().mockResolvedValue(true)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    loop.start()
    loop.enable(cheat)

    await vi.advanceTimersByTimeAsync(350)

    expect(writeFn).toHaveBeenCalledTimes(3)
    expect(writeFn).toHaveBeenCalledWith(cheat)
    loop.stop()
  })

  it('stops calling writeFn after disable', async () => {
    const writeFn = vi.fn().mockResolvedValue(true)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    loop.start()
    loop.enable(cheat)
    await vi.advanceTimersByTimeAsync(150)
    loop.disable(cheat.id)
    await vi.advanceTimersByTimeAsync(500)

    expect(writeFn).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('does not flag degraded before the failure threshold is reached', async () => {
    const writeFn = vi.fn().mockResolvedValue(false)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    loop.onDegraded(degraded)
    loop.start()
    loop.enable(cheat)

    await vi.advanceTimersByTimeAsync(250) // 2 failed ticks, threshold is 3
    expect(degraded).not.toHaveBeenCalled()
    loop.stop()
  })

  it('flags degraded after threshold consecutive failures but keeps retrying', async () => {
    const writeFn = vi.fn().mockResolvedValue(false)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    loop.onDegraded(degraded)
    loop.start()
    loop.enable(cheat)

    await vi.advanceTimersByTimeAsync(350) // 3 failed ticks -> degraded on the 3rd
    expect(degraded).toHaveBeenCalledTimes(1)
    expect(degraded).toHaveBeenCalledWith('stamina')

    // Still being retried after going degraded (self-heal requires it).
    const callsAtDegrade = writeFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(writeFn.mock.calls.length).toBeGreaterThan(callsAtDegrade)
    // Degraded fires only once, not every subsequent failed tick.
    expect(degraded).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('recovers and clears degraded when writes succeed again', async () => {
    let succeed = false
    const writeFn = vi.fn(async () => succeed)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    const recovered = vi.fn()
    loop.onDegraded(degraded)
    loop.onRecovered(recovered)
    loop.start()
    loop.enable(cheat)

    await vi.advanceTimersByTimeAsync(350)
    expect(degraded).toHaveBeenCalledTimes(1)

    succeed = true
    await vi.advanceTimersByTimeAsync(100)
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(recovered).toHaveBeenCalledWith('stamina')

    // A later transient failure can degrade again (counter was reset).
    succeed = false
    await vi.advanceTimersByTimeAsync(350)
    expect(degraded).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('resets the failure counter on any success, so brief blips do not degrade', async () => {
    let succeed = true
    const writeFn = vi.fn(async () => succeed)
    const loop = new FreezeLoop(writeFn, 100, DEGRADE_AFTER)
    const degraded = vi.fn()
    loop.onDegraded(degraded)
    loop.start()
    loop.enable(cheat)

    // Alternating fail/success never reaches 3 consecutive failures.
    for (let i = 0; i < 10; i++) {
      succeed = false
      await vi.advanceTimersByTimeAsync(100)
      succeed = true
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(degraded).not.toHaveBeenCalled()
    loop.stop()
  })
})

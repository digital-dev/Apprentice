import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FreezeLoop } from '../../src/main/freezeLoop'
import type { CheatDefinition } from '../../src/main/store'

const cheat: CheatDefinition = {
  id: 'stamina',
  name: 'Unlimited Stamina',
  dataType: 'float',
  mode: 'freeze',
  moduleName: 'valheim.exe',
  baseOffset: '0x1000',
  offsets: ['0x8'],
  value: 999
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('FreezeLoop', () => {
  it('calls writeFn repeatedly for an enabled freeze cheat on each tick', () => {
    const writeFn = vi.fn().mockReturnValue(true)
    const loop = new FreezeLoop(writeFn, 100)
    loop.start()
    loop.enable(cheat)

    vi.advanceTimersByTime(350)

    expect(writeFn).toHaveBeenCalledTimes(3)
    expect(writeFn).toHaveBeenCalledWith(cheat)
    loop.stop()
  })

  it('stops calling writeFn after disable', () => {
    const writeFn = vi.fn().mockReturnValue(true)
    const loop = new FreezeLoop(writeFn, 100)
    loop.start()
    loop.enable(cheat)
    vi.advanceTimersByTime(150)
    loop.disable(cheat.id)
    vi.advanceTimersByTime(500)

    expect(writeFn).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('auto-disables and fires onBroken when writeFn returns false', () => {
    const writeFn = vi.fn().mockReturnValue(false)
    const loop = new FreezeLoop(writeFn, 100)
    const broken = vi.fn()
    loop.onBroken(broken)
    loop.start()
    loop.enable(cheat)

    vi.advanceTimersByTime(150)

    expect(broken).toHaveBeenCalledWith('stamina')
    vi.advanceTimersByTime(500)
    expect(writeFn).toHaveBeenCalledTimes(1) // did not keep retrying a broken chain
    loop.stop()
  })
})

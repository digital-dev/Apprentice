import { describe, it, expect, beforeEach } from 'vitest'
import { CheatRuntime, RuntimeDeps, Clock, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from '../../src/main/cheatRuntime'
import type { AnchorReason } from '../../src/main/anchor'
import type { PatchCheat } from '../../src/main/store'

const patch: PatchCheat = {
  kind: 'patch',
  id: 'p1',
  name: 'P1',
  originalBytes: 'f30f114110',
  length: 5,
  signature: 'f3 0f 11 41 10',
  moduleName: null,
  moduleOffset: null
}

// A clock whose pending timers only fire when the test says so, so backoff
// is asserted by its scheduled delay rather than by waiting in real time.
class FakeClock implements Clock {
  pending: { fn: () => void; ms: number }[] = []
  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { fn, ms }
    this.pending.push(entry)
    return entry
  }
  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p !== handle)
  }
  async fireNext(): Promise<void> {
    const next = this.pending.shift()
    next?.fn()
    // Let the async work the timer kicked off settle.
    await new Promise((r) => setTimeout(r, 0))
  }
}

class FakeDeps implements RuntimeDeps {
  located: { address: string | null; reason: AnchorReason | null } = { address: '0x1000', reason: null }
  applyResult = { ok: true, error: null as string | null }
  verified = true
  restored: string[] = []
  applyCalls = 0
  restoreShouldFail = false

  async locate(): Promise<{ address: string | null; reason: AnchorReason | null }> {
    return this.located
  }
  async apply(): Promise<{ ok: boolean; error: string | null }> {
    this.applyCalls++
    return this.applyResult
  }
  restore(p: PatchCheat): boolean {
    this.restored.push(p.id)
    return !this.restoreShouldFail
  }
  isVerified(): boolean {
    return this.verified
  }
}

let deps: FakeDeps
let clock: FakeClock
let runtime: CheatRuntime

beforeEach(() => {
  deps = new FakeDeps()
  clock = new FakeClock()
  runtime = new CheatRuntime(deps, clock)
})

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('CheatRuntime', () => {
  it('starts idle', () => {
    expect(runtime.status('p1').state).toBe('idle')
  })

  it('goes arming then active when the patch resolves and applies', async () => {
    runtime.arm(patch)
    expect(runtime.status('p1').state).toBe('arming')
    await settle()
    expect(runtime.status('p1').state).toBe('active')
    expect(runtime.status('p1').address).toBe('0x1000')
  })

  it('stays arming and schedules a retry when the code is not compiled yet', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('arming')
    expect(runtime.status('p1').reason).toBe('not-yet-compiled')
    expect(clock.pending).toHaveLength(1)
  })

  it('backs off exponentially and caps', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    expect(clock.pending[0].ms).toBe(BACKOFF_BASE_MS)
    await clock.fireNext()
    expect(clock.pending[0].ms).toBe(BACKOFF_BASE_MS * 2)
    for (let i = 0; i < 10; i++) await clock.fireNext()
    expect(clock.pending[0].ms).toBe(BACKOFF_CAP_MS)
  })

  it('retries no-match and module-missing', async () => {
    for (const reason of ['no-match', 'module-missing'] as AnchorReason[]) {
      deps = new FakeDeps()
      clock = new FakeClock()
      runtime = new CheatRuntime(deps, clock)
      deps.located = { address: null, reason }
      runtime.arm(patch)
      await settle()
      expect(runtime.status('p1').state).toBe('arming')
      expect(clock.pending).toHaveLength(1)
    }
  })

  it('retries mono-not-loaded and mono-assembly-not-loaded', async () => {
    for (const reason of ['mono-not-loaded', 'mono-assembly-not-loaded'] as AnchorReason[]) {
      deps = new FakeDeps()
      clock = new FakeClock()
      runtime = new CheatRuntime(deps, clock)
      deps.located = { address: null, reason }
      runtime.arm(patch)
      await settle()
      expect(runtime.status('p1').state).toBe('arming')
      expect(clock.pending).toHaveLength(1)
    }
  })

  it('fails immediately on reasons waiting cannot fix', async () => {
    for (const reason of ['ambiguous', 'bytes-differ'] as AnchorReason[]) {
      deps = new FakeDeps()
      clock = new FakeClock()
      runtime = new CheatRuntime(deps, clock)
      deps.located = { address: null, reason }
      runtime.arm(patch)
      await settle()
      expect(runtime.status('p1').state).toBe('failed')
      expect(clock.pending).toHaveLength(0)
    }
  })

  it('fails when apply refuses', async () => {
    deps.applyResult = { ok: false, error: 'nope' }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('failed')
  })

  it('recovers into active when a retry succeeds', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    deps.located = { address: '0x2000', reason: null }
    await clock.fireNext()
    expect(runtime.status('p1').state).toBe('active')
    expect(runtime.status('p1').attempts).toBeGreaterThan(0)
  })

  it('disarm restores and cancels a pending retry', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    runtime.disarm('p1', patch)
    expect(clock.pending).toHaveLength(0)
    expect(deps.restored).toContain('p1')
    expect(runtime.status('p1').state).toBe('idle')
  })

  it('does not report idle when disarm\'s restore write fails', async () => {
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('active')
    deps.restoreShouldFail = true
    runtime.disarm('p1', patch)
    const status = runtime.status('p1')
    expect(status.state).not.toBe('idle')
    expect(status.state).toBe('failed')
    expect(status.reason).toBe('restore-failed')
  })

  it('re-arming a failed cheat starts over', async () => {
    deps.located = { address: null, reason: 'ambiguous' }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('failed')
    runtime.disarm('p1', patch)
    deps.located = { address: '0x1000', reason: null }
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').state).toBe('active')
  })

  it('carries the unverified flag without blocking arming', async () => {
    deps.verified = false
    runtime.arm(patch)
    await settle()
    expect(runtime.status('p1').unverified).toBe(true)
    expect(runtime.status('p1').state).toBe('active')
  })

  it('marks degraded and recovers', async () => {
    runtime.arm(patch)
    await settle()
    runtime.markDegraded('p1')
    expect(runtime.status('p1').state).toBe('degraded')
    runtime.markRecovered('p1')
    expect(runtime.status('p1').state).toBe('active')
  })

  it('process exit resets everything to idle and cancels retries', async () => {
    deps.located = { address: null, reason: 'not-yet-compiled' }
    runtime.arm(patch)
    await settle()
    runtime.processExited()
    expect(runtime.status('p1').state).toBe('idle')
    expect(clock.pending).toHaveLength(0)
    // No restore: the process is gone and its code went with it. Calling
    // restore here would write into a dead handle.
    expect(deps.restored).toHaveLength(0)
  })

  it('notifies on every transition', async () => {
    const seen: string[] = []
    runtime.onChange((id, status) => seen.push(`${id}:${status.state}`))
    runtime.arm(patch)
    await settle()
    expect(seen).toContain('p1:arming')
    expect(seen).toContain('p1:active')
  })

  it('arming a cheat that is already active is a no-op', async () => {
    runtime.arm(patch)
    await settle()
    const before = deps.applyCalls
    runtime.arm(patch)
    await settle()
    expect(deps.applyCalls).toBe(before)
  })

  it('a stale attempt from before a disarm+re-arm race does not clobber the new arm', async () => {
    // Hold the first locate() forever so its attempt() is still mid-await
    // when we disarm and re-arm. If the stale continuation isn't fenced by
    // generation, its eventual resolution overwrites the state the new
    // arm() produced and registers a second, orphaned retry timer.
    let releaseFirst: (() => void) | null = null
    const firstLocate = new Promise<void>((r) => (releaseFirst = r))
    let locateCalls = 0
    deps.locate = async () => {
      locateCalls++
      if (locateCalls === 1) {
        await firstLocate
        return { address: null, reason: 'not-yet-compiled' as AnchorReason }
      }
      return { address: '0x9000', reason: null }
    }

    runtime.arm(patch) // starts attempt #1, which blocks inside locate()
    runtime.disarm('p1', patch)
    runtime.arm(patch) // starts attempt #2 while #1 is still pending
    await settle()
    expect(runtime.status('p1').state).toBe('active')
    expect(runtime.status('p1').address).toBe('0x9000')

    // Now let the stale first attempt resolve. It should be a no-op: no
    // clobbered state, no orphaned retry timer.
    releaseFirst!()
    await settle()
    expect(runtime.status('p1').state).toBe('active')
    expect(runtime.status('p1').address).toBe('0x9000')
    expect(clock.pending).toHaveLength(0)
  })
})

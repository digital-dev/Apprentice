import { describe, it, expect, beforeEach } from 'vitest'
import { ProcessWatcher, WatcherDeps, IntervalClock, POLL_INTERVAL_MS } from '../../src/main/watcher'

class FakeClock implements IntervalClock {
  fn: (() => void) | null = null
  ms = 0
  setInterval(fn: () => void, ms: number): unknown {
    this.fn = fn
    this.ms = ms
    return 'timer'
  }
  clearInterval(): void {
    this.fn = null
  }
}

class FakeDeps implements WatcherDeps {
  processes: { pid: number; name: string }[] = []
  profiles = new Set<string>(['valheim'])
  listProcesses(): { pid: number; name: string }[] {
    return this.processes
  }
  hasProfile(exeName: string): boolean {
    return this.profiles.has(exeName.replace(/\.exe$/i, '').toLowerCase())
  }
}

let deps: FakeDeps
let clock: FakeClock
let watcher: ProcessWatcher
let appeared: { pid: number; name: string }[]
let vanished: { pid: number; name: string }[]

beforeEach(() => {
  deps = new FakeDeps()
  clock = new FakeClock()
  watcher = new ProcessWatcher(deps, clock)
  appeared = []
  vanished = []
  watcher.onAppear((p) => appeared.push(p))
  watcher.onVanish((p) => vanished.push(p))
})

describe('ProcessWatcher', () => {
  it('polls on the documented interval', () => {
    watcher.start()
    expect(clock.ms).toBe(POLL_INTERVAL_MS)
  })

  it('reports a process with a profile appearing', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    expect(appeared).toEqual([{ pid: 10, name: 'valheim.exe' }])
  })

  it('ignores a process with no profile', () => {
    deps.processes = [{ pid: 11, name: 'notepad.exe' }]
    watcher.tick()
    expect(appeared).toHaveLength(0)
  })

  it('does not report the same process twice', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    watcher.tick()
    expect(appeared).toHaveLength(1)
  })

  it('reports it vanishing', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    deps.processes = []
    watcher.tick()
    expect(vanished).toEqual([{ pid: 10, name: 'valheim.exe' }])
  })

  it('treats a relaunch under a new pid as vanish then appear', () => {
    deps.processes = [{ pid: 10, name: 'valheim.exe' }]
    watcher.tick()
    deps.processes = [{ pid: 20, name: 'valheim.exe' }]
    watcher.tick()
    expect(vanished).toHaveLength(1)
    expect(appeared).toHaveLength(2)
    expect(appeared[1].pid).toBe(20)
  })

  it('matches profiles case-insensitively', () => {
    deps.processes = [{ pid: 10, name: 'Valheim.exe' }]
    watcher.tick()
    expect(appeared).toHaveLength(1)
  })

  it('survives listProcesses throwing', () => {
    deps.listProcesses = () => {
      throw new Error('snapshot failed')
    }
    expect(() => watcher.tick()).not.toThrow()
  })

  it('stop cancels the interval', () => {
    watcher.start()
    watcher.stop()
    expect(clock.fn).toBeNull()
  })
})

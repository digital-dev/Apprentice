import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnHarness } from '../helpers/spawnHarness'
import addon from '../../native/build/Release/memory_addon.node'

// Pins that attach/detach still pair OpenProcess with CloseProcess after the
// platform-layer port. OS HANDLEs opened by the addon are invisible to libuv,
// so this measures the Windows handle count of this very process instead.
function handleCount(): number {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).HandleCount`],
    { encoding: 'utf8' },
  )
  return parseInt(out.trim(), 10)
}

let harness: ChildProcessWithoutNullStreams

beforeAll(() => {
  if (process.platform === 'win32') harness = spawnHarness()
})

afterAll(() => {
  if (!harness) return
  harness.stdin.write('q\n')
  harness.kill()
})

describe('attach/detach handle hygiene', () => {
  it.skipIf(process.platform !== 'win32')(
    '200 attach/detach cycles do not leak process handles',
    () => {
      const cycle = () => {
        const { handle } = (addon as any).attach(harness.pid)
        expect((addon as any).detach(handle)).toBe(true)
      }
      cycle() // warm up lazily-created handles before the baseline
      const before = handleCount()
      for (let i = 0; i < 200; i++) cycle()
      const after = handleCount()
      expect(after - before).toBeLessThan(20)
    },
    60_000,
  )
})

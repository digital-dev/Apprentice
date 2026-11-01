import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import addon from '../../native/build/Release/memory_addon.node'
import { startHarness, stopHarness, HARNESS_WINE, HARNESS_HOOK_TIMEOUT_MS } from '../helpers/spawnHarness'

// The Linux ptrace backend (Linux/native/ptrace_core.cc, tracer_thread.cc, platform_linux_ptrace.cc):
// suspend/resume, registers, refusal paths. Every test that can leave the harness stopped resumes,
// SIGCONTs and kills it in afterEach; only the harness and helpers spawned here are ever traced.
const a = addon as any
const ADDON_PATH = path.resolve('native/build/Release/memory_addon.node')
const DENIED = 'ptrace denied: run with CAP_SYS_PTRACE or set /proc/sys/kernel/yama/ptrace_scope to 0'
const IS_ROOT = process.platform !== 'win32' && process.getuid!() === 0
// Tests where a sibling process (not a descendant of the harness) must attach to it. Under Yama
// ptrace_scope>=1 that needs the target to call prctl(PR_SET_PTRACER_ANY), which only the native
// ELF harness has (`allowptrace`); the Windows harness run under Wine cannot. Root bypasses Yama,
// which is why this only surfaced on a non-root CI runner. Native ELF still covers these.
function yamaScope(): number {
  try {
    return parseInt(fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8'), 10)
  } catch {
    return 0
  }
}
const SIBLING_ATTACH_UNAVAILABLE = HARNESS_WINE && !IS_ROOT && yamaScope() >= 1
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let harness: ChildProcessWithoutNullStreams | undefined
let pid = 0
let handle = 0
let helpers: ChildProcess[] = []
// Node saw the harness exit. Must stay false in tests that keep it alive: libuv taking a ptrace
// stop of the leader for an exit would set it (and close the harness's stdio).
let harnessExited = false
let lines: string[] = []
let waiter: ((l: string) => void) | null = null

// Next line the harness prints, or null after `ms`.
function nextLine(ms: number): Promise<string | null> {
  if (lines.length) return Promise.resolve(lines.shift()!)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiter = null
      resolve(null)
    }, ms)
    waiter = (l) => {
      clearTimeout(timer)
      waiter = null
      resolve(l)
    }
  })
}

function send(cmd: string, ms = 3000): Promise<string | null> {
  harness!.stdin.write(cmd + '\n')
  return nextLine(ms)
}

function tasks(p: number): string[] {
  try {
    return fs.readdirSync(`/proc/${p}/task`)
  } catch {
    return []
  }
}

// State letter of each thread ('t' = ptrace-stopped).
function taskStates(p: number): string[] {
  return tasks(p).map((t) => {
    try {
      const s = fs.readFileSync(`/proc/${p}/task/${t}/stat`, 'utf8')
      return s.slice(s.lastIndexOf(')') + 2, s.lastIndexOf(')') + 3)
    } catch {
      return '?'
    }
  })
}

function tracerPids(p: number): number[] {
  return tasks(p).map((t) => {
    try {
      const m = /TracerPid:\s*(\d+)/.exec(fs.readFileSync(`/proc/${p}/task/${t}/status`, 'utf8'))
      return m ? Number(m[1]) : 0
    } catch {
      return 0
    }
  })
}

const allStopped = (p: number) => {
  const s = taskStates(p)
  return s.length > 0 && s.every((x) => x === 't')
}
const noneTraced = (p: number) => !taskStates(p).includes('t') && tracerPids(p).every((x) => x === 0)

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

// Runs `fn(addon, data)` inside a fresh worker thread (a different Node thread from this one).
function inWorker(fn: string): Promise<any> {
  const code =
    `const { parentPort, workerData } = require('node:worker_threads');` +
    `const a = require(workerData.addon); let r;` +
    `try { r = (${fn})(a, workerData) } catch (e) { r = { error: e.message } }` +
    `parentPort.postMessage(r)`
  const w = new Worker(code, { eval: true, workerData: { addon: ADDON_PATH, pid, handle } })
  return new Promise((resolve, reject) => {
    w.once('message', (m) => {
      resolve(m)
      void w.terminate()
    })
    w.once('error', reject)
  })
}

function spawnHelper(cmd: string, args: string[]): ChildProcessWithoutNullStreams {
  const c = spawn(cmd, args)
  helpers.push(c)
  return c
}

function firstLine(c: ChildProcessWithoutNullStreams, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = ''
    const timer = setTimeout(() => resolve(null), ms)
    c.stdout.on('data', (d) => {
      buf += d.toString()
      const i = buf.indexOf('\n')
      if (i >= 0) {
        clearTimeout(timer)
        resolve(buf.slice(0, i).trim())
      }
    })
  })
}

describe.skipIf(process.platform === 'win32')('Linux ptrace backend', () => {
  beforeEach(async () => {
    lines = []
    waiter = null
    harness = await startHarness()
    pid = harness.pid!
    harnessExited = false
    const current = harness
    harness.once('exit', () => {
      if (harness === current) harnessExited = true // not a previous test's harness exiting late
    })
    let buf = ''
    harness.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (waiter) waiter(l)
        else lines.push(l)
      }
    })
    handle = a.attach(pid).handle
  }, HARNESS_HOOK_TIMEOUT_MS)

  afterEach(async () => {
    try { a.resumeThreads() } catch { /* nothing held */ }
    for (const h of helpers) { try { h.kill('SIGKILL') } catch { /* gone */ } }
    helpers = []
    try { process.kill(pid, 'SIGCONT') } catch { /* gone */ }
    try { a.detach(handle) } catch { /* ignore */ }
    const h = harness
    harness = undefined
    await stopHarness(h)
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }, HARNESS_HOOK_TIMEOUT_MS)

  it('suspends all harness threads then resumes: harness ping answers only after resume', async () => {
    expect(await send('forceloop')).toBe('OK')
    expect(await send('tightloop')).toBe('OK')
    if (!HARNESS_WINE) expect(await send('spawnthreads 8')).toBe('OK')
    await sleep(100)

    expect(a.suspendThreads(handle, pid)).toBe(true)
    try {
      expect(taskStates(pid).length).toBeGreaterThan(2)
      expect(allStopped(pid)).toBe(true)
      expect(await send('ping', 400)).toBeNull()
    } finally {
      a.resumeThreads()
    }
    expect(await nextLine(3000)).toBe('OK')
    expect(noneTraced(pid)).toBe(true)
    expect(harnessExited).toBe(false)
  }, 20000)

  it('GetThreadRegisters returns rip inside a mapped executable region', async () => {
    expect(await send('forceloop')).toBe('OK')
    await sleep(50)
    const threads = a.listThreads(pid) as { tid: number }[]
    expect(threads.length).toBeGreaterThan(1)
    expect(threads.map((t) => String(t.tid)).sort()).toEqual(tasks(pid).sort())
    for (const t of threads) {
      const regs = a.getThreadRegisters(t.tid)
      expect(regs).not.toBeNull()
      expect(BigInt(regs.rsp)).toBeGreaterThan(0n)
      const region = a.platformQueryRegion(handle, regs.rip)
      expect(region).not.toBeNull()
      expect(region.executable).toBe(true)
    }
    // Each read was a brief stop: the harness runs and nothing stays attached.
    expect(noneTraced(pid)).toBe(true)
    expect(await send('ping')).toBe('OK')
  }, 20000)

  it('reads the registers of held threads in place, leaving them held', async () => {
    expect(a.suspendThreads(handle, pid)).toBe(true)
    try {
      for (const t of a.listThreads(pid) as { tid: number }[]) {
        expect(a.getThreadRegisters(t.tid)).not.toBeNull()
      }
      expect(allStopped(pid)).toBe(true)
      expect(await send('ping', 300)).toBeNull()
    } finally {
      a.resumeThreads()
    }
    expect(await nextLine(3000)).toBe('OK')
    expect(noneTraced(pid)).toBe(true)
  }, 20000)

  it('SuspendAll refuses when ptrace is denied and leaves nothing stopped', async () => {
    // Deterministic EPERM: as root, the suspending process runs as uid 65534 against this root-owned
    // harness; otherwise the harness makes itself non-dumpable, which a same-uid tracer without
    // CAP_SYS_PTRACE cannot attach to (and Yama would refuse a sibling anyway).
    expect(await send('nodump')).toBe('OK')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprentice-eperm-'))
    try {
      fs.chmodSync(dir, 0o755)
      const copy = path.join(dir, 'memory_addon.node')
      fs.copyFileSync(ADDON_PATH, copy)
      fs.chmodSync(copy, 0o644)
      const script =
        `const a = require(${JSON.stringify(copy)}); let r;` +
        `try { r = { ok: a.suspendThreads(${pid}, ${pid}) } } catch (e) { r = { ok: false, msg: e.message } }` +
        `a.resumeThreads(); console.log(JSON.stringify(r))`
      const cmd = IS_ROOT
        ? ['setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, '-e', script]]
        : [process.execPath, ['-e', script]]
      const res = spawnSync(cmd[0] as string, cmd[1] as string[], { cwd: dir, timeout: 15000, encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
      const r = JSON.parse(res.stdout.trim())
      expect(r.ok).toBe(false)
      expect(r.msg).toBe(DENIED)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(noneTraced(pid)).toBe(true)
    expect(await send('ping')).toBe('OK')
    // Read-only features are unaffected for the permitted (this) process.
    expect(a.listThreads(pid).length).toBeGreaterThan(0)
  }, 30000)

  it('second SuspendAll before ResumeAll refuses', async () => {
    expect(await send('forceloop')).toBe('OK')
    expect(a.suspendThreads(handle, pid)).toBe(true)
    try {
      expect(() => a.suspendThreads(handle, pid)).toThrow(/already suspended/)
      // The refusal left the first suspension intact.
      expect(allStopped(pid)).toBe(true)
      expect(await send('ping', 300)).toBeNull()
    } finally {
      a.resumeThreads()
    }
    expect(await nextLine(3000)).toBe('OK')
    expect(noneTraced(pid)).toBe(true)
    // The pair completed, so suspending again works.
    expect(a.suspendThreads(handle, pid)).toBe(true)
    a.resumeThreads()
    expect(noneTraced(pid)).toBe(true)
  }, 20000)

  it('suspends on one Node thread and resumes from another', async () => {
    expect(await send('forceloop')).toBe('OK')
    // This thread's event loop stays free while the worker suspends, so libuv is there to react to
    // the SIGCHLD of each ptrace stop: it must not take the leader's stop for an exit.
    expect(await inWorker('(a, d) => a.suspendThreads(d.handle, d.pid)')).toBe(true)
    expect(allStopped(pid)).toBe(true)
    expect(await send('ping', 300)).toBeNull()
    expect(await inWorker('(a) => { a.resumeThreads(); return true }')).toBe(true)
    expect(await nextLine(3000)).toBe('OK')
    expect(noneTraced(pid)).toBe(true)
    expect(harnessExited).toBe(false)
  }, 20000)

  it.skipIf(SIBLING_ATTACH_UNAVAILABLE)('fails cleanly and quickly when another tracer already holds the target', async () => {
    expect(await send('allowptrace')).toBe('OK') // Yama ptrace_scope=1: let the sibling helper attach
    const tracer = spawnHelper('python3', [
      '-c',
      'import ctypes, sys\n' +
        'libc = ctypes.CDLL(None, use_errno=True)\n' +
        `r = libc.ptrace(0x4206, ${pid}, None, None)\n` + // PTRACE_SEIZE: traced, still running
        "print('seized' if r == 0 else 'errno %d' % ctypes.get_errno(), flush=True)\n" +
        'sys.stdin.read()\n',
    ])
    expect(await firstLine(tracer, 5000)).toBe('seized')
    const t0 = Date.now()
    let msg = ''
    try {
      a.suspendThreads(handle, pid)
    } catch (e: any) {
      msg = e.message
    }
    expect(msg).toMatch(/already traced/)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(taskStates(pid).includes('t')).toBe(false)
    expect(await send('ping')).toBe('OK')

    tracer.kill('SIGKILL')
    await new Promise((r) => tracer.once('exit', r))
    expect(await until(() => tracerPids(pid).every((x) => x === 0), 2000)).toBe(true)
    expect(a.suspendThreads(handle, pid)).toBe(true)
    a.resumeThreads()
    expect(noneTraced(pid)).toBe(true)
    expect(await send('ping')).toBe('OK')
  }, 20000)

  it.skipIf(SIBLING_ATTACH_UNAVAILABLE)('the target resumes when the suspending process dies while holding it', async () => {
    expect(await send('allowptrace')).toBe('OK')
    expect(await send('forceloop')).toBe('OK')
    // A separate Node process suspends the harness, proves it holds it, then SIGKILLs itself.
    const script =
      `const a = require(${JSON.stringify(ADDON_PATH)});` +
      `const ok = a.suspendThreads(${pid}, ${pid});` +
      `const fs = require('fs');` +
      `const st = fs.readdirSync('/proc/${pid}/task').map((t) => { const s = fs.readFileSync('/proc/${pid}/task/' + t + '/stat', 'utf8'); return s[s.lastIndexOf(')') + 2] });` +
      `console.log(JSON.stringify({ ok, held: st.every((x) => x === 't') }));` +
      `process.kill(process.pid, 'SIGKILL')`
    const res = spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8' })
    expect(res.signal).toBe('SIGKILL')
    expect(JSON.parse(res.stdout.trim())).toEqual({ ok: true, held: true })
    expect(await until(() => noneTraced(pid), 3000)).toBe(true)
    expect(await send('ping')).toBe('OK')
  }, 30000)

  it('target killed while held: resume and later calls return promptly, no hang', async () => {
    if (!HARNESS_WINE) expect(await send('spawnthreads 4')).toBe('OK')
    const exited = new Promise((r) => harness!.once('exit', r))
    expect(a.suspendThreads(handle, pid)).toBe(true)
    process.kill(pid, 'SIGKILL')
    await sleep(50)
    let t0 = Date.now()
    a.resumeThreads()
    expect(Date.now() - t0).toBeLessThan(3000)
    t0 = Date.now()
    expect(() => a.suspendThreads(handle, pid)).toThrow()
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(a.getThreadRegisters(pid)).toBeNull()
    // Fully gone: no traced zombie thread keeps the harness from being reaped by its parent.
    expect(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])).toBe(true)
  }, 20000)

  it.skipIf(HARNESS_WINE)('a signal sent to the target while held is delivered exactly once after resume', async () => {
    expect(await send('sighandler')).toBe('OK')
    expect(a.suspendThreads(handle, pid)).toBe(true)
    try {
      process.kill(pid, 'SIGUSR1')
      await sleep(100)
      expect(allStopped(pid)).toBe(true)
    } finally {
      a.resumeThreads()
    }
    expect(await send('sigcount')).toBe('OK 1')
  }, 20000)

  it.skipIf(HARNESS_WINE)('a thread that cannot stop: SuspendAll fails, the tracer detaches it once it can, its signal survives', async () => {
    expect(await send('sighandler')).toBe('OK')
    // A thread blocked in vfork() for 3 s: PTRACE_INTERRUPT cannot stop it before the 2 s bound.
    const reply = await send('vforkwait 3000')
    expect(reply).toMatch(/^OK \d+$/)
    const tid = Number(reply!.split(' ')[1])
    const t0 = Date.now()
    expect(() => a.suspendThreads(handle, pid)).toThrow(new RegExp(`thread ${tid} did not stop`))
    expect(Date.now() - t0).toBeLessThan(5000)

    // Its detach is still pending: a follow-up is refused for that reason, not "already traced".
    let msg = ''
    try {
      a.suspendThreads(handle, pid)
    } catch (e: any) {
      msg = e.message
    }
    expect(msg).toBe(`thread ${tid} still detaching`)
    // Everything else was released: the main thread answers.
    expect(await send('ping')).toBe('OK')
    // A signal for the blocked, still-traced thread must not be lost by the detach.
    expect(await send(`tkill ${tid}`)).toBe('OK')

    // Once vfork ends (~3 s) the thread reaches its pending stop and the tracer thread detaches it on
    // its own, with no further addon call: not traced, not left in a trace stop.
    const status = (field: string) => {
      try {
        const m = new RegExp(`${field}:\\s*(\\S+)`).exec(fs.readFileSync(`/proc/${pid}/task/${tid}/status`, 'utf8'))
        return m ? m[1] : ''
      } catch {
        return ''
      }
    }
    expect(await until(() => status('TracerPid') === '0' && status('State') !== 't', 5000)).toBe(true)
    await sleep(100)
    expect(status('State')).not.toBe('t')
    expect(await send('sigcount')).toBe('OK 1')
    expect(a.suspendThreads(handle, pid)).toBe(true)
    a.resumeThreads()
    expect(noneTraced(pid)).toBe(true)
    expect(await send('ping')).toBe('OK')
  }, 30000)

  it.skipIf(HARNESS_WINE)('catches threads created while suspending: all stopped, none appear while held', async () => {
    expect(await send('threadstorm')).toBe('OK')
    await sleep(100)
    for (let round = 0; round < 5; round++) {
      expect(a.suspendThreads(handle, pid)).toBe(true)
      try {
        const before = tasks(pid).sort()
        expect(allStopped(pid)).toBe(true)
        await sleep(50)
        expect(tasks(pid).sort()).toEqual(before)
      } finally {
        a.resumeThreads()
      }
      expect(tracerPids(pid).every((x) => x === 0)).toBe(true)
      await sleep(20)
    }
    expect(await send('stopstorm')).toBe('OK')
  }, 30000)
})

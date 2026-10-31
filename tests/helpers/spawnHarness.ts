import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Teardown in the native tests is `stdin.write('q\n')` then `kill()`. If the harness is gone before that write finishes, Node reports
// the failed write as an 'error' event on the child's stdin. With no listener it becomes an uncaught exception, and Vitest fails the
// whole run on it even though every test passed (seen on CI as `Error: write EPIPE`, blamed on whichever file was running).
// A broken pipe to a process we are shutting down is expected, so it is ignored; anything else still surfaces.
const CLOSED_PIPE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

export function ignoreClosedPipe(err: NodeJS.ErrnoException): void {
  if (!err.code || !CLOSED_PIPE.has(err.code)) throw err
}

// On Linux, APPRENTICE_HARNESS=wine runs the Windows harness (test-harness/harness.c built with mingw, see
// Linux/test-harness/build-wine-harness.sh) under Wine instead of the ELF one: the Proton path, a PE process
// with PE modules seen through /proc.
export const HARNESS_WINE = process.platform !== 'win32' && process.env.APPRENTICE_HARNESS === 'wine'
// The target's modules are PE images (.exe/.dll names, real TimeDateStamps): Windows, or Wine on Linux.
export const HARNESS_IS_PE = process.platform === 'win32' || HARNESS_WINE
// The harness's own module (and, on Linux, process) name.
export const HARNESS_NAME =
  process.platform === 'win32' ? 'harness.exe' : HARNESS_WINE ? 'harness-wine.exe' : 'harness'

// How long startHarness waits for the harness's first line. A Wine start in a prefix that has not been
// initialised yet takes several seconds, so Wine mode gets a generous bound; beforeAll hooks that call
// startHarness pass HARNESS_HOOK_TIMEOUT_MS so vitest's own hook timeout does not fire first.
export const HARNESS_READY_TIMEOUT_MS = HARNESS_WINE ? 60_000 : 10_000
export const HARNESS_HOOK_TIMEOUT_MS = HARNESS_READY_TIMEOUT_MS + 10_000

const WINE_EXE = 'Linux/test-harness/harness-wine.exe'

// The Wine tests must never run in a real prefix. Returns the normalised prefix, or throws when it is not
// absolute or is `<home>/.wine`, `<home>` or `/`. POSIX paths only (Wine runs on Linux), so it is a pure
// string check that also runs on Windows.
export function assertSafeWinePrefix(prefix: string, home: string): string {
  const norm = (p: string) => {
    const n = path.posix.normalize(p)
    return n.length > 1 ? n.replace(/\/+$/, '') : n
  }
  const p = norm(prefix)
  if (!path.posix.isAbsolute(p)) {
    throw new Error(`APPRENTICE_WINEPREFIX must be an absolute path, got "${prefix}"`)
  }
  const h = norm(home)
  for (const forbidden of ['/', h, path.posix.join(h, '.wine')]) {
    if (p === forbidden) {
      throw new Error(
        `refusing to run the Wine tests in "${p}": that is not a throwaway prefix. ` +
          'Leave APPRENTICE_WINEPREFIX unset (default ~/.wine-apprentice-test) or point it at a scratch directory.',
      )
    }
  }
  return p
}

// The throwaway prefix: APPRENTICE_WINEPREFIX, else ~/.wine-apprentice-test. A WINEPREFIX in the environment
// is deliberately ignored (it may well be the user's real ~/.wine).
export function winePrefix(): string {
  const home = os.homedir()
  return assertSafeWinePrefix(process.env.APPRENTICE_WINEPREFIX || path.posix.join(home, '.wine-apprentice-test'), home)
}

// The one Wine environment for every wine/wineserver the tests start. Mono/Gecko are disabled so nothing is
// downloaded. Keep in step with wine_env() in Linux/scripts/run-tests.sh.
export function wineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WINEPREFIX: winePrefix(),
    WINEARCH: 'win64',
    WINEDEBUG: '-all',
    WINEDLLOVERRIDES: 'mscoree,mshtml=',
  }
}

// Spawn errors per child, so startHarness can report the cause instead of a timeout.
const spawnErrors = new WeakMap<ChildProcessWithoutNullStreams, Error>()

export function spawnHarness(): ChildProcessWithoutNullStreams {
  // Same stdin/stdout protocol on all three: the PE harness on Windows, the ELF one (Linux/test-harness/harness.c)
  // on Linux, and the PE one under Wine.
  //
  // Under Wine the returned child's pid is the Linux pid of the process running the PE, which is what the tests
  // attach to and what listProcesses() reports: /usr/bin/wine is a shell script that execs the Wine loader, and
  // the loader runs the exe in that same process (it only rewrites its argv to the exe path), so no step forks.
  // The `PID n` line the harness prints is its WINDOWS pid, which is unrelated; the tests never use it.
  // wineserver and winedevice.exe are separate processes, but none of them maps the harness.
  if (HARNESS_WINE) {
    const env = wineEnv() // first: refuses an unsafe prefix before anything else happens
    const exe = path.resolve(WINE_EXE)
    if (!fs.existsSync(exe)) {
      throw new Error(`${WINE_EXE} is not built: run Linux/test-harness/build-wine-harness.sh (needs mingw-w64)`)
    }
    const harness = spawn('wine', [exe], { env })
    harness.on('error', (err: NodeJS.ErrnoException) => {
      const e =
        err.code === 'ENOENT'
          ? new Error('`wine` was not found on PATH: install it (apt-get install --no-install-recommends wine wine64)')
          : new Error(`starting wine failed: ${err.message}`)
      spawnErrors.set(harness, e)
      console.error(`[spawnHarness] ${e.message}`)
    })
    harness.stdin.on('error', ignoreClosedPipe)
    return harness
  }
  const exe = process.platform === 'win32' ? 'test-harness/harness.exe' : 'Linux/test-harness/harness'
  const harness = spawn(path.resolve(exe))
  harness.stdin.on('error', ignoreClosedPipe)
  return harness
}

// spawnHarness, then wait (bounded) for the harness's first line, `PID n`, which it prints once it is running.
// Rejects with the cause when wine cannot start, the harness exits first, or nothing arrives in time.
export function startHarness(): Promise<ChildProcessWithoutNullStreams> {
  const harness = spawnHarness()
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => {
      cleanup()
      harness.kill()
      reject(e)
    }
    const onData = () => {
      cleanup()
      resolve(harness)
    }
    const onError = () => fail(spawnErrors.get(harness) ?? new Error('the harness could not be started'))
    const onExit = (code: number | null, signal: string | null) =>
      fail(new Error(`the harness exited before it was ready (code ${code}, signal ${signal})`))
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `the harness printed nothing within ${HARNESS_READY_TIMEOUT_MS / 1000} s` +
              (HARNESS_WINE
                ? `; the Wine prefix ${winePrefix()} may not be initialised: run Linux/scripts/run-tests.sh ` +
                  '(APPRENTICE_HARNESS=wine), which creates it'
                : ''),
          ),
        ),
      HARNESS_READY_TIMEOUT_MS,
    )
    const cleanup = () => {
      clearTimeout(timer)
      harness.stdout.off('data', onData)
      harness.off('error', onError)
      harness.off('exit', onExit)
    }
    harness.stdout.once('data', onData)
    harness.once('error', onError)
    harness.once('exit', onExit)
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// Teardown for startHarness/spawnHarness: `q`, then kill. In Wine mode, also shut down the throwaway prefix's
// wineserver (and with it winedevice.exe etc., which otherwise linger ~3 s after the last client) and wait up
// to ~5 s for it. Only that prefix is ever touched.
export async function stopHarness(harness: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!harness) return
  harness.stdin.write('q\n')
  harness.kill()
  if (!HARNESS_WINE) return
  await waitForExit(harness, 5_000)
  const env = wineEnv()
  spawnSync('wineserver', ['-k'], { env, timeout: 5_000, stdio: 'ignore' })
  spawnSync('wineserver', ['-w'], { env, timeout: 5_000, stdio: 'ignore' })
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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

// A throwaway prefix, never the user's ~/.wine. Wine Mono/Gecko are disabled so nothing is downloaded.
export function wineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WINEPREFIX: process.env.WINEPREFIX || path.join(os.homedir(), '.wine-apprentice-test'),
    WINEARCH: 'win64',
    WINEDEBUG: process.env.WINEDEBUG || '-all',
    WINEDLLOVERRIDES: 'mscoree,mshtml=',
  }
}

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
    const exe = path.resolve('Linux/test-harness/harness-wine.exe')
    const harness = spawn('wine', [exe], { env: wineEnv() })
    harness.stdin.on('error', ignoreClosedPipe)
    return harness
  }
  const exe = process.platform === 'win32' ? 'test-harness/harness.exe' : 'Linux/test-harness/harness'
  const harness = spawn(path.resolve(exe))
  harness.stdin.on('error', ignoreClosedPipe)
  return harness
}

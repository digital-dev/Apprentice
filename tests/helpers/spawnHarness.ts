import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

// Teardown in the native tests is `stdin.write('q\n')` then `kill()`. If the harness is gone before that write finishes, Node reports
// the failed write as an 'error' event on the child's stdin. With no listener it becomes an uncaught exception, and Vitest fails the
// whole run on it even though every test passed (seen on CI as `Error: write EPIPE`, blamed on whichever file was running).
// A broken pipe to a process we are shutting down is expected, so it is ignored; anything else still surfaces.
const CLOSED_PIPE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

export function ignoreClosedPipe(err: NodeJS.ErrnoException): void {
  if (!err.code || !CLOSED_PIPE.has(err.code)) throw err
}

export function spawnHarness(): ChildProcessWithoutNullStreams {
  const harness = spawn(path.resolve('test-harness/harness.exe'))
  harness.stdin.on('error', ignoreClosedPipe)
  return harness
}

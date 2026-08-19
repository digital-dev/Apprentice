// Defense-in-depth wrapper around ctImport.ts's importCheatTable.
//
// This bug class (a regex or algorithm in parseInjection/collectCheatEntryRanges
// going quadratic-or-worse on a hostile or merely malformed .CT file) has now
// been found and fixed five times in ctImport.ts (see git history), each
// round's fix verified only against the specific pathological shapes already
// known — not against every possible future regex/algorithm interaction.
// Since importCheatTable is synchronous CPU-bound work and JS's single-
// threaded event loop cannot preempt a busy synchronous function with a timer
// on the SAME thread, the only way to actually bound its wall-clock time is
// to run it on a different thread and terminate that thread on a timeout —
// hence a worker_thread here, rather than yet another individual regex audit.
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import fs from 'node:fs'
import type { CtImportResult } from './ctImport'

const DEFAULT_TIMEOUT_MS = 8000 // generous for any real table; well under "the app feels hung" to a user

type WorkerMessage = { ok: true; result: CtImportResult } | { ok: false; error: string }

// Locates the worker entry script at runtime.
//
// electron.vite.config.ts builds ctImportWorker.ts as a SEPARATE main-
// process entry, alongside index.ts, so a packaged build (and
// `electron-vite dev`, which bundles the same way) produces
// out/main/ctImportWorker.js sitting right next to this module's own
// compiled output — i.e. `path.join(__dirname, 'ctImportWorker.js')` always
// resolves in the real app, in both dev and prod, because __dirname is
// out/main either way.
//
// vitest, by contrast, runs this file's TypeScript source directly (via
// vite-node) with no electron-vite build step, so __dirname there is this
// file's own src/main directory, where only ctImportWorker.ts exists (no
// compiled .js). Node's own built-in TypeScript type-stripping (stable,
// no CLI flag needed on the Node version this repo targets) loads a .ts
// worker_thread entry directly, so falling back to the .ts source lets
// tests exercise the real worker without requiring a build first.
function resolveWorkerScriptPath(): string {
  const compiled = path.join(__dirname, 'ctImportWorker.js')
  if (fs.existsSync(compiled)) return compiled
  return path.join(__dirname, 'ctImportWorker.ts')
}

// `workerScriptPath` is not part of the intended production call shape —
// production code should always call this with just (xml, timeoutMs) and
// let it resolve the real worker script. It exists so tests can point at a
// fixture worker (one that hangs forever, or throws) to exercise the
// timeout/error paths deterministically, without needing a genuinely slow
// pathological input running against a tiny real timeout (flaky: worker
// startup overhead alone can approach a "tiny" timeout on a loaded CI box).
export function importCheatTableWithBudget(
  xml: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  workerScriptPath: string = resolveWorkerScriptPath()
): Promise<CtImportResult | { error: string }> {
  return new Promise((resolve) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(workerScriptPath, { workerData: { xml } })
    } catch (err) {
      resolve({ error: `Could not start the import worker: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    const finish = (value: CtImportResult | { error: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.removeAllListeners()
      // Fire-and-forget: terminate() is async, but the caller already has
      // its answer and doesn't need to wait for the OS thread teardown.
      void worker.terminate()
      resolve(value)
    }

    const timer = setTimeout(() => {
      finish({ error: 'This file took too long to parse — it may be malformed or corrupted.' })
    }, timeoutMs)

    worker.once('message', (msg: WorkerMessage) => {
      if (msg.ok) finish(msg.result)
      else finish({ error: msg.error })
    })

    // A worker error (an uncaught exception that escapes the worker
    // script's own try/catch — see ctImportWorker.ts) must resolve
    // gracefully too, never crash/reject out to the caller.
    worker.once('error', (err) => {
      finish({ error: err instanceof Error ? err.message : String(err) })
    })

    worker.once('exit', (code) => {
      if (code !== 0) finish({ error: `Import worker exited unexpectedly (code ${code}).` })
    })
  })
}

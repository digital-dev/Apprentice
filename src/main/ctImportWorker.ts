// worker_thread entry point for importCheatTableWithBudget (see
// ctImportSafe.ts). Runs the synchronous, CPU-bound importCheatTable off
// the Electron main thread so a pathological input (a known-bad shape or
// an undiscovered one — this bug class has now been found and fixed five
// times in ctImport.ts, each round only verified against the specific
// shapes already known) can be terminated on a timeout instead of freezing
// the single-threaded main process indefinitely.
//
// Deliberately tiny and dependency-light: its only job is "run
// importCheatTable against workerData.xml and post back the outcome",
// wrapped in a try/catch so any uncaught throw inside the parser (e.g. a
// future instance of bug #8's category — a RegExp constructor throwing on
// pathological input) becomes a normal posted error message instead of an
// uncaught worker exception. See ctImportSafe.ts for how this file is
// located at runtime (built .js in production, this .ts source directly
// in tests — Node's built-in TypeScript type-stripping runs it as-is).
import { parentPort, workerData } from 'node:worker_threads'
import { importCheatTable } from './ctImport.ts'

type WorkerResult =
  | { ok: true; result: ReturnType<typeof importCheatTable> }
  | { ok: false; error: string }

if (!parentPort) {
  // Should be unreachable — this module is only ever loaded as a Worker.
  throw new Error('ctImportWorker.ts must be run as a worker_thread, not required directly.')
}

try {
  const xml = (workerData as { xml: string }).xml
  const result = importCheatTable(xml)
  const message: WorkerResult = { ok: true, result }
  parentPort.postMessage(message)
} catch (err) {
  const message: WorkerResult = { ok: false, error: err instanceof Error ? err.message : String(err) }
  parentPort.postMessage(message)
}

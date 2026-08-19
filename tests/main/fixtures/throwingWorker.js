// Test fixture for ctImportSafe.test.ts: a worker_thread entry that throws
// uncaught immediately on load, simulating a bug in importCheatTable (or
// ctImportWorker.ts's own wiring) that escapes the worker's own try/catch —
// used to verify importCheatTableWithBudget resolves gracefully with an
// { error } instead of rejecting/crashing the caller.
throw new Error('simulated uncaught worker failure')

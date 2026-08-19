// Test fixture for ctImportSafe.test.ts: a worker_thread entry that never
// posts a message back to its parent — used to exercise
// importCheatTableWithBudget's timeout path deterministically, without
// needing a genuinely slow (30-90s scale) pathological regex input running
// against a tiny real timeout, which would be flaky (worker startup
// overhead alone can approach a "tiny" timeout on a loaded CI box).
//
// Busy-loops instead of just idling so the worker is provably still
// "doing work" from the timeout's point of view, and so this also proves
// worker.terminate() can actually interrupt CPU-bound synchronous JS (the
// same primitive the real safety net relies on against a pathological
// regex hang) rather than just a worker that was merely idle/asleep.
while (true) {
  // intentionally never yields, never posts a message
}

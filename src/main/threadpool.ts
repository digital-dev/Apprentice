// Side-effect-only module, imported FIRST by main/index.ts.
//
// This exists as its own module rather than a plain statement at the top of
// index.ts because the main process is bundled by rollup, which hoists every
// `import` above any top-level statement — a bare assignment at the top of
// index.ts would still run after `./ipc` (and with it the native addon) had
// been loaded. Import ORDER is preserved, so a module whose only job is this
// assignment reliably runs before anything else.
//
// libuv reads UV_THREADPOOL_SIZE once, the first time the threadpool is
// used, and never again. The default of 4 is shared by every native async
// operation in this app (scanFirst, scanAob, resolvePointerChain,
// callRemoteFunction, runScript). A Lua script that swallows its 5-second
// timeout with pcall permanently strands the worker thread it is running on,
// so with the default pool, four stuck scripts would consume it outright and
// scanning would hang forever with nothing shown to the user. See
// scriptRuntime.ts's ScriptRunLimiter for the other half of this mitigation:
// at most 2 script runs in flight at once, so at most 2 of these 16 threads
// can ever be lost that way.
process.env.UV_THREADPOOL_SIZE = '16'

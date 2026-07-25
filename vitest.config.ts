import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Several native tests drive a process-global debugger/write-watch
    // session (g_session in native/src/write_watch.cc) and spawn the
    // shared test-harness.exe process. Vitest's default `threads` pool
    // runs test FILES in parallel worker threads inside the same OS
    // process, so two files touching that global session at once collide
    // (one gets "a write-watch session is already active", the other's
    // poll loop catches nothing). The suite is small enough that running
    // files serially costs almost nothing, so trade the parallelism for
    // correctness rather than making the native session per-handle.
    fileParallelism: false,
    server: {
      deps: {
        // Native .node addons must be loaded via Node's require, not
        // transformed/parsed as JS/TS source by Vite's SSR pipeline.
        external: [/\.node$/]
      }
    }
  }
})

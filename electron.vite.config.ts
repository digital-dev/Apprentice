import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // ctImportWorker is a separate entry (not an import reachable from
        // index.ts) because it's loaded at runtime as a worker_thread
        // script by its own file path, not imported as a normal module —
        // see ctImportSafe.ts for why (the worker_thread safety net around
        // importCheatTable). It needs to exist as its own standalone
        // compiled .js file sitting next to index.js in out/main, not
        // inlined into index.js's bundle.
        input: {
          index: 'src/main/index.ts',
          ctImportWorker: 'src/main/ctImportWorker.ts'
        }
      }
    }
  },
  preload: { build: { outDir: 'out/preload' } },
  renderer: {
    root: 'src/renderer',
    build: { outDir: 'out/renderer' },
    plugins: [react()]
  }
})

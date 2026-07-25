import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        // Native .node addons must be loaded via Node's require, not
        // transformed/parsed as JS/TS source by Vite's SSR pipeline.
        external: [/\.node$/]
      }
    }
  }
})

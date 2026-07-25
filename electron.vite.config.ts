import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { build: { outDir: 'out/main' } },
  preload: { build: { outDir: 'out/preload' } },
  renderer: {
    root: 'src/renderer',
    build: { outDir: 'out/renderer' },
    plugins: [react()]
  }
})

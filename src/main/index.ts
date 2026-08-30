// MUST stay the first import: it sets UV_THREADPOOL_SIZE, which libuv reads
// only once, before any import below can load the native addon and use the
// threadpool. See threadpool.ts.
import './threadpool'
import { app, BrowserWindow, type Event } from 'electron'
import path from 'node:path'
import { registerIpcHandlers, releaseTarget } from './ipc'

let mainWindow: BrowserWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Apprentice',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  registerIpcHandlers(() => mainWindow)
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
// Never leave a game holding Tamper's NOPs or a stuck freeze-cheat value —
// or, worse, an armed hardware breakpoint with no debugger left to service
// it, which kills the game. releaseTarget() now writes offValue for active
// freeze cheats too, which needs to actually finish before the process
// exits — so the first before-quit intercepts the quit, awaits it, then
// re-fires app.quit() to let it through. releasing is guarded so a second
// before-quit (this re-fired quit's own, or Electron's own retry) doesn't
// re-enter releaseTarget after the handle it needs is already gone.
let releasing = false
app.on('before-quit', (event: Event) => {
  if (releasing) return
  releasing = true
  event.preventDefault()
  releaseTarget().finally(() => app.quit())
})

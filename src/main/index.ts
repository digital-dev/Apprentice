// MUST stay the first import: it sets UV_THREADPOOL_SIZE, which libuv reads
// only once, before any import below can load the native addon and use the
// threadpool. See threadpool.ts.
import './threadpool'
import { app, BrowserWindow, type Event } from 'electron'
import path from 'node:path'
import { registerIpcHandlers, releaseTarget } from './ipc'

let mainWindow: BrowserWindow

// .ico only decodes as a window/taskbar icon on Windows; Linux (and the
// AppImage/deb builds packaged from Linux/packaging/electron-builder.linux.json,
// which bundle the .png instead — see its files list) needs the .png.
const ICON_NAME = process.platform === 'linux' ? 'Apprentice.png' : 'Apprentice.ico'

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Apprentice',
    // The window and taskbar icon. Lives outside out/ so it is the same file the
    // installer uses for the exe; a missing file just falls back to the default.
    icon: path.join(__dirname, '../../App Icon', ICON_NAME),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  registerIpcHandlers(() => mainWindow)
  // Linux/scripts/smoke-package.sh's CI check: confirms a packaged AppImage/deb
  // actually launches a window (not just that the binary doesn't crash before
  // getting that far) without needing a real interactive session beyond what
  // xvfb-run already provides. ready-to-show (rather than 'ready' or did-finish-load)
  // is the first point the window has actual content laid out. The title is
  // printed (not just the exit code checked) so the smoke test can confirm it
  // is actually OUR window that came up, the same signal a human glancing at
  // the titlebar would use, without needing wmctrl/xdotool polling a window
  // that is about to close itself.
  if (process.argv.includes('--smoke-test')) {
    mainWindow.once('ready-to-show', () => {
      console.log(`smoke-test: window ready, title="${mainWindow.getTitle()}"`)
      app.exit(0)
    })
  }
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

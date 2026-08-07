import { app, BrowserWindow } from 'electron'
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
// Never leave a game holding Tamper's NOPs — or, worse, an armed hardware
// breakpoint with no debugger left to service it, which kills the game.
app.on('before-quit', () => releaseTarget())

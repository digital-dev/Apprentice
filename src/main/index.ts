import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpcHandlers, restoreAllPatches } from './ipc'

let mainWindow: BrowserWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Tamper',
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
// Never leave a game running with Tamper's NOPs in its code.
app.on('before-quit', () => restoreAllPatches())

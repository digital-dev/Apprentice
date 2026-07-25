import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('tamper', {})

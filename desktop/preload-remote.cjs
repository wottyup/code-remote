const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('CodeRemoteDesktop', {
  getToken: () => {
    try {
      return ipcRenderer.sendSync('remote:read-token') || null
    } catch {
      return null
    }
  },
  saveToken: (token) => ipcRenderer.invoke('remote:save-token', token),
  clearToken: () => ipcRenderer.invoke('remote:clear-token'),
})

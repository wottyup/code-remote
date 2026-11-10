const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('CodeRemoteDesktop', {
  getToken: () => {
    try {
      return ipcRenderer.sendSync('remote:read-token') || null
    } catch {
      return null
    }
  },
  getTokenAsync: () => ipcRenderer.invoke('remote:read-token-async'),
  saveToken: (token) => ipcRenderer.invoke('remote:save-token', token),
  clearToken: () => ipcRenderer.invoke('remote:clear-token'),
  getCurrentConnectionId: () => ipcRenderer.invoke('remote:connections:current'),
  listConnections: () => ipcRenderer.invoke('remote:connections:list'),
  pairConnection: (input) => ipcRenderer.invoke('remote:connections:pair', input),
  renameConnection: (input) => ipcRenderer.invoke('remote:connections:rename', input),
  removeConnection: (input) => ipcRenderer.invoke('remote:connections:remove', input),
  activateConnection: (profileId) => ipcRenderer.invoke('remote:connections:activate', profileId),
  openConnectionWindow: (profileId) => ipcRenderer.invoke('remote:connections:open-window', profileId),
  onConnectionsChanged: (callback) => {
    const listener = (_event, connections) => callback(connections)
    ipcRenderer.on('connections:changed', listener)
    return () => ipcRenderer.removeListener('connections:changed', listener)
  },
})

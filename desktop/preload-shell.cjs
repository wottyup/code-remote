const { contextBridge, ipcRenderer } = require('electron')

const initialProfileArgument = process.argv.find((argument) => argument.startsWith('--code-remote-initial-profile='))
const initialProfileId = initialProfileArgument?.slice('--code-remote-initial-profile='.length) || null

contextBridge.exposeInMainWorld('codeRemoteDesktop', {
  initialProfileId,
  listConnections: () => ipcRenderer.invoke('connections:list'),
  pairConnection: (input) => ipcRenderer.invoke('connections:pair', input),
  renameConnection: (input) => ipcRenderer.invoke('connections:rename', input),
  removeConnection: (input) => ipcRenderer.invoke('connections:remove', input),
  activateConnection: (profileId) => ipcRenderer.invoke('connections:activate', profileId),
  openConnectionWindow: (profileId) => ipcRenderer.invoke('connections:open-window', profileId),
  setOverlayOpen: (isOpen) => ipcRenderer.invoke('shell:overlay-open', isOpen),
  onConnectionsChanged: (callback) => {
    const listener = (_event, connections) => callback(connections)
    ipcRenderer.on('connections:changed', listener)
    return () => ipcRenderer.removeListener('connections:changed', listener)
  },
})

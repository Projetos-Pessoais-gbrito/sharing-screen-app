// Safe bridge between the web page and the Electron main process.
// Only exposed to the setup screen and to the server you configured.
const { contextBridge, ipcRenderer } = require('electron');

const allowed = ipcRenderer.sendSync('app:allowed-origin');

if (location.protocol === 'file:' || (allowed && location.origin === allowed)) {
  contextBridge.exposeInMainWorld('desktop', {
    info: () => ipcRenderer.invoke('app:info'),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
    openSettings: () => ipcRenderer.invoke('settings:open'),
    listSources: () => ipcRenderer.invoke('sources:list'),
    selectSource: (id, audio) => ipcRenderer.invoke('sources:select', { id, audio }),
    copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  });
}

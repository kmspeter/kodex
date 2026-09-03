const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kodexDesktop', Object.freeze({
  selectDirectory: () => ipcRenderer.invoke('kodex:select-directory'),
  selectFile: () => ipcRenderer.invoke('kodex:select-file'),
  openExternal: (url) => ipcRenderer.invoke('kodex:open-external', url),
}));

const { contextBridge, ipcRenderer } = require('electron');

// Each editor window edits one file, which the main process knows; the page never names a path.
contextBridge.exposeInMainWorld('editorHost', {
  get: () => ipcRenderer.invoke('editor:get'),
  save: (text) => ipcRenderer.invoke('editor:save', text),
  setDirty: (dirty) => ipcRenderer.send('editor:dirty', dirty),
  openInVSCode: (line) => ipcRenderer.send('editor:vscode', line),
  close: () => ipcRenderer.send('editor:close'),
  onRemote: (cb) => ipcRenderer.on('editor:remote', (_e, d) => cb(d)),
  onChanged: (cb) => ipcRenderer.on('editor:changed', (_e, text) => cb(text)),
  onSaveAndClose: (cb) => ipcRenderer.on('editor:saveAndClose', () => cb())
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsHost', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (form) => ipcRenderer.invoke('settings:save', form),
  browse: (current) => ipcRenderer.invoke('settings:browse', current),
  openJson: () => ipcRenderer.send('settings:openJson'),
  restart: () => ipcRenderer.send('settings:restart'),
  onTab: (cb) => ipcRenderer.on('settings:tab', (_e, tab) => cb(tab)),
  setup: {
    get: () => ipcRenderer.invoke('setup:get'),
    run: (kind, id) => ipcRenderer.invoke('setup:run', { kind, id }),
    gitIdentity: (name, email) => ipcRenderer.invoke('setup:gitIdentity', { name, email }),
    done: () => ipcRenderer.send('setup:done')
  },
  agents: {
    get: () => ipcRenderer.invoke('agents:get'),
    save: (text) => ipcRenderer.invoke('agents:save', text)
  },
  remote: {
    get: () => ipcRenderer.invoke('remote:get'),
    setHost: (form) => ipcRenderer.invoke('remote:setHost', form),
    pair: (name) => ipcRenderer.invoke('remote:pair', { name }),
    revoke: (id) => ipcRenderer.invoke('remote:revoke', { id }),
    addHost: (form) => ipcRenderer.invoke('remote:addHost', form),
    removeHost: (id) => ipcRenderer.invoke('remote:removeHost', { id }),
    reconnect: (id) => ipcRenderer.send('remote:reconnect', id)
  }
});

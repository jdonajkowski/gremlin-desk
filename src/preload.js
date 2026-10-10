const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// Every PTY, worker and status message carries the session (project) id.
contextBridge.exposeInMainWorld('widget', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  onConfigChanged: on('config:changed'),
  pty: {
    write: (id, data) => ipcRenderer.send('pty:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    restart: (id, cols, rows) => ipcRenderer.send('pty:restart', { id, cols, rows }),
    onData: on('pty:data'),
    onExit: on('pty:exit'),
    onRestartActive: on('pty:restartActive')
  },
  projects: {
    get: () => ipcRenderer.invoke('projects:get'),
    open: (id, cols, rows, link) => ipcRenderer.invoke('project:open', { id, cols, rows, link: !!link }),
    setDefaults: (id, text) => ipcRenderer.invoke('project:setDefaults', { id, text }),
    onDefaultsAsk: on('project:defaultsAsk'),
    onLinkTab: on('project:linkTab'),
    close: (id) => ipcRenderer.send('session:close', { id }),
    menu: (id) => ipcRenderer.send('project:menu', { id }),
    addMenu: () => ipcRenderer.send('projects:addMenu'),
    onList: on('projects:list'),
    onClosed: on('session:closed'),
    onSelect: on('projects:select'),
    onWorktreeAsk: on('worktree:ask'),
    onRenameAsk: on('project:renameAsk'),
    rename: (id, name) => ipcRenderer.invoke('project:rename', { id, name }),
    createWorktree: (id, branch) => ipcRenderer.invoke('worktree:create', { id, branch })
  },
  aux: {
    get: () => ipcRenderer.invoke('aux:get'),
    close: (id) => ipcRenderer.send('session:close', { id }),
    newShell: (projectId) => ipcRenderer.send('aux:newShell', projectId),
    onList: on('aux:list'),
    onSelect: on('aux:select')
  },
  remote: {
    reconnect: (hostId) => ipcRenderer.send('remote:reconnect', hostId),
    onReplay: on('remote:replay'),
    onReset: on('remote:reset'),
    onSessionEvent: on('remote:sevent')
  },
  menus: {
    run: () => ipcRenderer.send('run:menu'),
    admin: () => ipcRenderer.send('admin:menu')
  },
  workbench: {
    open: (tab) => ipcRenderer.send('workbench:open', tab)
  },
  sys: {
    onSample: on('sys:sample')
  },
  bench: {
    onProgress: on('bench:progress')
  },
  side: {
    setCollapsed: (collapsed) => ipcRenderer.send('side:setCollapsed', collapsed)
  },
  notify: {
    show: (note) => ipcRenderer.send('notify:show', note)
  },
  rail: {
    toggle: () => ipcRenderer.send('rail:toggle'),
    resize: (width, final) => ipcRenderer.send('rail:resize', { width, final: !!final }),
    onState: on('rail:state')
  },
  win: {
    togglePin: () => ipcRenderer.invoke('win:togglePin'),
    opacity: (delta) => ipcRenderer.invoke('win:opacity', delta),
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    toggleFullScreen: () => ipcRenderer.send('win:toggleFullScreen'),
    onZoom: on('win:zoom'),
    hide: () => ipcRenderer.send('win:hide'),
    close: () => ipcRenderer.send('win:close'),
    progress: (state, value) => ipcRenderer.send('win:progress', { state, value })
  },
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.send('clipboard:write', text)
  },
  usage: {
    byProject: () => ipcRenderer.invoke('usage:projects')
  },
  tabs: {
    menu: (opts) => ipcRenderer.invoke('tab:menu', opts)
  },
  prompts: {
    get: () => ipcRenderer.invoke('prompts:get'),
    set: (list) => ipcRenderer.invoke('prompts:set', list)
  },
  workers: {
    onEvents: on('workers:events')
  },
  status: {
    onUpdate: on('status:update'),
    onGit: on('git:update'),
    onGitAll: on('git:all'),
    gitAll: () => ipcRenderer.invoke('git:all')
  },
  md: {
    resolve: (candidates, id) => ipcRenderer.invoke('md:resolve', { candidates, id }),
    open: (file, id) => ipcRenderer.send('md:open', { file, id })
  },
  files: {
    setOpen: (open) => ipcRenderer.send('files:setOpen', open),
    list: (id, rel) => ipcRenderer.invoke('files:list', { id, rel }),
    open: (id, rel) => ipcRenderer.send('files:open', { id, rel }),
    menu: (id, rel, dir) => ipcRenderer.send('files:menu', { id, rel, dir }),
    searchAll: (query) => ipcRenderer.invoke('files:searchAll', { query }),
    search: (id, query, opts) => ipcRenderer.invoke('files:search', { id, query, ...opts }),
    git: (id) => ipcRenderer.invoke('files:git', { id }),
    openAt: (id, rel, line) => ipcRenderer.send('files:openAt', { id, rel, line })
  },
  browser: {
    open: () => ipcRenderer.send('browser:open')
  },
  onToast: on('toast'),
  openConfig: () => ipcRenderer.send('app:openConfig'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url)
});

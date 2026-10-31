const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  listVersions: () => ipcRenderer.invoke('versions:list'),
  install: (version) => ipcRenderer.invoke('dsh:install', version),
  planUpgrade: (version) => ipcRenderer.invoke('upgrade:plan', version),
  applyUpgrade: (plan) => ipcRenderer.invoke('upgrade:apply', plan),
  uninstall: () => ipcRenderer.invoke('dsh:uninstall'),
  start: () => ipcRenderer.invoke('dsh:start'),
  stop: () => ipcRenderer.invoke('dsh:stop'),
  takeover: () => ipcRenderer.invoke('dsh:takeover'),
  open: () => ipcRenderer.invoke('dsh:open'),
  getLogs: () => ipcRenderer.invoke('log:get'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),
  setPort: (port) => ipcRenderer.invoke('port:set', port),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:auto-launch', enabled),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  onEvent: (fn) => {
    ipcRenderer.on('dsh:event', (_event, payload) => fn(payload))
  },
})

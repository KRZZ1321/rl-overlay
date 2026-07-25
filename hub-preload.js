// hub-preload.js — pont IPC du Hub (lecture seule + fermeture + réglages).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  onUpdate: (cb) => ipcRenderer.on('hub-update', (_e, vm) => cb(vm)),
  close: () => ipcRenderer.invoke('hub-close'),
  setFlag: (key, value) => ipcRenderer.invoke('set-overlay-flag', key, value),
  diagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  matches: () => ipcRenderer.invoke('get-matches'),
  resetSettings: () => ipcRenderer.invoke('reset-overlay-settings'),
  openLogs: () => ipcRenderer.invoke('open-logs-folder'),
  forceUpdateCheck: () => ipcRenderer.invoke('force-update-check'),
  enableStats: () => ipcRenderer.invoke('enable-stats-api'),
  copyObsUrl: () => ipcRenderer.invoke('copy-obs-url'),
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  getGoals: () => ipcRenderer.invoke('get-goals'),
  saveGoals: (list) => ipcRenderer.invoke('save-goals', list),
  saveTheme: (t) => ipcRenderer.invoke('save-custom-theme', t),
  deleteTheme: (name) => ipcRenderer.invoke('delete-custom-theme', name),
  applyTheme: (index) => ipcRenderer.invoke('apply-theme', index),
  workshop: {
    list: (o) => ipcRenderer.invoke('workshop:list', o),
    cache: () => ipcRenderer.invoke('workshop:cache'),
    session: () => ipcRenderer.invoke('workshop:session'),
    login: () => ipcRenderer.invoke('workshop:login'),
    logout: () => ipcRenderer.invoke('workshop:logout'),
    publish: (t) => ipcRenderer.invoke('workshop:publish', t),
    like: (id, liked) => ipcRenderer.invoke('workshop:like', { id, liked }),
    install: (id) => ipcRenderer.invoke('workshop:install', { id })
  }
});

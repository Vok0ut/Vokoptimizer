const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: '4.2.0',

  // window
  minimize: () => ipcRenderer.invoke('minimize-window'),
  maximize: () => ipcRenderer.invoke('maximize-window'),
  close:    () => ipcRenderer.invoke('close-window'),
  onMaximizeChange: (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('maximize-change', h); return () => ipcRenderer.removeListener('maximize-change', h); },

  // admin
  isAdmin:       () => ipcRenderer.invoke('is-admin'),
  relaunchAdmin: () => ipcRenderer.invoke('relaunch-admin'),

  // metrics
  getMetrics:    () => ipcRenderer.invoke('get-metrics'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // disk cleanup
  scanJunk:  ()    => ipcRenderer.invoke('scan-junk'),
  cleanJunk: (ids) => ipcRenderer.invoke('clean-junk', ids),

  // services
  listServices: ()             => ipcRenderer.invoke('list-services'),
  setService:   (name, action) => ipcRenderer.invoke('set-service', name, action),

  // startup
  listStartup:   ()             => ipcRenderer.invoke('list-startup'),
  toggleStartup: (item, enable) => ipcRenderer.invoke('toggle-startup', item, enable),

  // ram / cpu
  freeRam:        ()    => ipcRenderer.invoke('free-ram'),
  optimizeCpuRam: ()    => ipcRenderer.invoke('optimize-cpu-ram'),
  killProcess:    (pid) => ipcRenderer.invoke('kill-process', pid),

  // power
  setPowerProfile: (p)  => ipcRenderer.invoke('set-power-profile', p),
  setGameMode:     (en) => ipcRenderer.invoke('set-game-mode', en),
  setQuietMode:    (en) => ipcRenderer.invoke('set-quiet-mode', en),
  applyProfile:    (id) => ipcRenderer.invoke('apply-profile', id),

  // network
  flushDns:     () => ipcRenderer.invoke('flush-dns'),
  networkReset: () => ipcRenderer.invoke('network-reset'),

  // registry
  scanRegistry:  ()      => ipcRenderer.invoke('scan-registry'),
  cleanRegistry: (items) => ipcRenderer.invoke('clean-registry', items),

  // restore + repair
  createRestorePoint: ()     => ipcRenderer.invoke('create-restore-point'),
  runHealth:          (kind) => ipcRenderer.invoke('run-health', kind),
  cancelHealth:       ()     => ipcRenderer.invoke('cancel-health'),
  onHealthLog:  (cb) => { const h = (_e, l) => cb(l); ipcRenderer.on('health-log', h); return () => ipcRenderer.removeListener('health-log', h); },
  onHealthDone: (cb) => { const h = (_e, r) => cb(r); ipcRenderer.on('health-done', h); return () => ipcRenderer.removeListener('health-done', h); },

  // history
  getHistory:   () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  openBackups:  () => ipcRenderer.invoke('open-backups'),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: '4.2.1',

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

  // escaneos largos cancelables (apps sin usar, restos, juegos)
  cancelScan: (name) => ipcRenderer.invoke('cancel-scan', name),

  // apps sin usar + restos de configuración
  scanUnusedApps:    ()        => ipcRenderer.invoke('scan-unused-apps'),
  openAppFolder:     (path_)   => ipcRenderer.invoke('open-app-folder', path_),
  uninstallApp:      (appInfo) => ipcRenderer.invoke('uninstall-app', appInfo),
  scanConfigRemnants:()        => ipcRenderer.invoke('scan-config-remnants'),
  quarantineRemnant: (item)    => ipcRenderer.invoke('quarantine-remnant', item),
  listQuarantine:    ()        => ipcRenderer.invoke('list-quarantine'),
  restoreRemnant:    (id)      => ipcRenderer.invoke('restore-remnant', id),
  purgeRemnant:      (id)      => ipcRenderer.invoke('purge-remnant', id),

  // perfiles de juego
  scanGames:            ()               => ipcRenderer.invoke('scan-games'),
  applyGameProfile:     (game, category) => ipcRenderer.invoke('apply-game-profile', game, category),
  revertGameProfile:    ()               => ipcRenderer.invoke('revert-game-profile'),
  getActiveGameProfile: ()               => ipcRenderer.invoke('get-active-game-profile'),

  // auto-actualización
  updaterGetState: () => ipcRenderer.invoke('updater-get-state'),
  updaterCheck:    () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall:  () => ipcRenderer.invoke('updater-install'),
  onUpdaterState:  (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('updater-state', h); return () => ipcRenderer.removeListener('updater-state', h); },

  // asistente IA (Ollama local)
  ollamaCheck:        ()                                   => ipcRenderer.invoke('ollama-check'),
  ollamaListModels:   ()                                   => ipcRenderer.invoke('ollama-list-models'),
  ollamaChat:         (message, model, quick, conversationId) => ipcRenderer.invoke('ollama-chat', { message, model, quick, conversationId }),
  ollamaCancelChat:   ()                                   => ipcRenderer.invoke('ollama-chat-cancel'),
  ollamaListConversations:  ()   => ipcRenderer.invoke('ollama-list-conversations'),
  ollamaGetConversation:    (id) => ipcRenderer.invoke('ollama-get-conversation', id),
  ollamaDeleteConversation: (id) => ipcRenderer.invoke('ollama-delete-conversation', id),
  ollamaClearHistory: ()                      => ipcRenderer.invoke('ollama-clear-history'),
  ollamaGetPrefs:     ()                      => ipcRenderer.invoke('ollama-get-prefs'),
  ollamaSetPrefs:     (patch)                 => ipcRenderer.invoke('ollama-set-prefs', patch),
  ollamaConfirmAction: (id) => ipcRenderer.invoke('ollama-confirm-action', id),
  ollamaRejectAction:  (id) => ipcRenderer.invoke('ollama-reject-action', id),
  onOllamaChatChunk:      (cb) => { const h = (_e, c) => cb(c); ipcRenderer.on('ollama-chat-chunk', h); return () => ipcRenderer.removeListener('ollama-chat-chunk', h); },
  onOllamaDiagnosticEvent:(cb) => { const h = (_e, c) => cb(c); ipcRenderer.on('ollama-diagnostic-event', h); return () => ipcRenderer.removeListener('ollama-diagnostic-event', h); },
  onOllamaActionProposal: (cb) => { const h = (_e, c) => cb(c); ipcRenderer.on('ollama-action-proposal', h); return () => ipcRenderer.removeListener('ollama-action-proposal', h); },
});

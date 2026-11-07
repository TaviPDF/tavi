const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openPdf: () => ipcRenderer.invoke('file:open'),
  openPdfs: () => ipcRenderer.invoke('file:openMany'),
  savePdf: (data, name) => ipcRenderer.invoke('file:save', { data, name }),
  saveAs: (data, name, filterName, ext) => ipcRenderer.invoke('file:saveAs', { data, name, filterName, ext }),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  writeInto: (dir, name, data) => ipcRenderer.invoke('file:writeInto', { dir, name, data }),
  showInFolder: (p) => ipcRenderer.invoke('path:show', p),
  signatures: {
    list: () => ipcRenderer.invoke('sig:list'),
    save: (sig) => ipcRenderer.invoke('sig:save', sig),
    remove: (id) => ipcRenderer.invoke('sig:delete', id)
  },
  openPath: (p) => ipcRenderer.invoke('file:openPath', p),
  openDocs: () => ipcRenderer.invoke('file:openDocs'),
  openImages: () => ipcRenderer.invoke('file:openImages'),
  writeBack: (path, data) => ipcRenderer.invoke('file:writeBack', { path, data }),
  savePdfAs: (data, name, dir) => ipcRenderer.invoke('file:savePdfAs', { data, name, dir }),
  profile: { get: () => ipcRenderer.invoke('profile:get'), set: (d) => ipcRenderer.invoke('profile:set', d) },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  recent: { list: () => ipcRenderer.invoke('recent:list'), clear: () => ipcRenderer.invoke('recent:clear') },
  session: { save: (list) => ipcRenderer.invoke('session:save', list), load: () => ipcRenderer.invoke('session:load') },
  print: (o) => ipcRenderer.invoke('print:run', o),
  fullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  openDefaultApps: () => ipcRenderer.invoke('defaults:open'),
  ask: (system, messages) => ipcRenderer.invoke('ai:ask', { system, messages }),
  models: (provider) => ipcRenderer.invoke('ai:models', provider),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onOpenFile: (fn) => ipcRenderer.on('open-file', (_e, f) => fn(f)),
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    setAuto: (on) => ipcRenderer.invoke('update:setAuto', on),
    onState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s))
  }
});

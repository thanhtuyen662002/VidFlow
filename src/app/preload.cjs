// Standalone sandboxed preload. Keep API keys in sync with service registry (tested).
const { contextBridge, ipcRenderer } = require('electron');
const api = Object.create(null);
api.project = Object.freeze({
  create: input => ipcRenderer.invoke('project:create', input),
  list: input => ipcRenderer.invoke('project:list', input),
  get: input => ipcRenderer.invoke('project:get', input)
});
api.reference = Object.freeze({
  add: input => ipcRenderer.invoke('reference:add', input),
  list: input => ipcRenderer.invoke('reference:list', input)
});
api.bible = Object.freeze({
  update: input => ipcRenderer.invoke('bible:update', input)
});
api.script = Object.freeze({
  generate: input => ipcRenderer.invoke('script:generate', input),
  score: input => ipcRenderer.invoke('script:score', input),
  revise: input => ipcRenderer.invoke('script:revise', input),
  review: input => ipcRenderer.invoke('script:review', input),
  override: input => ipcRenderer.invoke('script:override', input),
  approve: input => ipcRenderer.invoke('script:approve', input)
});
api.storyboard = Object.freeze({
  generate: input => ipcRenderer.invoke('storyboard:generate', input),
  approve: input => ipcRenderer.invoke('storyboard:approve', input),
  get: input => ipcRenderer.invoke('storyboard:get', input),
  preview: input => ipcRenderer.invoke('storyboard:preview', input)
});
api.render = Object.freeze({
  enqueue: input => ipcRenderer.invoke('render:enqueue', input),
  run: input => ipcRenderer.invoke('render:run', input),
  status: input => ipcRenderer.invoke('render:status', input)
});
api.take = Object.freeze({
  list: input => ipcRenderer.invoke('take:list', input),
  select: input => ipcRenderer.invoke('take:select', input)
});
api.edit = Object.freeze({
  assemble: input => ipcRenderer.invoke('edit:assemble', input),
  capcut: input => ipcRenderer.invoke('edit:capcut', input),
  export: input => ipcRenderer.invoke('edit:export', input)
});
api.audio = Object.freeze({
  mix: input => ipcRenderer.invoke('audio:mix', input)
});
api.export = Object.freeze({
  package: input => ipcRenderer.invoke('export:package', input)
});
api.account = Object.freeze({
  create: input => ipcRenderer.invoke('account:create', input),
  list: input => ipcRenderer.invoke('account:list', input),
  status: input => ipcRenderer.invoke('account:status', input)
});
api.credit = Object.freeze({
  add: input => ipcRenderer.invoke('credit:add', input),
  list: input => ipcRenderer.invoke('credit:list', input)
});
api.queue = Object.freeze({
  list: input => ipcRenderer.invoke('queue:list', input)
});
api.onRenderProgress = callback => {
  if (typeof callback !== 'function') throw new TypeError('Expected callback');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('render:progress', listener);
  return () => ipcRenderer.removeListener('render:progress', listener);
};
contextBridge.exposeInMainWorld('vidflow', Object.freeze(api));

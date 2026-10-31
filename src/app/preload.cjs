// @ts-check
// Standalone sandbox preload: no local runtime imports.
const { contextBridge, ipcRenderer } = require('electron');
async function unwrap(channel, input) {
  const result = await ipcRenderer.invoke(channel, input);
  if (!result.ok) {
    const error = new Error(result.error.message);
    Object.assign(error, { code: result.error.code });
    throw error;
  }
  return result.data;
}
/** @satisfies {import('./api.ts').VidflowApi} */
const api = {
motion: Object.freeze({
  analyze: input => unwrap('motion:analyze', input),
  export: input => unwrap('motion:export', input),
  import: input => unwrap('motion:import', input),
  list_segments: input => unwrap('motion:list_segments', input),
  map_subjects: input => unwrap('motion:map_subjects', input),
  presets: input => unwrap('motion:presets', input),
  render: input => unwrap('motion:render', input),
  segment: input => unwrap('motion:segment', input),
  select_take: input => unwrap('motion:select_take', input),
  set_preset: input => unwrap('motion:set_preset', input),
  status: input => unwrap('motion:status', input),
  style_approve: input => unwrap('motion:style_approve', input),
  style_preview: input => unwrap('motion:style_preview', input),
  style_reject: input => unwrap('motion:style_reject', input),
  update_segment: input => unwrap('motion:update_segment', input)
}),
archive: Object.freeze({
  backup: input => ipcRenderer.invoke('archive:backup', input),
  restore: input => ipcRenderer.invoke('archive:restore', input)
}),
takes: Object.freeze({
  prunePreview: input => ipcRenderer.invoke('takes:prunePreview', input),
  pruneApply: input => ipcRenderer.invoke('takes:pruneApply', input)
}),
update: Object.freeze({
  check: input => ipcRenderer.invoke('update:check', input),
  download: input => ipcRenderer.invoke('update:download', input),
  install: input => ipcRenderer.invoke('update:install', input),
  status: input => ipcRenderer.invoke('update:status', input)
}),
template: Object.freeze({
  save: input => ipcRenderer.invoke('template:save', input),
  createProject: input => ipcRenderer.invoke('template:createProject', input),
  list: input => ipcRenderer.invoke('template:list', input),
  get: input => ipcRenderer.invoke('template:get', input),
  delete: input => ipcRenderer.invoke('template:delete', input)
}),
analytics: Object.freeze({
  accept: input => ipcRenderer.invoke('analytics:accept', input),
  import: input => ipcRenderer.invoke('analytics:import', input),
  list: input => ipcRenderer.invoke('analytics:list', input),
  reject: input => ipcRenderer.invoke('analytics:reject', input)
}),
project: Object.freeze({
  create: input => ipcRenderer.invoke('project:create', input),
  list: input => ipcRenderer.invoke('project:list', input),
  get: input => ipcRenderer.invoke('project:get', input)
}),
reference: Object.freeze({
  add: input => ipcRenderer.invoke('reference:add', input),
  list: input => ipcRenderer.invoke('reference:list', input),
  remove: input => ipcRenderer.invoke('reference:remove', input)
}),
bible: Object.freeze({
  get: projectId => unwrap('bible:get', { projectId }),
  update: (input, fields = undefined) => fields === undefined ? ipcRenderer.invoke('bible:update', input) : unwrap('bible:update', { projectId: input, fields })
}),
script: Object.freeze({
  generate: input => ipcRenderer.invoke('script:generate', input),
  score: input => ipcRenderer.invoke('script:score', input),
  revise: input => ipcRenderer.invoke('script:revise', input),
  review: input => ipcRenderer.invoke('script:review', input),
  override: (input, decision = undefined) => decision === undefined ? ipcRenderer.invoke('script:override', input) : unwrap('script:override', decision),
  approve: (input, decision = undefined) => decision === undefined ? ipcRenderer.invoke('script:approve', input) : unwrap('script:approve', decision),
  getGate: projectId => unwrap('script:getGate', { projectId }),
  skip: (projectId, input) => unwrap('script:skip', { projectId, ...input })
}),
storyboard: Object.freeze({
  reject: input => ipcRenderer.invoke('storyboard:reject', input),
  generate: input => ipcRenderer.invoke('storyboard:generate', input),
  approve: input => ipcRenderer.invoke('storyboard:approve', input),
  get: input => ipcRenderer.invoke('storyboard:get', input),
  preview: input => ipcRenderer.invoke('storyboard:preview', input)
}),
render: Object.freeze({
  cancel: input => ipcRenderer.invoke('render:cancel', input),
  redo: input => ipcRenderer.invoke('render:redo', input),
  decideRedo: input => ipcRenderer.invoke('render:decideRedo', input),
  enqueue: input => ipcRenderer.invoke('render:enqueue', input),
  run: input => ipcRenderer.invoke('render:run', input),
  status: input => ipcRenderer.invoke('render:status', input)
}),
take: Object.freeze({
  list: input => ipcRenderer.invoke('take:list', input),
  select: input => ipcRenderer.invoke('take:select', input)
}),
edit: Object.freeze({
  assemble: input => ipcRenderer.invoke('edit:assemble', input),
  capcut: input => ipcRenderer.invoke('edit:capcut', input),
  export: input => ipcRenderer.invoke('edit:export', input)
}),
audio: Object.freeze({
  mix: input => ipcRenderer.invoke('audio:mix', input)
}),
export: Object.freeze({
  package: input => ipcRenderer.invoke('export:package', input)
}),
account: Object.freeze({
  create: input => ipcRenderer.invoke('account:create', input),
  list: input => ipcRenderer.invoke('account:list', input),
  status: input => ipcRenderer.invoke('account:status', input)
}),
credit: Object.freeze({
  add: input => ipcRenderer.invoke('credit:add', input),
  list: input => ipcRenderer.invoke('credit:list', input)
}),
queue: Object.freeze({
  list: input => ipcRenderer.invoke('queue:list', input)
}),
budget: Object.freeze({
  get: input => ipcRenderer.invoke('budget:get', input),
  set: input => ipcRenderer.invoke('budget:set', input)
}),
settings: Object.freeze({
  get: input => ipcRenderer.invoke('settings:get', input),
  configure: input => ipcRenderer.invoke('settings:configure', input),
  rotate: input => ipcRenderer.invoke('settings:rotate', input),
  revoke: input => ipcRenderer.invoke('settings:revoke', input)
}),
projects: Object.freeze({
  list: () => unwrap('project:list', {}),
  create: input => unwrap('project:create', { ...input, aspect: '16:9' })
}),
references: Object.freeze({
  list: projectId => unwrap('reference:list', { projectId }),
  add: (projectId, input) => { const { role, ...fields } = input; return unwrap('reference:add', { projectId, ...fields, kind: role }); },
  remove: (projectId, refId) => unwrap('reference:remove', { projectId, refId })
}),
onRenderProgress: callback => {
  if (typeof callback !== 'function') throw new TypeError('Expected callback');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('render:progress', listener);
  return () => ipcRenderer.removeListener('render:progress', listener);
}
};
contextBridge.exposeInMainWorld('vidflow', Object.freeze(api));

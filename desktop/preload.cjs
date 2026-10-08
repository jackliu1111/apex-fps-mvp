const { contextBridge, ipcRenderer } = require('electron');
const operations = new Set(['get_config', 'browse', 'probe_media', 'confirm_audio', 'get_media',
  'analyze', 'get_task', 'get_result', 'read_scores', 'recompute_candidates', 'update_selection',
  'request_preview', 'get_artifact', 'export', 'cancel_task']);
const request = (operation, payload = {}) => {
  if (!operations.has(operation)) return Promise.resolve({ error: { code: 'not_found', message: '操作不存在', status: 404 } });
  return ipcRenderer.invoke('apex:execute', { operation, payload });
};
contextBridge.exposeInMainWorld('apex', Object.freeze({
  request,
  execute: async (operation, payload = {}) => {
    const response = await request(operation, payload);
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  },
  artifactUrl: (id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new Error('媒体标识无效');
    return `apex://artifact/${id}`;
  },
  chooseRecordings: () => ipcRenderer.invoke('apex:choose-recordings'),
  openArtifactFolder: (id) => ipcRenderer.invoke('apex:open-artifact-folder', id),
}));

const { app, BrowserWindow, ipcMain, protocol, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { WorkerClient } = require('./worker-client.cjs');
const { createProtocolHandler } = require('./protocol.cjs');
const { runtime } = require('./runtime.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'apex', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }]);
let window, worker, quitting = false;
const operations = new Set(['get_config', 'browse', 'probe_media', 'confirm_audio', 'get_media',
  'analyze', 'get_task', 'get_result', 'read_scores', 'recompute_candidates', 'update_selection',
  'request_preview', 'get_artifact', 'export', 'cancel_task']);
const ownFrame = event => window && event.sender === window.webContents &&
  event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('apex://ui/');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const resources = runtime(app);
    const data = path.join(app.getPath('userData'), 'model-data');
    fs.mkdirSync(data, { recursive: true });
    const log = fs.createWriteStream(path.join(data, 'desktop-worker.log'), { flags: 'a' });
    const args = [...resources.args, '--data-dir', data, '--ffmpeg', resources.ffmpeg, '--ffprobe', resources.ffprobe,
      '--parent-pid', String(process.pid)];
    if (resources.modelWorkspace) args.push('--model-workspace', resources.modelWorkspace);
    if (resources.checkpoint) args.push('--checkpoint', resources.checkpoint);
    worker = new WorkerClient({ command: resources.command, args, onLog: data => log.write(data),
      onFailure: error => {
        if (!quitting && window) dialog.showMessageBox(window, { type: 'error',
          title: '任务进程已停止', message: error.message, buttons: ['确定'] }).catch(() => {});
      } });
    protocol.handle('apex', createProtocolHandler(worker, resources));
    ipcMain.handle('apex:execute', async (event, request) => {
      try {
        if (!ownFrame(event) || !request || !operations.has(request.operation)) throw Object.assign(new Error('操作不受允许'), { code: 'not_found', status: 403 });
        if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload) ||
            Buffer.byteLength(JSON.stringify(request)) > 65536) throw Object.assign(new Error('请求无效'), { code: 'invalid_request', status: 400 });
        return { result: await worker.execute(request.operation, request.payload) };
      } catch (error) { return { error: { code: error.code || 'worker_unavailable', message: error.message, status: error.status || 503 } }; }
    });
    ipcMain.handle('apex:choose-recordings', async event => {
      if (!ownFrame(event)) return [];
      const chosen = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'],
        filters: [{ name: '录像', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'] }] });
      return chosen.canceled ? [] : chosen.filePaths;
    });
    ipcMain.handle('apex:open-artifact-folder', async (event, id) => {
      if (!ownFrame(event)) return;
      const artifact = await worker.execute('get_artifact', { artifact_id: id });
      shell.showItemInFolder(artifact.path);
    });
    window = new BrowserWindow({ width: 1280, height: 900, minWidth: 800, title: 'Apex · 枪声候选',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('apex://ui/')) event.preventDefault(); });
    await window.loadURL('apex://ui/index.html');
  }).catch(error => { dialog.showErrorBox('无法启动桌面服务', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!quitting && worker) {
      event.preventDefault(); quitting = true;
      worker.close().finally(() => app.quit());
    }
  });
  process.on('exit', () => { if (worker) worker.terminate(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
}

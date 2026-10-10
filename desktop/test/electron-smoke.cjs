/** Actual Electron preload/renderer/public IPC smoke. Launch with Electron. */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { WorkerClient } = require('../worker-client.cjs');
const { createProtocolHandler } = require('../protocol.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'apex', privileges: { standard: true, secure: true,
  supportFetchAPI: true, stream: true, corsEnabled: true } }]);
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-electron-'));
  const packageRoot = process.env.APEX_PACKAGED_APP ? path.join(process.env.APEX_PACKAGED_APP, 'Contents/Resources/app.asar') : path.resolve(__dirname, '..');
  const nativeRoot = process.env.APEX_PACKAGED_APP && path.join(process.env.APEX_PACKAGED_APP, 'Contents/Resources/runtime');
  const manifest = nativeRoot && JSON.parse(fs.readFileSync(path.join(nativeRoot, 'manifest.json')));
  const command = nativeRoot ? path.join(nativeRoot, manifest.service) : process.env.APEX_PYTHON || 'python3';
  const args = nativeRoot ? ['--data-dir', directory, '--ffmpeg', path.join(nativeRoot, manifest.ffmpeg),
    '--ffprobe', path.join(nativeRoot, manifest.ffprobe), '--model-workspace', path.join(nativeRoot, manifest.model_workspace),
    '--checkpoint', path.join(nativeRoot, manifest.checkpoint)] : [path.join(root, 'model_ipc.py'), '--data-dir', directory,
    '--ffmpeg', process.env.APEX_FFMPEG || 'ffmpeg', '--ffprobe', process.env.APEX_FFPROBE || 'ffprobe'];
  const client = new WorkerClient({ command, args });
  try {
    protocol.handle('apex', createProtocolHandler(client, { uiDir: nativeRoot ? path.join(packageRoot, 'ui') : path.join(root, 'model_web_ui'), hostDir: packageRoot }));
    ipcMain.handle('apex:execute', async (event, request) => {
      try { return { result: await client.execute(request.operation, request.payload) }; }
      catch (error) { return { error: { code: error.code, message: error.message, status: error.status } }; }
    });
    const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(packageRoot, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('apex://ui/index.html');
    const observed = await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && !document.querySelector('#source'); i++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!document.querySelector('#source')) throw new Error('React host did not load shared UI');
      const config = await window.apex.execute('get_config', {});
      const missing = await window.apex.request('get_task', { task_id: '0'.repeat(32) });
      const transport = await fetch('apex://ui/transport.js');
      const traversal = await fetch('apex://ui/../../model_service.py');
      return { modelState: config.model_state, transport: transport.status, traversal: traversal.status,
        request: typeof window.apex.request, missingCode: missing.error.code, missingStatus: missing.error.status,
        node: typeof require, artifact: window.apex.artifactUrl('a'.repeat(32)) };
    })()`);
    assert.deepEqual(observed, { modelState: 'not_loaded', transport: 200, traversal: 404,
      request: 'function', missingCode: 'task_not_found', missingStatus: 404,
      node: 'undefined', artifact: 'apex://artifact/' + 'a'.repeat(32) });
    window.destroy();
    console.log('PASS Electron isolated preload/shared UI/IPC/protocol/plain coded error' + (nativeRoot ? ' from packaged asar/runtime' : ' from source'));
  } finally { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

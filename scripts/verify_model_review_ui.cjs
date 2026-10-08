/* Public renderer/IPC review scenarios in an isolated Electron window. */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fixture } = require('../desktop/test/service-fixture.cjs');
const { createProtocolHandler } = require('../desktop/protocol.cjs');
const root = path.resolve(__dirname, '..');
const scenario = process.env.APEX_UI_SCENARIO || 'restore-result';
protocol.registerSchemesAsPrivileged([{ scheme: 'apex', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }]);
app.on('window-all-closed', () => {}); // Finish process cleanup and report assertion failures.

app.whenReady().then(async () => {
  const gate = scenario === 'reopen-active' ? path.join(os.tmpdir(), 'apex-ui-release-' + randomUUID()) : null;
  const failureTool = scenario === 'failure-log' ? path.join(os.tmpdir(), 'apex-ui-media-error-' + randomUUID()) : null;
  if (failureTool) {
    fs.writeFileSync(failureTool, '#!/bin/sh\nprintf "controlled audio decoder failure\\n" >&2\nexit 13\n', { mode: 0o755 });
  }
  const f = await fixture(undefined, failureTool ? { serviceFfmpeg: failureTool } : gate ? { gate } : {});
  let window;
  try {
    const second = path.join(f.directory, '第二份 录像.mp4');
    const encoded = spawnSync(process.env.APEX_FFMPEG || '/opt/homebrew/bin/ffmpeg',
      ['-nostdin', '-v', 'error', '-n', '-i', f.video, '-t', '12', '-c', 'copy', second]);
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    protocol.handle('apex', createProtocolHandler(f.client, {
      uiDir: path.join(root, 'model_web_ui'), hostDir: path.join(root, 'desktop'),
    }));
    ipcMain.handle('apex:execute', async (_event, request) => {
      try { return { result: await f.execute(request.operation, request.payload) }; }
      catch (error) { return { error: { code: error.code, message: error.message, status: error.status } }; }
    });
    window = new BrowserWindow({ show: false, width: 1200, height: 900,
      webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false } });
    window.webContents.setAudioMuted(true);
    await window.loadURL('apex://ui/index.html');
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    const until = async expression => {
      for (let i = 0; i < 300; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('UI did not reach: ' + expression + '\n' + await evaluate("document.querySelector('#notice')?.textContent"));
    };
    await until("!!document.querySelector('#source') && !document.querySelector('#probe').disabled");
    await evaluate(`document.querySelector('#source').value = ${JSON.stringify(f.video + '\n' + second)};
      document.querySelector('#probe-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));`);
    await until("document.querySelectorAll('#recordings li').length === 2 && !document.querySelector('#probe').disabled");
    for (let index = 0; index < 2; index++) {
      await evaluate(`document.querySelectorAll('#recordings li')[${index}].querySelector('button').click();
        document.querySelector('#tracks input').click(); document.querySelector('#confirm').click();`);
      await until("document.querySelector('#selection').textContent.includes('已保存音轨') && !document.querySelector('#probe').disabled");
    }
    await evaluate("document.querySelector('#analyze').click()");
    if (scenario === 'failure-log') {
      await until("document.querySelector('#task-status').textContent.includes('失败') && !document.querySelector('#probe').disabled");
      assert.equal(await evaluate("document.querySelector('#task-log').textContent.includes('controlled audio decoder failure')"), true,
        'users should be able to inspect the actual media diagnostic in the task log');
      const output = path.join(root, 'outputs/issue-service-validation');
      fs.writeFileSync(path.join(output, 'ui-' + scenario + '.png'), (await window.webContents.capturePage()).toPNG());
      console.log('PASS public renderer/IPC ' + scenario);
      return;
    }
    if (scenario === 'reopen-active') {
      await until("!document.querySelector('#task').hidden && document.querySelector('#task-status').textContent.includes('加载模型')");
      const before = await evaluate("document.querySelector('#task-log').textContent.match(/任务 ([0-9a-f]{32})/)?.[1]");
      window.destroy();
      window = new BrowserWindow({ show: false, width: 1200, height: 900,
        webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), sandbox: true,
          contextIsolation: true, nodeIntegration: false } });
      await window.loadURL('apex://ui/index.html');
      await until("!!document.querySelector('#source') && document.querySelector('#configuration dd') && !document.querySelector('#notice').textContent.includes('正在读取服务配置')");
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(await evaluate("document.querySelector('#task').hidden"), false,
        'a newly opened page should discover the existing background task');
      assert.equal(await evaluate("document.querySelector('#task-log').textContent.match(/任务 ([0-9a-f]{32})/)?.[1]"), before);
      assert.equal(await evaluate("document.querySelector('#analyze').disabled"), true);
      fs.writeFileSync(gate, '');
      await until("document.querySelectorAll('#result-list button').length === 2 && !document.querySelector('#analyze').disabled");
      const output = path.join(root, 'outputs/issue-service-validation');
      fs.writeFileSync(path.join(output, 'ui-' + scenario + '.png'), (await window.webContents.capturePage()).toPNG());
      console.log('PASS public renderer/IPC ' + scenario);
      return;
    }
    await until("document.querySelectorAll('#result-list button').length === 2 && !document.querySelector('#analyze').disabled");
    await evaluate("document.querySelectorAll('#result-list button')[1].click()");
    await until("Number(document.querySelector('#score-end').value) === 12 && !document.querySelector('#probe').disabled");
    if (scenario === 'missing-task') {
      await evaluate("sessionStorage.setItem('modelTaskId', '0'.repeat(32)); sessionStorage.setItem('modelAnalysisTaskId', '0'.repeat(32));");
    }
    const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.reload();
    await reloaded;
    if (scenario === 'missing-task') {
      await until("!!document.querySelector('#source') && /(任务查询失败|原任务不存在)/.test(document.querySelector('#notice').textContent)");
      assert.equal(await evaluate("document.querySelector('#probe').disabled"), false,
        'a missing saved task should release the recording controls');
      assert.equal(await evaluate("document.querySelector('#analyze').disabled"), false,
        'the confirmed recordings should be usable for a new task');
    } else {
      await until("!!document.querySelector('#source') && !document.querySelector('#probe').disabled && !document.querySelector('#result').hidden");
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await evaluate("Number(document.querySelector('#score-end').value)"), 12,
      'refresh should keep the reviewed second recording');
    if (scenario === 'result-source') {
      assert.equal(await evaluate(`document.querySelector('#result-source').textContent.includes(${JSON.stringify(second)})`), true,
        'the review should identify its source recording');
      assert.equal(await evaluate(`document.querySelector('#task-status').textContent.includes(${JSON.stringify(second)})`), true,
        'the task should identify the recording it processed');
    }
    if (scenario === 'candidate-duration') {
      assert.equal(await evaluate("document.querySelector('#candidates [aria-label=\"候选 1 自动时长\"]')?.textContent"), '7.336 秒',
        'each automatic candidate should expose its own duration');
      await evaluate("const fields = document.querySelectorAll('#candidates input[type=number]'); fields[0].value = '0.4'; fields[0].dispatchEvent(new Event('input', { bubbles: true })); fields[1].value = '3.8'; fields[1].dispatchEvent(new Event('input', { bubbles: true }));");
      assert.equal(await evaluate("document.querySelector('#candidates [aria-label=\"候选 1 请求时长\"]')?.textContent"), '3.400 秒',
        'editing a request range should update its duration');
      assert.equal(await evaluate("document.querySelector('#candidates [aria-label=\"候选 1 自动时长\"]')?.textContent"), '7.336 秒');
    }
    if (scenario === 'export-playback') {
      await evaluate("document.querySelector('#export').click()");
      await until("!document.querySelector('#exports').hidden && document.querySelector('#export-list').textContent.includes('.mp4') && !document.querySelector('#probe').disabled");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('#export-list button')).some(button => button.textContent === '播放成片')"), true,
        'completed exports should have an action to play their registered media');
      await evaluate("Array.from(document.querySelectorAll('#export-list button')).find(button => button.textContent === '播放成片').click()");
      await until("document.querySelector('#preview-video').readyState >= 2 && !document.querySelector('#preview').hidden");
      assert.equal(await evaluate("document.querySelector('#preview-video').paused"), false,
        'the exported video should be playing');
      await evaluate("document.querySelector('#preview').scrollIntoView({ block: 'center' })");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const screenshot = await window.webContents.capturePage();
    const output = path.join(root, 'outputs/issue-service-validation');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'ui-' + scenario + '.png'), screenshot.toPNG());
    console.log('PASS public renderer/IPC ' + scenario);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await f.close();
    if (gate) fs.rmSync(gate, { force: true });
    if (failureTool) fs.rmSync(failureTool, { force: true });
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

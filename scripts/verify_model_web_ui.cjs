/* Real-model Python HTTP flow through the public review page in an isolated browser. */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const sample = process.env.APEX_SAMPLE;
  const workspace = process.env.APEX_MODEL_WORKSPACE;
  const audio = Number(process.env.APEX_SAMPLE_AUDIO_STREAM);
  assert.ok(sample && workspace && process.env.APEX_SAMPLE_AUDIO_STREAM !== undefined,
    'Set APEX_SAMPLE, APEX_MODEL_WORKSPACE and an explicit APEX_SAMPLE_AUDIO_STREAM');
  assert.ok(Number.isInteger(audio) && audio >= 0, 'audio stream must be a container stream index');
  const python = process.env.APEX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const ffmpeg = process.env.APEX_FFMPEG || 'ffmpeg';
  const ffprobe = process.env.APEX_FFPROBE || 'ffprobe';
  const uiStageTimeoutMs = process.env.APEX_UI_STAGE_TIMEOUT_MS === undefined
    ? 45000 : Number(process.env.APEX_UI_STAGE_TIMEOUT_MS);
  assert.ok(Number.isFinite(uiStageTimeoutMs) && uiStageTimeoutMs > 0,
    'APEX_UI_STAGE_TIMEOUT_MS must be a finite positive number');
  assert.ok(process.env.APEX_UI_FIRST_CANDIDATE_ONLY === undefined
    || ['0', '1'].includes(process.env.APEX_UI_FIRST_CANDIDATE_ONLY),
    'APEX_UI_FIRST_CANDIDATE_ONLY must be 0 or 1');
  const firstCandidateOnly = process.env.APEX_UI_FIRST_CANDIDATE_ONLY === '1';
  const candidateTrimS = 0.04;
  const directory = path.resolve(process.env.APEX_VALIDATION_DIR ||
    path.join(root, 'outputs/issue16-ui-validation', randomUUID().slice(0, 8)));
  fs.mkdirSync(directory, { recursive: true });
  const log = fs.createWriteStream(path.join(directory, 'http-server.log'));
  const server = spawn(python, ['-u', path.join(root, 'model_web.py'), '--port', '0',
    '--data-dir', path.join(directory, 'data'), '--model-workspace', workspace,
    '--engine-python', process.env.APEX_ENGINE_PYTHON || python,
    '--ffmpeg', ffmpeg, '--ffprobe', ffprobe], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.pipe(log);
  let window;
  const started = Date.now();
  const report = { scope: firstCandidateOnly
      ? 'real-model public Python HTTP page; first candidate preview and one independent export only; all-selected export requires separate evidence'
      : 'real-model public Python HTTP page', sample,
    audio_stream: audio, platform: process.platform, architecture: process.arch,
    cpu: os.cpus()[0]?.model, human_sync_review: 'required', clean_machine: 'not_evaluated',
    ui_configuration: { stage_timeout_ms: uiStageTimeoutMs,
      request_range_mode: firstCandidateOnly ? 'first-candidate-trim' : 'fixed-1.3-7.7',
      candidate_trim_s: firstCandidateOnly ? candidateTrimS : null,
      export_selection: firstCandidateOnly ? 'first-candidate-only' : 'all-candidates' } };
  const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
  const ownedProcesses = new Map([[process.pid, { pid: process.pid, role: 'electron-script-host' }],
    [server.pid, { pid: server.pid, role: 'python-http-server' }]]);
  const captureOwnedProcesses = () => {
    for (const metric of app.getAppMetrics()) ownedProcesses.set(metric.pid,
      { pid: metric.pid, role: 'electron-' + metric.type });
    if (process.platform !== 'win32') {
      const queue = [server.pid];
      for (let index = 0; index < queue.length; index++) {
        const parentPid = queue[index];
        const children = spawnSync('/usr/bin/pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
        for (const value of (children.stdout || '').trim().split(/\s+/)) {
          const pid = Number(value);
          if (Number.isInteger(pid) && pid > 0 && !ownedProcesses.has(pid)) {
            ownedProcesses.set(pid, { pid, parent_pid: parentPid, role: 'http-server-descendant' });
            queue.push(pid);
          }
        }
      }
    }
    save('owned-processes.json', { scope: 'script host, Electron app metrics and observed server descendants; check these PIDs after the script exits',
      processes: [...ownedProcesses.values()].filter(item => Number.isInteger(item.pid) && item.pid > 0) });
  };
  try {
    const address = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('HTTP service readiness timeout')), 15000);
      const lines = createInterface({ input: server.stdout });
      lines.on('line', line => {
        if (line.startsWith('Python Web: ')) { clearTimeout(timeout); resolve(new URL(line.slice(12))); }
      });
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error('HTTP service exited: ' + code)); });
    });
    const token = new URLSearchParams(address.hash.slice(1)).get('token');
    const api = async (route) => {
      const response = await fetch(new URL(route, address), { headers: { 'X-Apex-Token': token } });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    };
    const newWindow = () => new BrowserWindow({ show: false, width: 1200, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: 'apex-http-evidence-' + randomUUID() } });
    window = newWindow();
    window.webContents.setAudioMuted(true);
    await window.loadURL(address.href);
    captureOwnedProcesses();
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    const until = async expression => {
      const deadline = Date.now() + uiStageTimeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('UI did not reach within ' + uiStageTimeoutMs + ' ms: ' + expression + '\n' +
        await evaluate("document.querySelector('#notice')?.textContent"));
    };
    const currentTask = async () => {
      const identifier = await evaluate("document.querySelector('#task-log').textContent.match(/任务 ([0-9a-f]{32})/)?.[1]");
      assert.ok(identifier, 'task reference should be visible');
      return api('/api/tasks/' + identifier);
    };
    await until("!!document.querySelector('#source') && !document.querySelector('#probe').disabled");
    await evaluate(`document.querySelector('#source').value = ${JSON.stringify(sample)};
      document.querySelector('#probe-form').requestSubmit();`);
    await until("!document.querySelector('#media').hidden && !document.querySelector('#probe').disabled");
    assert.equal(await evaluate("document.querySelector('#confirm').disabled"), true,
      'even a single audio track requires explicit confirmation');
    await evaluate(`const track = document.querySelector('#tracks input[value="${audio}"]');
      if (!track) throw new Error('requested audio stream is unavailable'); track.click();
      document.querySelector('#confirm').click();`);
    await until("!document.querySelector('#analyze').disabled");
    await evaluate("document.querySelector('#analyze').click()");
    if (process.env.APEX_REOPEN_PAGE === '1') {
      await until("!document.querySelector('#task').hidden && document.querySelector('#task-log').textContent.includes('任务 ')");
      const originalReference = await evaluate("document.querySelector('#task-log').textContent.match(/任务 ([0-9a-f]{32})/)?.[1]");
      window.destroy();
      window = newWindow(); window.webContents.setAudioMuted(true);
      await window.loadURL(address.href);
      captureOwnedProcesses();
      await until("!!document.querySelector('#task') && !document.querySelector('#task').hidden");
      assert.equal(await evaluate("document.querySelector('#task-log').textContent.match(/任务 ([0-9a-f]{32})/)?.[1]"), originalReference,
        'closing the page must retain the same background task for a new session');
      report.reopened_page_restored_task = originalReference;
    }
    await until("!document.querySelector('#result').hidden && !document.querySelector('#probe').disabled");
    const analyzed = await currentTask();
    assert.equal(analyzed.status, 'completed', JSON.stringify(analyzed));
    const original = await api('/api/results/' + analyzed.result_id);
    captureOwnedProcesses();
    assert.equal(original.prediction.model.name, 'BEATs_strong_1');
    assert.equal(original.prediction.classes.length, 447);
    assert.ok(original.candidates.length > 0, 'this supplied recording needs a candidate for review evidence');
    const displayedDefaults = await evaluate(`({ threshold: Number(document.querySelector('#threshold').value),
      merge_gap_s: Number(document.querySelector('#merge-gap').value), before_s: Number(document.querySelector('#before').value),
      after_s: Number(document.querySelector('#after').value) })`);
    assert.deepEqual(displayedDefaults, { threshold: 0.2, merge_gap_s: 5, before_s: 5, after_s: 5 });
    assert.deepEqual(displayedDefaults, Object.fromEntries(Object.keys(displayedDefaults)
      .map(key => [key, original.parameters[key]])));
    Object.assign(report, { original_postprocessing: original.parameters, ui_displayed_original_parameters: displayedDefaults,
      source: original.media.source, video: original.media.video, duration_s: original.media.duration_s,
      selected_audio: original.media.selected_audio, analysis_elapsed_s: analyzed.elapsed_s,
      analysis_timings: analyzed.timings, analysis_records: analyzed.results,
      service_configuration: await api('/api/config') });
    save('analysis-task.json', analyzed); save('original-result.json', original);
    await evaluate("document.querySelector('#after').value = '2'; document.querySelector('#parameters-form').requestSubmit()");
    await until("document.querySelector('#notice').textContent.includes('候选已更新') && !document.querySelector('#probe').disabled");
    const recomputed = await api('/api/results/' + original.result_id);
    assert.notEqual(recomputed.candidate_version, original.candidate_version);
    assert.deepEqual(recomputed.prediction, original.prediction);
    assert.ok(recomputed.selection.every(item => item.selected));
    const firstCandidate = recomputed.candidates[0];
    const requestedRange = firstCandidateOnly
      ? { start_s: firstCandidate.start_s + candidateTrimS, end_s: firstCandidate.end_s - candidateTrimS }
      : { start_s: 1.3, end_s: 7.7 };
    assert.ok(Number.isFinite(requestedRange.start_s) && Number.isFinite(requestedRange.end_s)
      && requestedRange.start_s >= 0 && requestedRange.start_s < requestedRange.end_s
      && requestedRange.end_s <= original.media.duration_s, 'configured candidate trim must leave a valid range');
    await evaluate(`const fields = document.querySelectorAll('#candidates input[type=number]');
      fields[0].value = ${JSON.stringify(String(requestedRange.start_s))}; fields[0].dispatchEvent(new Event('input', { bubbles: true }));
      fields[1].value = ${JSON.stringify(String(requestedRange.end_s))}; fields[1].dispatchEvent(new Event('input', { bubbles: true }));
      ${firstCandidateOnly ? `Array.from(document.querySelectorAll('#candidates input[type=checkbox]')).forEach((checkbox, index) => {
        if (checkbox.checked !== (index === 0)) checkbox.click();
      });` : ''}
      document.querySelector('#save-selection').click();`);
    await until("document.querySelector('#notice').textContent.includes('范围已保存') && !document.querySelector('#probe').disabled");
    await evaluate("document.querySelector('#candidates button').click()");
    await until("!document.querySelector('#preview').hidden && !document.querySelector('#probe').disabled");
    const previewTask = await currentTask();
    assert.equal(previewTask.status, 'completed');
    const preview = await api('/api/artifacts/' + previewTask.preview_id);
    assert.deepEqual(preview.requested_range, requestedRange);
    await evaluate("document.querySelector('#preview-video').play()");
    await until("document.querySelector('#preview-video').readyState >= 2");
    const seekS = firstCandidateOnly ? Math.min(2, (requestedRange.end_s - requestedRange.start_s) / 2) : 2;
    await evaluate(`document.querySelector('#preview-video').currentTime = ${seekS}`);
    await until(`document.querySelector('#preview-video').currentTime >= ${Math.max(0, seekS - 0.1)} && !document.querySelector('#preview-video').paused`);
    save('preview-task.json', previewTask); save('preview.json', preview);
    await evaluate(`document.querySelector('#output-dir').value = ${JSON.stringify(path.join(directory, '独立 输出'))};
      document.querySelector('#export-form').requestSubmit();`);
    await until("!document.querySelector('#exports').hidden && document.querySelector('#export-list').textContent.includes('.mp4') && !document.querySelector('#probe').disabled");
    const exported = await currentTask();
    assert.equal(exported.status, 'completed', JSON.stringify(exported));
    assert.equal(exported.exports.length, firstCandidateOnly ? 1 : recomputed.selection.length);
    const changed = await api('/api/results/' + original.result_id);
    assert.deepEqual(changed.prediction, original.prediction);
    assert.deepEqual(changed.candidates, recomputed.candidates);
    assert.deepEqual(changed.selection.map(item => item.selected),
      recomputed.selection.map((_, index) => firstCandidateOnly ? index === 0 : true));
    Object.assign(report, { recomputed_postprocessing: recomputed.parameters,
      reviewed_candidate_id: firstCandidate.candidate_id,
      reviewed_automatic_range: { start_s: firstCandidate.start_s, end_s: firstCandidate.end_s },
      requested_range: requestedRange, playback_seek_s: seekS,
      selected_candidate_count: changed.selection.filter(item => item.selected).length,
      exports: exported.exports });
    save('selected-result.json', changed); save('export-task.json', exported);
    const decoded = [];
    for (const artifact of [preview, ...exported.exports]) {
      const info = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', artifact.path]);
      assert.equal(info.status, 0, info.stderr.toString());
      const decode = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', artifact.path,
        '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
      assert.equal(decode.status, 0, decode.stderr.toString());
      decoded.push({ artifact_id: artifact.artifact_id, probe: JSON.parse(info.stdout), full_decode: 'passed' });
    }
    await evaluate("Array.from(document.querySelectorAll('#export-list button')).find(button => button.textContent === '播放成片').click()");
    await until("document.querySelector('#preview-video').readyState >= 2 && !document.querySelector('#preview-video').paused");
    await evaluate("document.querySelector('#preview').scrollIntoView({ block: 'center' })");
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(directory, 'real-http-playback.png'), (await window.webContents.capturePage()).toPNG());
    Object.assign(report, { status: 'passed', elapsed_s: (Date.now() - started) / 1000,
      video: original.media.video, model: original.prediction.model,
      frame_count: original.prediction.frame_count, candidate_count: original.candidates.length,
      decoded_artifacts: decoded, export_files: exported.exports.length });
    save('report.json', report);
    console.log(JSON.stringify({ status: 'passed', evidence: directory, elapsed_s: report.elapsed_s,
      decoded_artifacts: decoded.length, scope: report.scope }));
  } catch (error) {
    Object.assign(report, { status: 'failed', error: error.message, elapsed_s: (Date.now() - started) / 1000 });
    save('report.json', report);
    throw error;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGINT');
      const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timeout);
    }
    log.end();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

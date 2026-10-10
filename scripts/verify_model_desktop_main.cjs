/* Public real packaged Electron renderer/lifecycle audit. No fixture model or HTTP business API. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const appBundle = process.env.APEX_PACKAGED_APP || path.join(root, 'dist/model-desktop/mac-arm64/Apex Model Review.app');
const executable = path.join(appBundle, 'Contents/MacOS/Apex Model Review');
const runtime = path.join(appBundle, 'Contents/Resources/runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json')));
const output = process.env.APEX_DESKTOP_AUDIT_DIR || path.join(root, 'outputs/desktop-main-audit');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function processes() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), status: match[3], command: match[4] }] : [];
  });
}
function descendants(pid) {
  const all = processes(), known = new Set([pid]);
  for (let previous = 0; previous !== known.size;) {
    previous = known.size;
    for (const entry of all) if (known.has(entry.parent)) known.add(entry.pid);
  }
  return all.filter(entry => known.has(entry.pid) && entry.pid !== pid);
}
function runtimeProcesses(pid) { return descendants(pid).filter(entry => entry.command.startsWith(runtime + path.sep)); }
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); clearTimeout(pending.timeout);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
    });
    socket.addEventListener('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('CDP target closed')); } this.pending.clear(); });
  }
  command(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async until(expression, timeoutMs = 30000) {
    const stop = Date.now() + timeoutMs;
    while (Date.now() < stop) { if (await this.evaluate(expression)) return; await pause(80); }
    throw new Error('Renderer did not reach ' + expression + ': ' + await this.evaluate("document.querySelector('#notice')?.textContent"));
  }
  async screenshot(name) {
    const { data } = await this.command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
  }
  close() { this.socket.close(); }
}
async function start() {
  const debugPort = await port();
  const app = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debugPort],
    { env: { ...process.env, PATH: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  app.stdout.on('data', chunk => { logs += chunk; }); app.stderr.on('data', chunk => { logs += chunk; });
  let target;
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Packaged app exited: ' + logs);
    try { const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); target = targets.find(entry => entry.type === 'page' && entry.url.startsWith('apex://ui/')); } catch {}
    if (target) break;
    await pause(80);
  }
  if (!target) { app.kill('SIGTERM'); throw new Error('No actual packaged renderer endpoint: ' + logs); }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const cdp = new Cdp(socket);
  await cdp.command('Page.enable');
  await cdp.until("!!document.querySelector('#source') && !document.querySelector('#probe').disabled");
  return { app, cdp, logs: () => logs };
}
async function request(cdp, operation, payload) {
  const response = await cdp.evaluate(`window.apex.request(${JSON.stringify(operation)}, ${JSON.stringify(payload)})`);
  if (response.error) throw Object.assign(new Error(response.error.message), response.error);
  return response.result;
}
async function currentTask(cdp) {
  const text = await cdp.evaluate("document.querySelector('#task-log').textContent");
  const match = /^任务 ([0-9a-f]{32})/.exec(text);
  assert.ok(match, 'the public task log should identify its task');
  return request(cdp, 'get_task', { task_id: match[1] });
}
async function importRecording(cdp, recording) {
  await cdp.evaluate("while(document.querySelector('#recordings button[aria-label^=移除]'))document.querySelector('#recordings button[aria-label^=移除]').click();");
  await cdp.evaluate(`document.querySelector('#source').value=${JSON.stringify(recording)}; document.querySelector('#probe-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await cdp.until("document.querySelectorAll('#recordings li').length === 1 && !document.querySelector('#probe').disabled");
  await cdp.evaluate("document.querySelector('#tracks input').click(); document.querySelector('#confirm').click();");
  await cdp.until("document.querySelector('#selection').textContent.includes('已保存音轨') && !document.querySelector('#analyze').disabled");
}
async function stop(host, signal = 'SIGTERM') {
  if (!host) return;
  host.cdp.close();
  if (host.app.exitCode === null && host.app.signalCode === null) {
    host.app.kill(signal);
    await Promise.race([new Promise(resolve => host.app.once('exit', resolve)), pause(10000).then(() => { host.app.kill('SIGKILL'); })]);
  }
}
async function awaitGone(entries) {
  const began=Date.now();
  for (let i = 0; i < 150; i++) {
    const current = new Map(processes().map(entry => [entry.pid, entry]));
    const live = entries.filter(old => current.has(old.pid));
    if (!live.length) return { elapsed_ms:Date.now()-began, remaining: [] };
    await pause(100);
  }
  const current = new Map(processes().map(entry => [entry.pid, entry]));
  throw new Error('Orphan model/media process: ' + JSON.stringify(entries.filter(old => current.has(old.pid))));
}
async function main() {
  assert.equal(process.platform, 'darwin', 'This audit uses actual native Mac process evidence');
  assert.equal(processes().filter(entry => entry.command.startsWith(executable)).length, 0, 'An existing packaged app is running; do not disturb it');
  const sample = process.env.APEX_SAMPLE || '/Users/jackliu/payload/sample-apex.mp4';
  const recording = path.join(output, '中文 用户录像.mp4'); if (!fs.existsSync(recording)) fs.copyFileSync(sample, recording);
  const report = { scope: 'actual packaged Electron main/preload/renderer + real BEATs on local 20s 960x540 sample; PATH hides developer executables; no clean-machine or human quality/sync claim',
    bundle: appBundle, manifest, source: recording, cases: {} };
  let host, result, exportTask;
  if (process.env.APEX_DESKTOP_LIFECYCLE_ONLY || process.env.APEX_DESKTOP_MEDIA_ONLY) {
    const previous=JSON.parse(fs.readFileSync(path.join(output,'audit.json')));
    Object.assign(report,previous);report.manifest=manifest;
    if(report.cases.real_ui && !report.cases.real_ui.manifest)report.cases.real_ui.manifest=previous.manifest;
  }
  try {
    host = await start();
    console.log('actual packaged renderer ready');
    const config = await request(host.cdp, 'get_config', {}); report.config = config;
    assert.ok(config.model_workspace.startsWith(runtime)); assert.ok(config.ffmpeg.startsWith(runtime));
    assert.equal(await host.cdp.evaluate("typeof require"), 'undefined');
    const before = runtimeProcesses(host.app.pid).filter(entry => entry.parent === host.app.pid);
    assert.equal(before.length, 1);
    const second = spawn(executable, [], { env: { ...process.env, PATH: '/nonexistent' }, stdio: 'ignore' });
    const secondExit = await Promise.race([new Promise(resolve => second.once('exit', (code, signal) => resolve({ code, signal }))), pause(5000).then(() => { second.kill('SIGKILL'); throw new Error('second app instance did not exit'); })]);
    assert.equal(secondExit.code, 0);
    assert.deepEqual(runtimeProcesses(host.app.pid).filter(entry => entry.parent === host.app.pid).map(entry => entry.pid), before.map(entry => entry.pid));
    report.cases.single_instance = { status: 'passed', first_main_pid: host.app.pid, second_pid: second.pid, second_exit: secondExit, core_process: before[0] };
    console.log('single-instance second start exited without another core');
    if (!process.env.APEX_DESKTOP_LIFECYCLE_ONLY && !process.env.APEX_DESKTOP_MEDIA_ONLY) {
    await importRecording(host.cdp, recording);
    await host.cdp.evaluate("document.querySelector('#analyze').click()");
    await host.cdp.until("document.querySelectorAll('#result-list button').length === 1 && !document.querySelector('#analyze').disabled", 60000);
    const analysisTask = await currentTask(host.cdp);
    assert.equal(analysisTask.status, 'completed');
    result = await request(host.cdp, 'get_result', { result_id: analysisTask.result_id });
    assert.equal(result.prediction.model.name, 'BEATs_strong_1'); assert.equal(result.prediction.classes.length, 447);
    assert.ok(result.candidates.length, 'the fixed real sample has at least one gunfire candidate');
    await host.cdp.evaluate("document.querySelector('#before').value='2'; document.querySelector('#after').value='2'; document.querySelector('#parameters-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));");
    await host.cdp.until("document.querySelector('#notice').textContent.includes('重新') && !document.querySelector('#probe').disabled");
    const changed = await request(host.cdp, 'get_result', { result_id: result.result_id });
    assert.notEqual(changed.candidate_version, result.candidate_version); assert.equal(changed.prediction_id, result.prediction_id);
    await host.cdp.evaluate("const inputs=document.querySelector('#candidates tr').querySelectorAll('input[type=number]'); inputs[0].value='1'; inputs[1].value='4'; inputs.forEach(input=>input.dispatchEvent(new Event('input',{bubbles:true}))); document.querySelector('#save-selection').click();");
    await host.cdp.until("document.querySelector('#selection-summary').textContent.includes('已保存') && !document.querySelector('#probe').disabled");
    await host.cdp.evaluate("document.querySelector('#candidates button').click()");
    await host.cdp.until("!document.querySelector('#preview').hidden && document.querySelector('#preview-video').readyState>=2 && !document.querySelector('#probe').disabled", 30000);
    const previewTask = await currentTask(host.cdp); assert.equal(previewTask.status, 'completed');
    const preview = await request(host.cdp, 'get_artifact', { artifact_id: previewTask.preview_id });
    assert.deepEqual(preview.requested_range, { start_s: 1, end_s: 4 });
    await host.cdp.evaluate("document.querySelector('#preview-video').muted=true; document.querySelector('#preview-video').play()");
    await host.cdp.until("!document.querySelector('#preview-video').paused && document.querySelector('#preview-video').currentTime>0");
    await host.cdp.evaluate("document.querySelector('#preview').scrollIntoView({block:'center'})"); await pause(200);
    await host.cdp.screenshot('packaged-real-preview');
    await host.cdp.evaluate(`document.querySelector('#output-dir').value=${JSON.stringify(path.join(output, '中文 输出'))}; document.querySelector('#export-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await host.cdp.until("!document.querySelector('#exports').hidden && document.querySelector('#export-list').textContent.includes('.mp4') && !document.querySelector('#probe').disabled", 30000);
    exportTask = await currentTask(host.cdp); assert.equal(exportTask.status, 'completed'); assert.equal(exportTask.exports.length, 1);
    await host.cdp.evaluate("Array.from(document.querySelectorAll('#export-list button')).find(button=>button.textContent==='播放成片').click()");
    await host.cdp.until("document.querySelector('#preview-video').readyState>=2 && !document.querySelector('#preview-video').paused");
    await host.cdp.evaluate("document.querySelector('#preview').scrollIntoView({block:'center'})"); await pause(200);
    await host.cdp.screenshot('packaged-real-export');
    for (const artifact of [preview, ...exportTask.exports]) {
      const decode = spawnSync(path.join(runtime, manifest.ffmpeg), ['-nostdin','-v','error','-xerror','-i',artifact.path,'-map','0:v','-map','0:a','-f','null','-'], { env: { ...process.env, PATH: '/nonexistent' } });
      assert.equal(decode.status, 0, decode.stderr.toString());
    }
    report.cases.real_ui = { status: 'passed', manifest, analysis: analysisTask, result, recomputed: changed, preview: previewTask, exported: exportTask,
      rendered_source: await host.cdp.evaluate("document.querySelector('#result-source').textContent"), playback: await host.cdp.evaluate("({paused:document.querySelector('#preview-video').paused,readyState:document.querySelector('#preview-video').readyState,source:document.querySelector('#preview-video').currentSrc})"), decoded_files: [preview.path,...exportTask.exports.map(item=>item.path)] };
    fs.writeFileSync(path.join(output,'audit.json'),JSON.stringify(report,null,2));
    console.log('real packaged UI analysis/recompute/range/preview/export/playback/full decode passed');
    } else { result = report.cases.real_ui.result; exportTask = report.cases.real_ui.exported; }
    if (process.env.APEX_DESKTOP_MEDIA_ONLY) {
      const current=await request(host.cdp,'get_result',{result_id:result.result_id});
      const ref={result_id:current.result_id,candidate_version:current.candidate_version};
      await request(host.cdp,'update_selection',{...ref,clips:[{candidate_id:current.candidates[0].candidate_id,start_s:0,end_s:20}]});
      const submitted=await request(host.cdp,'request_preview',{...ref,candidate_id:current.candidates[0].candidate_id});
      let tracked=[];
      const mediaCommand=path.join(runtime,manifest.ffmpeg);
      for(let i=0;i<300;i++) {
        tracked=runtimeProcesses(host.app.pid);
        if(tracked.some(entry=>entry.command.startsWith(mediaCommand)))break;
        await pause(15);
      }
      assert.ok(tracked.some(entry=>entry.command.startsWith(mediaCommand)),'actual packaged FFmpeg should be active before crashing main');
      const running=await request(host.cdp,'get_task',submitted);
      assert.equal(running.status,'running');
      assert.ok(running.pending_paths?.length,'media task should expose unfinished output for cleanup audit');
      const mainPid=host.app.pid;
      await stop(host,'SIGKILL');host=null;
      const cleanup=await awaitGone(tracked);
      for(const incomplete of running.pending_paths) assert.equal(fs.existsSync(incomplete),false,'main crash should remove incomplete media');
      host=await start();
      const terminal=await request(host.cdp,'get_task',submitted);
      assert.equal(terminal.status,'failed');assert.equal(terminal.error.code,'service_interrupted');
      report.cases.media_main_crash_cleanup={status:'passed',main_pid:mainPid,task_id:submitted.task_id,tracked,cleanup,removed_paths:running.pending_paths,restarted_terminal:terminal.status,error:terminal.error};
      const lastTracked=runtimeProcesses(host.app.pid);await stop(host);host=null;await awaitGone(lastTracked);
      fs.writeFileSync(path.join(output,'audit.json'),JSON.stringify(report,null,2));
      console.log('PASS actual packaged main SIGKILL during FFmpeg: no live core/guardian/media, partial removed, restart terminal');
      return;
    }
    const longRecording = path.join(output,'循环媒体夹具 240秒.mp4');
    const encoded = spawnSync(path.join(runtime,manifest.ffmpeg),['-nostdin','-v','error','-y','-stream_loop','11','-i',recording,'-t','240','-c','copy',longRecording]);
    assert.equal(encoded.status,0,encoded.stderr.toString());
    await importRecording(host.cdp,longRecording);
    const previous = exportTask.task_id;
    await host.cdp.evaluate("document.querySelector('#analyze').click()");
    await host.cdp.until(`!!document.querySelector('#task-log').textContent.match(/^任务 ([0-9a-f]{32})/) && !document.querySelector('#task-log').textContent.startsWith('任务 ${previous}')`,10000);
    const running = await currentTask(host.cdp); assert.equal(running.status,'running');
    let tracked = [];
    for (let i=0;i<300;i++) {
      tracked=runtimeProcesses(host.app.pid);
      if(tracked.some(entry=>entry.command.includes('--inference-worker') && !entry.command.includes('--process-guardian'))) break;
      await pause(30);
    }
    assert.ok(tracked.some(entry=>entry.command.includes('--inference-worker') && !entry.command.includes('--process-guardian')),'real inference worker should start before main crash');
    const crashedMain = host.app.pid;
    await stop(host,'SIGKILL'); host=null;
    const cleanup = await awaitGone(tracked);
    report.cases.main_crash_cleanup = { status:'passed',main_pid:crashedMain,task_id:running.task_id,tracked,cleanup,workload:'240s loop of fixed 20s sample; lifecycle fixture, not representative recording'};
    console.log('SIGKILL actual main left no live core/guardian/inference worker');
    host=await start();
    const recovered=await request(host.cdp,'get_task',{task_id:running.task_id});
    assert.equal(recovered.status,'failed',JSON.stringify(recovered));assert.equal(recovered.error.code,'service_interrupted');
    const kept=await request(host.cdp,'get_result',{result_id:result.result_id}); assert.equal(kept.prediction_id,result.prediction_id);
    report.cases.restart_after_main_crash = {status:'passed',terminal:recovered.status,error:recovered.error,completed_result_id:kept.result_id};
    const lastTracked=runtimeProcesses(host.app.pid);
    await stop(host); host=null; await awaitGone(lastTracked);
    report.cases.normal_exit_cleanup={status:'passed',tracked:lastTracked};
    fs.writeFileSync(path.join(output,'audit.json'),JSON.stringify(report,null,2));
    console.log('PASS actual packaged Electron real-model UI, single-instance, crash/restart/normal cleanup');
  } finally { if(host) await stop(host); }
}
module.exports={start,stop,request,currentTask,runtimeProcesses,awaitGone,runtime,manifest,output,pause,processes,executable};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});

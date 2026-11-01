import * as MB from '/assets/vendor/mediabunny.mjs';
import { createSyntheticFile } from './synthetic-media.mjs';
import { createBrowserConverter } from '../browser-export.mjs';
import { createExportQueue } from '../export-queue.mjs';
const $ = id => document.getElementById(id);
const events = [], observations = [], rawHandles = new Map();
let source, directory, currentId, activeGate, gateMode = 'none', sequence = 0, saveTimer;
const stamp = () => new Date().toISOString();
const record = (type, detail = {}) => { events.push({ at: stamp(), type, ...detail }); render(); };
const snapshot = () => ({ at: stamp(), origin: location.origin, userAgent: navigator.userAgent, secureContext: isSecureContext,
  pickerIsNative: Function.prototype.toString.call(window.showDirectoryPicker).includes('[native code]'), source: source ? { name: source.name, size: source.size } : null,
  directory: directory?.name || null, currentId, gateMode, gate: activeGate ? { type: activeGate.type, detail: activeGate.detail } : null,
  jobs: queue.list(), observations, events });
async function persist() {
  clearTimeout(saveTimer);
  const response = await fetch('/tests/native-state.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()) });
  if (!response.ok) throw new Error(`证据保存失败 ${response.status}`);
}
function render() {
  $('directory').textContent = directory ? `当前目录：${directory.name}` : '尚未选择目录';
  $('state').textContent = JSON.stringify(currentId ? queue.getBatch(currentId) : {}, null, 2);
  $('events').textContent = events.slice(-14).map(event => JSON.stringify(event)).join('\n');
  $('gate').textContent = activeGate ? `已暂停：${activeGate.type}，可以取消或撤销权限，再点击释放暂停点` : '没有暂停点';
  clearTimeout(saveTimer); saveTimer = setTimeout(() => persist().catch(error => { $('status').textContent = error.message; }), 80);
}
async function pause(type, detail) {
  if (gateMode !== type || activeGate) return;
  gateMode = 'none';
  const completion = Promise.withResolvers();
  activeGate = { type, detail, release: completion.resolve };
  record('gate-enter', { gate: type, ...detail });
  await persist();
  await completion.promise;
  activeGate = null;
  record('gate-release', { gate: type, ...detail });
}
function adapter(raw) {
  let permissionChecks = 0;
  return {
    name: raw.name,
    async queryPermission(options) {
      permissionChecks++;
      if (permissionChecks === 2) await pause('second-permission', { directory: raw.name });
      const result = await raw.queryPermission(options);
      record('native-permission', { directory: raw.name, result, permissionChecks });
      return result;
    },
    async isSameEntry(other) { return raw.isSameEntry(other.raw || other); },
    raw,
    async getFileHandle(name, options) {
      const handle = await raw.getFileHandle(name, options);
      if (options?.create) record('native-create', { directory: raw.name, name });
      return {
        getFile: () => handle.getFile(),
        async createWritable() {
          const writer = await handle.createWritable();
          record('native-writer-open', { directory: raw.name, name });
          return {
            async write(chunk) {
              await pause('first-write', { directory: raw.name, name });
              await writer.write(chunk);
              record('native-write', { directory: raw.name, name, position: chunk.position, bytes: chunk.data.byteLength });
            },
            async close() {
              await pause('first-close', { directory: raw.name, name });
              await writer.close();
              record('native-close-success', { directory: raw.name, name });
              await pause('after-close', { directory: raw.name, name });
            },
            async abort() {
              try { await writer.abort(); record('native-abort-success', { directory: raw.name, name }); }
              catch (error) { record('native-abort-error', { directory: raw.name, name, error: error.message }); throw error; }
            },
          };
        },
      };
    },
    async removeEntry(name) {
      try { await raw.removeEntry(name); record('native-remove-success', { directory: raw.name, name }); }
      catch (error) { record('native-remove-error', { directory: raw.name, name, error: error.message }); throw error; }
    },
  };
}
const queue = createExportQueue({ convert: createBrowserConverter({ MB }), onChange(state) {
  record('queue-state', { id: state.id, status: state.status, clips: state.clipResults.map(x => x.status), outputs: state.outputs.map(x => ({ name: x.name, saved: x.saved, directory: x.destination.name })), error: state.error });
} });
const action = fn => async () => { try { await fn(); } catch (error) { record('action-error', { name: error.name, message: error.message }); $('status').textContent = `${error.name}：${error.message}`; await persist(); } };
async function pick() {
  record('picker-open', { userActivation: navigator.userActivation.isActive });
  try {
    const selected = await window.showDirectoryPicker({ id: 'adr6-native-acceptance', mode: 'readwrite' });
    const permission = await selected.queryPermission({ mode: 'readwrite' });
    record('picker-selected', { directory: selected.name, permission });
    if (permission !== 'granted') throw new Error(`目录写入权限为 ${permission}`);
    directory = selected; rawHandles.set(selected.name, selected);
    $('status').textContent = `已取得真实目录：${selected.name}`; render(); return selected;
  } catch (error) { record('picker-rejected', { name: error.name, message: error.message }); throw error; }
}
function start(mode, count) {
  if (!source) throw new Error('请先生成样本');
  if (!directory) throw new Error('请先原生选择目录');
  if (queue.list().some(job => ['queued', 'running'].includes(job.status))) throw new Error('请先结束当前运行中的批次');
  gateMode = mode;
  currentId = `native-${++sequence}-${mode}`;
  const file = new File([source], `${currentId}.webm`, { type: source.type });
  const batch = { id: currentId, sourceId: currentId, audio: { trackIndex: 1 }, output: { format: 'webm', width: 640, height: 360, videoBitrate: 600000, audioBitrate: 64000 },
    clips: [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }].slice(0, count) };
  record('batch-submit', { batch, directory: directory.name });
  queue.enqueue(batch, { file, directoryHandle: adapter(directory) });
  $('status').textContent = `已提交 ${currentId}`;
  void queue.whenIdle().then(() => { record('queue-idle', { id: currentId }); return persist(); });
}
$('prepare').onclick = action(async () => { source = await createSyntheticFile({ duration: 12 }); $('source').textContent = `样本已生成：${source.name} · ${source.size} 字节`; record('source-ready', { name: source.name, size: source.size }); });
$('choose').onclick = action(pick);
$('permission').onclick = action(async () => { if (!directory) throw new Error('未选目录'); const result = await directory.queryPermission({ mode: 'readwrite' }); record('manual-native-permission', { directory: directory.name, result }); $('status').textContent = `真实写入权限：${result}`; });
$('normal').onclick = action(() => start('none', 3));
$('write').onclick = action(() => start('first-write', 3));
$('close').onclick = action(() => start('first-close', 1));
$('closed').onclick = action(() => start('after-close', 1));
$('between').onclick = action(() => start('second-permission', 3));
$('cancel').onclick = action(() => { record('user-cancel', { id: currentId }); queue.cancel(currentId); $('status').textContent = '已提出取消请求，请释放暂停点以观察真实结束结果'; });
$('release').onclick = action(() => { if (!activeGate) throw new Error('没有暂停点'); activeGate.release(); });
$('resume').onclick = action(async () => { const selected = await pick(); record('user-resume', { id: currentId, directory: selected.name }); queue.resume(currentId, adapter(selected)); await queue.whenIdle(); await persist(); });
$('snapshot').onclick = action(async () => { await persist(); $('status').textContent = '证据已写入本机测试服务器'; });
$('inspect').onclick = action(async () => {
  const inspection = [];
  for (const job of queue.list()) for (const result of job.outputs) {
    try {
      const handle = rawHandles.get(result.destination.name);
      const file = await (await handle.getFileHandle(result.name)).getFile();
      const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
      try { inspection.push({ batch: job.id, directory: result.destination.name, name: file.name, size: file.size, duration: await input.computeDuration(), videoCodec: (await input.getPrimaryVideoTrack()).codec, audioCodec: (await input.getPrimaryAudioTrack()).codec }); }
      finally { input.dispose(); }
    } catch (error) { inspection.push({ batch: job.id, directory: result.destination.name, name: result.name, error: error.message }); }
  }
  observations.push({ at: stamp(), inspection }); record('native-readback', { inspection }); $('status').textContent = `读回 ${inspection.length} 个保存记录`; await persist();
});
window.addEventListener('error', event => record('window-error', { message: event.message }));
window.addEventListener('unhandledrejection', event => record('unhandled-rejection', { message: event.reason?.message || String(event.reason) }));
record('harness-ready');

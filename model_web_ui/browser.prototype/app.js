import { createSelectionTimeline, selectionWindow } from './selection-timeline.mjs';
import { batchSummary, justCompleted, taskFeedback, createFrameSignal } from './task-feedback.mjs';
import * as MB from '/assets/vendor/mediabunny.mjs';
import { createReviewWorkspace } from './review-workspace.mjs';
import { createIndexedDBStorage, identifyFile } from './review-storage.mjs';
import { createBrowserAnalysis } from './browser-analysis.mjs';
import { createSourcePlayer } from './source-player.mjs';
import { createExportQueue, estimateExportBytes } from './export-queue.mjs';
import { createBrowserConverter } from './browser-export.mjs';
import { DEFAULT_EXPORT_SETTINGS, MAX_EXPORT_MEMORY_BYTES, sourceExportSettings, exportSettings } from './export-policy.mjs';

const $ = (id) => document.getElementById(id);
const bindings = new Map(), identified = new WeakMap(), pendingImports = new Set();
const queueRows = new Map(), clipRows = new Map(), batchRows = new Map();
const seenCandidates = new Map();
const presentedRecords = new WeakSet();
const startingExports = new Set();
let currentPage = 'analysis', activeSourceId = null, playerSourceId = null, loadingSource = false, loadToken = 0;
let relinkSourceId = null, navigationError = null, restoreReady = false, makingDemo = false, directoryHandle = null, exportQueue, selectionTimeline;
let view = { sources: [], batches: [], save: { status: 'saved' } }, playerState = { position: 0, playing: false, status: 'empty' };
const statuses = { preparing: '正在准备', queued: '排队中', analyzing: '分析中', complete: '分析完成', completed: '分析完成', stopped: '已停止', failed: '失败', interrupted: '已中断' };
const time = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const errorText = (error) => error?.message || String(error);
const source = () => view.sources.find((item) => item.id === activeSourceId);
const selectedClip = () => source()?.clips.find((clip) => clip.id === source().review.selectedClipId);
const note = (message, tone = 'info') => { $('status').textContent = message; $('status').dataset.tone = tone; $('status').dataset.page = currentPage; $('status').hidden = false; };
const safely = (action) => Promise.resolve().then(action).catch((error) => note(errorText(error), 'error'));
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, action) => { const node = element('button', text); node.onclick = () => safely(action); return node; };
const setValue = (node, value) => { if (document.activeElement !== node) node.value = value; };
function rememberNavigation() {
  try { localStorage.setItem('apex-review-navigation-v1', JSON.stringify({ sourceId: activeSourceId, page: currentPage })); navigationError = null; }
  catch (error) { navigationError = errorText(error); }
  renderSave();
}
function renderSave() {
  const labels = { saved: '选片与复核位置已保存', saving: '正在保存…', unsaved: '修改待保存', error: '尚未保存' };
  const message = `${labels[view.save.reviewStatus || view.save.status] || '正在恢复…'}${navigationError ? '；页面位置未保存' : ''}${view.save.error ? `：${view.save.error}` : ''}`;
  if ($('save-state').textContent !== message) $('save-state').textContent = message;
  $('save-state').classList.toggle('error', view.save.status === 'error' || !!navigationError);
  $('retry-save').hidden = view.save.status !== 'error' && !navigationError;
}
const workspace = createReviewWorkspace({ storage: createIndexedDBStorage(), onChange(next) { view = next; render(); } });
const queue = createBrowserAnalysis({ MB,
  onWaveform(record, waveform) { if (record.sourceId) workspace.updateWaveform(record.sourceId, waveform); },
  async onPrepared(record) {
    const identity = identified.get(record.file) || await identifyFile(record.file);
    record.sourceId = workspace.addSource({ ...identity, duration: record.duration });
    bindings.set(record.sourceId, record);
  },
  onCandidates(record, candidates) { if (record.sourceId) workspace.publishCandidates(record.sourceId, candidates); },
  onChange(record) {
    if (record.sourceId) {
      const next = { status: record.status === 'complete' ? 'completed' : record.status, processedUntil: Math.min(record.duration, Math.max(0, record.processedUntil || 0)), error: record.error || null };
      const prior = workspace.getSource(record.sourceId).analysis;
      if (Object.keys(next).some((key) => next[key] !== prior[key])) workspace.updateAnalysis(record.sourceId, next);
    }
    render(); exportQueue?.pump();
  },
});
const player = createSourcePlayer({ MB, canvas: $('source-canvas'), onState(next) {
  playerState = next;
  if (!loadingSource && playerSourceId && playerSourceId === activeSourceId) {
    const saved = workspace.getSource(playerSourceId).review.position;
    if (Math.abs(saved - next.position) >= 0.25 || (!next.playing && saved !== next.position)) workspace.setReview(playerSourceId, { position: next.position }, { background: true });
  }
  renderPlayer();
} });

let outputSettings = DEFAULT_EXPORT_SETTINGS;
exportQueue = createExportQueue({
  convert: createBrowserConverter({ MB }),
  canRun: () => !queue.records.some((record) => ['preparing', 'queued', 'analyzing'].includes(record.status)),
  onChange({ id, status, outputs, error, progress, clipResults }) { workspace.updateBatch(id, { status, outputs, error, progress, clipResults }); },
});
async function chooseOutputDirectory() {
  if (!window.showDirectoryPicker) throw new Error('此浏览器不支持直接选择输出目录，请使用较小批次的下载链接。');
  directoryHandle = await window.showDirectoryPicker({ id: 'apex-clip-exports', mode: 'readwrite' });
  $('output-directory').textContent = `输出目录：${directoryHandle.name}`;
  $('clear-directory').hidden = false;
  return directoryHandle;
}
async function submitExport() {
  const saved = source(), record = bindings.get(activeSourceId);
  if (!saved) throw new Error('请先选择要导出的录像。');
  if (!record) { note('选片已保留，请重新选择原录像文件；关联后即可提交导出。'); requestRelink(saved.id); return; }
  const clips = saved.clips.filter((clip) => clip.selected && !clip.provisional);
  if (!clips.length) throw new Error('没有范围已确定且已选中的片段。');
  const batch = workspace.submitBatch(saved.id, { audio: { trackIndex: record.outputAudioTrackIndex, policy: 'source-primary' }, output: { ...sourceExportSettings(outputSettings, record.video), model: record.model } });
  return startExport(batch.id);
}
async function startExport(id) {
  if (startingExports.has(id) || exportQueue.getBatch(id)) return;
  const batch = view.batches.find((item) => item.id === id), record = bindings.get(batch?.sourceId);
  if (!record) { note('请先关联这批任务的原录像，再选择目录开始导出。'); if (batch) requestRelink(batch.sourceId); return; }
  startingExports.add(id);
  let destination = directoryHandle;
  try {
    if (estimateExportBytes(batch) > MAX_EXPORT_MEMORY_BYTES && !destination) {
      workspace.updateBatch(batch.id, { status: 'awaiting-destination', error: null });
      showExports();
      destination = await chooseOutputDirectory();
      if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    }
    workspace.updateBatch(batch.id, { status: 'queued', error: null, destination: destination ? { mode: 'directory', name: destination.name } : { mode: 'download' } });
    exportQueue.enqueue(batch, { file: record.file, origin: record.origin, directoryHandle: destination });
  } catch (error) {
    if (!destination && view.batches.find((item) => item.id === id)?.status === 'awaiting-destination') {
      const message = error.name === 'AbortError' ? '尚未取得输出目录，导出未开始。若没有弹出目录窗口，请在桌面 Chrome 中打开本页后选择输出目录。' : `无法选择输出目录：${errorText(error)}。请在支持目录选择的桌面 Chrome 中打开本页。`;
      workspace.updateBatch(id, { status: 'awaiting-destination', error: message });
      return;
    }
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    workspace.updateBatch(id, { status: 'failed', error: errorText(error) });
    throw error;
  } finally { startingExports.delete(id); renderExports(); }
  note('已提交导出，可在「导出任务」查看进度和成片。可以继续复核。');
}

async function importFiles(files) {
  await ready;
  if (!restoreReady) throw new Error('请先重试恢复已有记录，再导入录像');
  const options = { model: $('model').value, threshold: 0.2 };
  const failures = [];
  const importMessage = `正在准备 ${files.length} 份录像；每份就绪后独立进入分析。`;
  note(importMessage);
  await Promise.all([...files].map(async (file) => {
    let reservedId;
    try {
      const identity = await identifyFile(file);
      identified.set(file, identity);
      if (bindings.has(identity.id) || pendingImports.has(identity.id)) { note(`${file.name} 已在当前工作区中。`); return; }
      reservedId = identity.id; pendingImports.add(reservedId);
      await queue.importFiles([file], options);
    } catch (error) {
      failures.push(`${file.name}：${errorText(error)}`);
    } finally {
      if (reservedId) pendingImports.delete(reservedId);
      render();
    }
  }));
  if (failures.length) note(`以下录像未能导入，可重新选择重试：${failures.join('；')}。其他就绪录像继续分析。`, 'error');
  else if ($('status').textContent === importMessage) note('录像已加入 · 可随时复核', 'quiet');
}
async function openReview(id) {
  if (!view.sources.some((item) => item.id === id)) return;
  if (currentPage === 'review') player.pause();
  activeSourceId = id; currentPage = 'review'; rememberNavigation();
  seenCandidates.set(id, workspace.getSource(id).clips.filter((clip) => !clip.provisional).length);
  render();
  const record = bindings.get(id), token = ++loadToken;
  $('threshold').value = record?.threshold ?? 0.2;
  playerSourceId = null; loadingSource = true;
  $('source-canvas').getContext('2d').clearRect(0, 0, $('source-canvas').width, $('source-canvas').height);
  try {
    if (record) {
      const saved = workspace.getSource(id);
      await player.load({ file: record.file, origin: record.origin, duration: record.duration, position: saved.review.position });
    } else await player.dispose();
    if (token !== loadToken) return;
    playerSourceId = record ? id : null;
  } catch (error) { if (token === loadToken) note(errorText(error)); }
  finally { if (token === loadToken) { loadingSource = false; renderPlayer(); } }
}
function showAnalysis() {
  player.pause(); loadToken++; loadingSource = false; currentPage = 'analysis'; selectionTimeline?.suspend(); rememberNavigation(); render();
}
function showExports() {
  player.pause(); loadToken++; loadingSource = false; currentPage = 'exports'; selectionTimeline?.suspend(); rememberNavigation(); render();
}
function requestRelink(id) { relinkSourceId = id; $('relink-file').click(); }
async function relink(file) {
  const wanted = relinkSourceId; relinkSourceId = null;
  if (!file || !wanted) return;
  const identity = await identifyFile(file);
  if (identity.id !== wanted) throw new Error('所选文件与保存的原录像身份不一致。已有选片保留，请选择原文件。');
  await importFiles([file]);
  if (activeSourceId === wanted && currentPage === 'review') await openReview(wanted);
}
function renderQueue() {
  const rows = view.sources.map((saved) => ({ key: saved.id, saved, record: bindings.get(saved.id) }));
  for (const record of queue.records) if (!record.sourceId) rows.push({ key: `runtime:${record.id}`, record });
  const populated = rows.length > 0;
  const guide = document.querySelector('.workflow-guide');
  if (guide.dataset.populated !== String(populated)) {
    if (populated && guide.contains(document.activeElement)) guide.querySelector('summary').focus({ preventScroll: true });
    guide.open = !populated;
    guide.dataset.populated = String(populated);
  }
  $('analysis-page').classList.toggle('has-recordings', populated);
  const analyzing = rows.filter(({ record }) => record?.status === 'analyzing').length;
  const waiting = rows.filter(({ record }) => ['preparing', 'queued'].includes(record?.status)).length;
  $('queue-count').textContent = `${rows.length} 份录像`;
  $('queue-summary').textContent = !restoreReady ? '复核记录尚未就绪，请查看保存状态。' : analyzing || waiting
    ? `${analyzing} 份分析中 · ${waiting} 份待分析`
    : view.sources.length ? '当前没有正在分析的录像，可进入复核或导入新录像。'
      : rows.length ? '暂无可复核录像，请重试或导入其他录像。' : '导入录像后自动分析，候选随进度逐步出现。';
  const keys = new Set(rows.map((row) => row.key));
  for (const [key, node] of queueRows) if (!keys.has(key)) { node.remove(); queueRows.delete(key); }
  if (rows.length) $('queue').querySelector('.empty')?.remove();
  if (!rows.length && !$('queue').querySelector('.empty')) {
    const empty = element('div', undefined, 'empty');
    empty.append(createFrameSignal(), element('strong', '把录像拖到这里'), element('span', '也可以点击「导入录像」，一次选择多份文件。'), element('small', '支持 MP4、MKV、WebM、MOV 等录像格式'));
    $('queue').append(empty);
  }
  for (const item of rows) {
    let row = queueRows.get(item.key);
    if (!row) {
      row = element('div', undefined, 'file'); row.dataset.sourceId = item.key;
      row.append(element('div', undefined, 'file-info'), element('div', undefined, 'file-progress'), element('div', undefined, 'row file-actions'));
      row.querySelector('.file-info').append(createFrameSignal(), element('strong'), element('small'));
      const actions = row.querySelector('.file-actions');
      for (const [action, label, run] of [
        ['review', '浏览原片', () => openReview(row.item.saved.id)],
        ['relink', '关联原录像', () => requestRelink(row.item.saved.id)],
        ['stop', '停止分析', () => queue.stop(row.item.record.id)],
        ['retry', '从头重试', () => queue.retry(row.item.record.id)],
      ]) { const node = button(label, run); node.dataset.action = action; actions.append(node); }
      queueRows.set(item.key, row); $('queue').append(row);
    }
    row.item = item;
    const { record, saved } = item;
    const identity = saved?.identity || record.file;
    const status = record?.status || saved.analysis.status;
    const completedNow = justCompleted(row.dataset.status, status);
    row.dataset.status = status;
    row.dataset.needsSource = String(!record && !!saved);
    const duration = saved?.duration || record.duration;
    const processedUntil = record?.processedUntil ?? saved?.analysis.processedUntil ?? 0;
    const count = saved?.clips.filter((clip) => !clip.provisional).length || 0;
    const info = row.querySelector('.file-info');
    const filename = info.querySelector('strong'); filename.textContent = identity.name; filename.title = identity.name;
    info.querySelector('small').textContent = `${duration ? time(duration) : '准备媒体信息'} · ${(identity.size / 1048576).toFixed(1)} MiB`;
    const details = row.querySelector('.file-progress');
    details.replaceChildren(element('span', `${statuses[status]}${!record && saved ? ' · 原录像待关联' : ''}`, 'file-status'), element('small', `已分析至 ${time(processedUntil)}${duration ? ` / ${time(duration)}` : ''} · ${count} 个确定范围`));
    const meter = element('progress', undefined, 'file-meter');
    meter.max = duration > 0 ? duration : 1;
    meter.value = Math.max(0, Math.min(processedUntil, meter.max));
    meter.setAttribute('aria-label', `${identity.name} 分析进度`);
    meter.setAttribute('aria-valuetext', duration > 0 ? `已分析 ${time(processedUntil)}，全片 ${time(duration)}` : '正在准备媒体信息');
    details.append(meter);
    if (record?.error || saved?.analysis.error) details.append(element('small', record?.error || saved.analysis.error, 'error'));
    if (record?.status === 'analyzing' && record.message) details.append(element('small', record.message));
    const actions = row.querySelector('.file-actions');
    actions.querySelector('[data-action=review]').hidden = !saved;
    actions.querySelector('[data-action=review]').textContent = count ? `复核 ${count} 段` : '浏览原片';
    actions.querySelector('[data-action=relink]').hidden = !!record || !saved;
    actions.querySelector('[data-action=stop]').hidden = !record || !['preparing', 'queued', 'analyzing'].includes(status);
    actions.querySelector('[data-action=stop]').textContent = status === 'queued' ? '移出队列' : '停止分析';
    actions.querySelector('[data-action=retry]').hidden = !record || !['stopped', 'failed', 'complete'].includes(status);
    actions.querySelector('[data-action=retry]').textContent = status === 'complete' ? '重新分析' : '从头重试';
    if (completedNow) taskFeedback(row, 'completed');
    else if (record && !presentedRecords.has(record)) taskFeedback(row, 'added');
    if (record) presentedRecords.add(record);
  }
}
function renderSources() {
  const select = $('source-select');
  const ids = view.sources.map((item) => item.id);
  if ([...select.options].map((option) => option.value).join('|') !== ids.join('|')) select.replaceChildren(...view.sources.map((item) => new Option(item.identity.name, item.id)));
  select.value = activeSourceId || '';
}
function selectRange(clip, jump = true) {
  workspace.setReview(activeSourceId, { selectedClipId: clip.id, ...selectionWindow(source().duration, clip) });
  if (jump && bindings.has(activeSourceId)) return player.seek(clip.start);
}
function renderClips(saved) {
  const clips = saved?.clips || [], keys = new Set(clips.map((clip) => clip.id));
  for (const [key, node] of clipRows) if (!keys.has(key) || node.sourceId !== saved?.id) { node.remove(); clipRows.delete(key); }
  $('clips').querySelector('.empty')?.remove();
  if (!clips.length) $('clips').append(element('p', saved?.analysis.status === 'completed' ? '当前筛选条件下没有候选，可添加手动范围。' : '候选将随分析逐步出现，也可先浏览原片或添加手动范围。', 'empty'));
  for (const clip of clips) {
    let row = clipRows.get(clip.id);
    if (!row) {
      row = element('div', undefined, 'clip'); row.dataset.clipId = clip.id; row.sourceId = saved.id;
      const selected = element('input'); selected.type = 'checkbox'; selected.className = 'clip-selected';
      selected.onchange = () => safely(() => workspace.choose(row.sourceId, row.dataset.clipId, selected.checked));
      const title = element('span', undefined, 'clip-title');
      const jump = button('定位与调整', () => selectRange(workspace.getSource(row.sourceId).clips.find((item) => item.id === row.dataset.clipId))); jump.className = 'clip-jump';
      const exclude = button('排除', () => workspace.choose(row.sourceId, row.dataset.clipId, false)); exclude.className = 'clip-exclude';
      row.append(selected, title, jump, exclude); clipRows.set(clip.id, row); $('clips').append(row);
    }
    row.querySelector('.clip-selected').checked = clip.selected;
    row.querySelector('.clip-selected').setAttribute('aria-label', `选择 ${time(clip.start)} 至 ${time(clip.end)}`);
    row.querySelector('.clip-title').textContent = `${time(clip.start)}—${time(clip.end)} · ${clip.provisional ? '后续正在补全' : clip.supplemental ? '补充建议 · 与人工决定重叠' : clip.manual ? '人工选片' : '可复核候选'}`;
    row.classList.toggle('selected-range', saved.review.selectedClipId === clip.id);
    row.classList.toggle('supplemental', clip.supplemental);
    row.querySelectorAll('input,button').forEach((node) => { node.disabled = clip.provisional; });
  }
  // Appending existing nodes would move focus; only move a row when its order changed.
  let previous = null;
  for (const clip of clips) { const row = clipRows.get(clip.id); if (previous ? previous.nextElementSibling !== row : $('clips').firstElementChild !== row) $('clips').insertBefore(row, previous ? previous.nextElementSibling : $('clips').firstElementChild); previous = row; }
}
function renderRange(saved) {
  const clip = selectedClip(), valid = !!clip && !clip.provisional;
  $('range-label').textContent = clip ? `${clip.start.toFixed(2)}—${clip.end.toFixed(2)} 秒 · ${(clip.end - clip.start).toFixed(2)} 秒` : '选择候选或添加手动范围';
  const low = Math.min(saved.review.zoomStart, clip?.start ?? saved.review.zoomStart);
  const high = Math.max(saved.review.zoomEnd, clip?.end ?? saved.review.zoomEnd);
  const track = $('range-editor').querySelector('.local-range');
  track.style.setProperty('--range-start', `${valid ? (clip.start - low) / (high - low) * 100 : 0}%`);
  track.style.setProperty('--range-end', `${valid ? (clip.end - low) / (high - low) * 100 : 0}%`);
  $('range-view-start').textContent = `${time(low)} · ${low.toFixed(2)} 秒`;
  $('range-view-end').textContent = `${time(high)} · ${high.toFixed(2)} 秒`;
  for (const key of ['start', 'end']) {
    const field = $(`range-${key}`), handle = $(`range-${key}-handle`);
    field.disabled = handle.disabled = !valid; field.max = saved.duration;
    handle.min = low; handle.max = high;
    handle.setAttribute('aria-valuetext', clip ? `${clip[key].toFixed(2)} 秒，${key === 'start' ? '起点' : '终点'}` : '未选择片段');
    $(`range-${key}-current`).disabled = !valid || (key === 'start' ? saved.review.position >= clip.end : saved.review.position <= clip.start);
    setValue(field, clip ? clip[key].toFixed(2) : ''); setValue(handle, clip ? clip[key] : saved.review.zoomStart);
    setValue($(`zoom-${key}`), saved.review[`zoom${key === 'start' ? 'Start' : 'End'}`].toFixed(2));
  }
  $('fit-selection').disabled = !valid;
}
function renderPlayer() {
  if (currentPage === 'review') selectionTimeline?.render(source());
  const saved = source(); if (!saved) return;
  const bound = bindings.has(saved.id);
  $('play-pause').disabled = !bound || loadingSource || playerState.status === 'loading' || playerState.status === 'error';
  $('play-pause').textContent = playerState.playing ? '暂停' : '播放';
  const position = playerSourceId === saved.id ? playerState.position : saved.review.position;
  $('playback-time').textContent = `${time(position)} / ${time(saved.duration)}${playerState.actual !== null && playerSourceId === saved.id ? ` · 画面 ${time(playerState.actual)}` : ''}`;
  $('player-status').textContent = !bound ? '关联原录像后加载画面' : loadingSource || ['loading', 'seeking'].includes(playerState.status) ? '正在准备该位置…' : playerState.status === 'error' ? playerState.error : '';
}
function renderReview() {
  const saved = source();
  if (!saved) return;
  const record = bindings.get(saved.id), selected = saved.clips.filter((clip) => clip.selected && !clip.provisional);
  const analyzing = ['analyzing', 'queued', 'preparing'].includes(saved.analysis.status);
  $('review-progress').textContent = `${saved.identity.name} · 已分析至 ${time(saved.analysis.processedUntil)} / ${time(saved.duration)} · ${statuses[saved.analysis.status]}${analyzing ? '，后续仍在分析' : ''}`;
  $('missing-source').hidden = !!record;
  const added = saved.clips.filter((clip) => !clip.provisional).length - (seenCandidates.get(saved.id) || 0);
  $('new-candidates').textContent = added > 0 ? `新增 ${added} 段` : '';
  $('candidate-tail').textContent = analyzing ? '当前候选已到末尾，后续仍在分析。全片可继续浏览。' : '当前候选列表已到末尾。';
  const selectionSummary = `已选 ${selected.length} 段 · 共 ${selected.reduce((total, clip) => total + clip.end - clip.start, 0).toFixed(2)} 秒${saved.hasUnexportedChanges ? ' · 有选片尚未提交导出' : ''}`;
  if ($('selection-summary').textContent !== selectionSummary) $('selection-summary').textContent = selectionSummary;
  $('export').disabled = !selected.length;
  $('export').textContent = record ? '提交选片导出 ↗' : '关联原录像以导出';
  $('recompute').disabled = !(record?.scores || record?.windowScores);
  $('reset-decisions').disabled = !saved.decisions.length;
  $('retain-all').disabled = $('exclude-all').disabled = !saved.clips.some((clip) => !clip.provisional);
  renderClips(saved); renderRange(saved); renderPlayer();
}
function renderExports() {
  const statuses = { 'awaiting-destination': '等待输出目录', queued: '排队中', running: '正在导出', completed: '成片已生成', cancelled: '已取消', failed: '导出失败', interrupted: '已中断，尚未继续执行' };
  $('export-count').textContent = `${view.batches.length} 个批次`;
  $('export-batches').querySelector('.empty-batches')?.remove();
  if (!view.batches.length && !$('export-batches').children.length) $('export-batches').append(element('p', '尚无导出任务。', 'muted empty-batches'));
  for (const batch of view.batches) {
    let row = batchRows.get(batch.id);
    if (!row) {
      row = element('article', undefined, 'export-batch'); row.dataset.batchId = batch.id;
      const title = element('strong', undefined, 'batch-title'), state = element('p', undefined, 'batch-state');
      const destination = element('p', undefined, 'batch-destination');
      const summary = element('p', undefined, 'batch-summary');
      const attention = element('p', undefined, 'batch-attention');
      const files = element('details', undefined, 'batch-files');
      files.append(element('summary', '查看成片文件'));
      const details = element('details', undefined, 'inline-details batch-details');
      details.append(element('summary', '导出详情'));
      const ranges = element('p', undefined, 'muted batch-ranges'), outcomes = element('ol', undefined, 'clip-outcomes'), outputs = element('div', undefined, 'batch-outputs');
      const cancel = button('取消本批', () => {
        if (exportQueue.getBatch(batch.id)) exportQueue.cancel(batch.id);
        else workspace.updateBatch(batch.id, { status: 'cancelled', error: '已取消本批导出。' });
      }); cancel.className = 'batch-cancel';
      const start = button('选择目录并开始', () => startExport(batch.id)); start.className = 'batch-start';
      const review = button('返回选片', () => openReview(batch.sourceId)); review.className = 'batch-review';
      const actions = element('div', undefined, 'row'); actions.append(start, cancel, review);
      details.append(ranges, outcomes);
      files.append(outputs);
      row.append(title, state, summary, destination, attention, files, details, actions); batchRows.set(batch.id, row); $('export-batches').append(row);
    }
    const live = exportQueue.getBatch(batch.id);
    const completedNow = justCompleted(row.dataset.status, batch.status);
    row.dataset.status = batch.status;
    const summary = batchSummary(batch);
    row.querySelector('.batch-summary').textContent = batch.status === 'awaiting-destination' ? `尚未开始 · ${batch.clips.length} 段选片已保留，选择输出目录后开始` : summary.text;
    const failures = (batch.clipResults || []).filter((result) => result.status === 'failed');
    const attention = row.querySelector('.batch-attention');
    attention.hidden = !failures.length;
    attention.textContent = failures.length ? `需处理：${failures.map((result) => `${time(result.start)}—${time(result.end)}${result.error ? `：${result.error}` : ''}`).join('；')}` : '';
    const files = row.querySelector('.batch-files');
    files.hidden = !(batch.outputs || []).length;
    files.querySelector('summary').textContent = `查看成片文件 · ${(batch.outputs || []).length} 个`;
    if (completedNow) taskFeedback(row, 'completed');
    row.querySelector('.batch-title').textContent = `${batch.source.name} · ${batch.clips.length} 段`;
    row.querySelector('.batch-destination').textContent = batch.destination?.mode === 'directory' ? `保存目录：${batch.destination.name}` : batch.destination?.mode === 'download' ? '保存方式：下载文件（位置由浏览器决定）' : batch.status === 'awaiting-destination' ? '保存目录：等待选择' : '保存位置：未记录';
    row.querySelector('.batch-state').textContent = `${statuses[batch.status] || batch.status}${batch.status === 'running' ? ` · ${Math.round(batch.progress * 100)}%` : ''}${live?.waitingReason ? ` · ${live.waitingReason}` : ''}${batch.error ? ` · ${batch.error}` : ''}`;
    row.querySelector('.batch-state').classList.toggle('error', batch.status === 'failed');
    row.querySelector('.batch-ranges').textContent = `提交于 ${new Date(batch.createdAt).toLocaleString()} · 固定请求范围：${batch.clips.map((clip) => `${clip.start.toFixed(2)}—${clip.end.toFixed(2)} 秒`).join('；')} · ${(batch.output.format || outputSettings.format).toUpperCase()} / ${(batch.output.videoCodec || outputSettings.videoCodec).toUpperCase()} + ${batch.output.audioCodec || outputSettings.audioCodec} · 原片默认声音`;
    row.querySelector('.batch-cancel').hidden = batch.status !== 'awaiting-destination' && (!live || !['queued', 'running'].includes(batch.status));
    row.querySelector('.batch-start').hidden = batch.status !== 'awaiting-destination';
    row.querySelector('.batch-start').disabled = startingExports.has(batch.id);
    row.querySelector('.batch-start').textContent = bindings.has(batch.sourceId) ? '选择目录并开始' : '关联原录像后继续';
    const resultKey = JSON.stringify(batch.clipResults || []);
    if (row.resultKey !== resultKey) {
      row.resultKey = resultKey;
      const labels = { 'not-started': '未开始', running: '正在导出', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断，完成情况未确认' };
      row.querySelector('.clip-outcomes').replaceChildren(...(batch.clipResults || []).map((result) => element('li', `${result.start.toFixed(2)}—${result.end.toFixed(2)} 秒 · ${labels[result.status]}${result.error ? `：${result.error}` : ''}`, 'clip-outcome')));
    }
    const outputKey = JSON.stringify(batch.outputs || []);
    if (row.outputKey !== outputKey) {
      row.outputKey = outputKey; const outputList = row.querySelector('.batch-outputs'); outputList.replaceChildren();
      for (const output of batch.outputs || []) {
        const item = element('div', undefined, 'output-item');
        if (output.url && output.available) { const link = element('a', `下载 ${output.name}`); link.href = output.url; link.download = output.name; item.append(link); }
        else item.append(element('span', `${output.name} · ${output.saved ? output.available ? '已保存至所选目录' : '此前已保存至所选目录；当前未验证文件可用性' : '下载缓存已释放，需要重新提交导出'}`));
        const metadata = element('details', undefined, 'output-details');
        metadata.append(element('summary', `${(output.bytes / 1048576).toFixed(2)} MiB · 文件详情`));
        metadata.append(element('small', `${output.reused ? '复用已有成片 · ' : ''}${(output.bytes / 1048576).toFixed(2)} MiB · 请求时长 ${output.requestedDuration.toFixed(2)} 秒${Number.isFinite(output.measuredDuration) ? ` · 读回时长 ${output.measuredDuration.toFixed(3)} 秒` : ' · 时长读回未完成'} · 实际起止未校验`, 'muted'));
        item.append(metadata);
        outputList.append(item);
      }
    }
  }
}
function renderDiagnostics() {
  const record = bindings.get(activeSourceId) || queue.records.find((item) => item.status === 'analyzing') || queue.records.at(-1);
  $('analysis-report').disabled = !record;
  $('analysis-timing').textContent = record ? JSON.stringify({ name: record.file.name, status: record.status, model: record.model, windows: record.windows, audioPolicy: record.audioPolicy, timings: record.timings }, null, 2) : '尚无分析记录。';
}
function render() {
  $('exports-section').hidden = currentPage !== 'exports';
  $('nav-exports').setAttribute('aria-current', currentPage === 'exports' ? 'page' : 'false');
  const activeExports = view.batches.filter((batch) => ['awaiting-destination', 'queued', 'running'].includes(batch.status)).length;
  $('nav-exports').textContent = `导出任务${activeExports ? ` · ${activeExports}` : ''}`;
  $('analysis-page').hidden = currentPage !== 'analysis'; $('review-page').hidden = currentPage !== 'review';
  const noticeHost = currentPage === 'analysis' ? $('analysis-notice') : currentPage === 'exports' ? $('exports-section') : $('main');
  $('status').hidden = $('status').dataset.page !== currentPage && $('status').dataset.tone !== 'error';
  if ($('status').parentElement !== noticeHost) {
    if (currentPage === 'analysis') noticeHost.append($('status'));
    else if (currentPage === 'exports') noticeHost.querySelector('.panel-heading').after($('status'));
    else noticeHost.insertBefore($('status'), $('analysis-page'));
  }
  $('nav-analysis').setAttribute('aria-current', currentPage === 'analysis' ? 'page' : 'false');
  $('nav-review').setAttribute('aria-current', currentPage === 'review' ? 'page' : 'false'); $('nav-review').disabled = !view.sources.length;
  $('files').disabled = $('import-files').disabled = !restoreReady; $('demo').disabled = !restoreReady || makingDemo;
  $('drop-zone').setAttribute('aria-disabled', String(!restoreReady || currentPage !== 'analysis'));
  if (!restoreReady || currentPage !== 'analysis') $('drop-zone').classList.remove('drag-over');
  renderSave(); renderQueue(); renderSources(); renderReview(); renderExports(); renderDiagnostics();
}

async function demo() {
  if (makingDemo) return;
  makingDemo = true; render(); note('正在加载一分钟真实交战样本…');
  try {
    const metadata = await fetch('/demo/manifest.json');
    if (!metadata.ok) throw new Error('真实样本尚未配置或所在磁盘不可用。请使用“导入录像”选择本地交战片段。');
    const { name, bytes, lastModified } = await metadata.json();
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes >= 100 * 1048576) throw new Error('演示样本需小于 100 MiB；较大录像请使用“导入录像”。');
    const response = await fetch('/demo/recording.mp4');
    if (!response.ok) throw new Error('无法读取真实样本，请确认样本所在磁盘已挂载后重试。');
    const blob = await response.blob();
    if (blob.size !== bytes) throw new Error('样本文件已变化或读取不完整，请重试。');
    await importFiles([new File([blob], name, { type: 'video/mp4', lastModified })]);
    note('已导入一分钟真实交战样本，可随时进入片段复核。');
  } finally { makingDemo = false; render(); }
}

$('export').onclick = () => safely(submitExport);
$('choose-directory').onclick = () => { chooseOutputDirectory().catch((error) => note(error.name === 'AbortError' ? '尚未取得输出目录。若未弹出目录窗口，请在桌面 Chrome 中打开本页后选择。' : errorText(error), 'error')); };
$('clear-directory').onclick = () => { directoryHandle = null; $('output-directory').textContent = '小批次生成下载链接；大批次直接写入所选目录。'; $('clear-directory').hidden = true; };
$('import-files').onclick = () => { if (restoreReady) $('files').click(); };
$('files').onchange = () => { const files = [...$('files').files]; $('files').value = ''; safely(() => importFiles(files)); };
const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
document.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  const canImport = currentPage === 'analysis' && restoreReady && $('drop-zone').contains(event.target);
  event.dataTransfer.dropEffect = canImport ? 'copy' : 'none';
  $('drop-zone').classList.toggle('drag-over', canImport);
});
$('drop-zone').addEventListener('dragleave', (event) => {
  if (!$('drop-zone').contains(event.relatedTarget)) $('drop-zone').classList.remove('drag-over');
});
document.addEventListener('drop', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  $('drop-zone').classList.remove('drag-over');
  if (currentPage !== 'analysis' || !$('drop-zone').contains(event.target)) return;
  if (!restoreReady) { note('请先恢复复核记录，再导入录像。'); return; }
  const files = Array.from(event.dataTransfer.files);
  if (files.length) safely(() => importFiles(files));
});
$('demo').onclick = () => safely(demo);
$('nav-exports').onclick = $('view-exports').onclick = showExports;
$('nav-analysis').onclick = $('back-analysis').onclick = showAnalysis;
$('nav-review').onclick = () => safely(() => openReview(activeSourceId || view.sources[0].id));
$('source-select').onchange = () => safely(() => openReview($('source-select').value));
$('relink-current').onclick = () => requestRelink(activeSourceId);
$('relink-file').onchange = () => { const file = $('relink-file').files[0]; $('relink-file').value = ''; safely(() => relink(file)); };
$('retry-save').onclick = () => safely(async () => { restoreReady = await workspace.retrySave(); rememberNavigation(); render(); });
$('play-pause').onclick = () => { if (playerState.playing) player.pause(); else player.play().catch((error) => note(errorText(error))); };
async function seek(value) {
  const saved = source(); if (!saved) return;
  const position = Math.max(0, Math.min(saved.duration, Number(value)));
  if (!Number.isFinite(position)) return;
  workspace.setReview(saved.id, { position });
  if (bindings.has(saved.id)) await player.seek(position);
}
$('next-candidate').onclick = () => safely(() => { const saved = source(); const clip = saved.clips.find((item) => !item.provisional && item.start > saved.review.position + 0.01); if (clip) return selectRange(clip); note(saved.analysis.status === 'analyzing' ? '当前候选已到末尾，后续仍在分析。' : '没有后续候选，可继续浏览原片。'); });
$('manual').onclick = () => safely(() => { const saved = source(), start = Math.min(saved.review.position, Math.max(0, saved.duration - 5)); const id = workspace.addManual(saved.id, { start, end: Math.min(saved.duration, start + 5) }); selectRange(workspace.getSource(saved.id).clips.find((clip) => clip.id === id), false); });
function trimBoundary(key, value, clamp = false) {
  const saved = source(), clip = selectedClip();
  if (!clip || clip.provisional) return;
  if (value === '' || !Number.isFinite(Number(value))) throw new Error('请输入有效的切点时间');
  let next = Number(value);
  if (clamp) {
    // Keep the opposite edge and playhead fixed, with a minimum gap of one input step.
    const minimum = key === 'start' ? 0 : Math.min(saved.duration, clip.start + 0.01);
    const maximum = key === 'start' ? Math.max(0, clip.end - 0.01) : saved.duration;
    next = Math.max(minimum, Math.min(maximum, next));
  }
  workspace.trim(saved.id, clip.id, { start: clip.start, end: clip.end, [key]: next });
  $(`range-${key}`).value = next.toFixed(2);
  $(`range-${key}-handle`).value = next;
}
for (const key of ['start', 'end']) {
  const commit = (node, clamp) => safely(() => {
    try { trimBoundary(key, node.value, clamp); }
    catch (error) { const clip = selectedClip(); node.value = clip ? clip[key] : ''; throw error; }
  });
  $(`range-${key}`).onchange = () => commit($(`range-${key}`), false);
  $(`range-${key}-handle`).onchange = () => commit($(`range-${key}-handle`), true);
  $(`range-${key}-current`).onclick = () => safely(() => trimBoundary(key, source().review.position));
  $(`zoom-${key}`).onchange = () => safely(() => workspace.setReview(activeSourceId, { [`zoom${key === 'start' ? 'Start' : 'End'}`]: Number($(`zoom-${key}`).value) }));
}
selectionTimeline = createSelectionTimeline({ MB, workspace, getSource: source, getRecord: (id) => bindings.get(id), selectRange, seek, pause: () => player.pause(), report: (error) => note(errorText(error)) });
$('fit-selection').onclick = () => safely(() => { const clip = selectedClip(); if (clip) selectRange(clip, false); });
$('recompute').onclick = () => safely(() => { const record = bindings.get(activeSourceId); queue.recompute(record.id, Number($('threshold').value)); note('已用已有分数调整筛选，人工裁边和排除决定保留。'); });
$('retain-all').onclick = () => safely(() => workspace.chooseAll(activeSourceId, true));
$('exclude-all').onclick = () => safely(() => workspace.chooseAll(activeSourceId, false));
$('reset-decisions').onclick = () => { const saved = source(); if (confirm(`重置“${saved.identity.name}”的人工选片？将清除裁边、手动范围与排除记录；已提交导出批次保留。`)) safely(() => workspace.resetDecisions(saved.id)); };
$('analysis-report').onclick = () => { const record = bindings.get(activeSourceId) || queue.records.find((item) => item.status === 'analyzing') || queue.records.at(-1); if (!record) return; const report = { date: new Date().toISOString(), source: { name: record.file.name, bytes: record.file.size, duration: record.duration }, model: record.modelInfo, audioPolicy: record.audioPolicy, status: record.status, windows: record.windows, timings: record.timings, candidates: record.candidates }; const link = element('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); link.download = 'apex-analysis-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); };
function renderOutputFormat() {
  $('output-format').textContent = `原视频分辨率与帧率的 ${outputSettings.format.toUpperCase()}（${outputSettings.videoCodec === 'avc' ? 'H.264' : outputSettings.videoCodec.toUpperCase()} + ${outputSettings.audioCodec.toUpperCase()}）`;
}
$('export-format').onchange = () => { outputSettings = exportSettings({ format: $('export-format').value }); renderOutputFormat(); };
renderOutputFormat();
$('export-budget').textContent = `${MAX_EXPORT_MEMORY_BYTES / 1048576} MiB`;
$('capabilities').textContent = `音频解码${typeof AudioDecoder !== 'undefined' ? '可用' : '不可用'} · 视频解码${typeof VideoDecoder !== 'undefined' ? '可用' : '不可用'} · 隔离上下文${crossOriginIsolated ? '可用' : '不可用'}`;
window.addEventListener('pagehide', () => { player.pause(); void workspace.flush(); });
const ready = (async () => {
  restoreReady = await workspace.restore();
  if (restoreReady) for (const saved of workspace.view().sources) workspace.mergeCandidates(saved.id);
  try { const navigation = JSON.parse(localStorage.getItem('apex-review-navigation-v1') || 'null'); if (navigation?.page === 'exports') currentPage = 'exports'; if (navigation && view.sources.some((item) => item.id === navigation.sourceId)) { activeSourceId = navigation.sourceId; if (navigation.page === 'review') currentPage = 'review'; } } catch (error) { navigationError = errorText(error); }
  render(); note(restoreReady ? '工作区已就绪' : '无法恢复已有复核记录，请重试；原记录没有被覆盖。', restoreReady ? 'quiet' : 'error');
})();
window.reviewApp = { workspace, queue, player, exportQueue, submitExport, importFiles, demo, openReview, showAnalysis, ready, bindings, get activeSourceId() { return activeSourceId; }, get page() { return currentPage; } };

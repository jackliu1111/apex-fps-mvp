import * as MB from '/assets/vendor/mediabunny.mjs';
import { createReviewWorkspace } from './review-workspace.mjs';
import { createIndexedDBStorage, identifyFile } from './review-storage.mjs';
import { createBrowserAnalysis } from './browser-analysis.mjs';
import { createSourcePlayer } from './source-player.mjs';

const $ = (id) => document.getElementById(id);
const bindings = new Map(), identified = new WeakMap(), pendingImports = new Set();
const queueRows = new Map(), clipRows = new Map(), markerRows = new Map();
const seenCandidates = new Map();
let currentPage = 'analysis', activeSourceId = null, playerSourceId = null, loadingSource = false, loadToken = 0;
let relinkSourceId = null, navigationError = null, restoreReady = false, makingDemo = false;
let view = { sources: [], batches: [], save: { status: 'saved' } }, playerState = { position: 0, playing: false, status: 'empty' };
const statuses = { preparing: '正在准备', queued: '排队中', analyzing: '分析中', complete: '分析完成', completed: '分析完成', stopped: '已停止', failed: '失败', interrupted: '已中断' };
const time = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const errorText = (error) => error?.message || String(error);
const source = () => view.sources.find((item) => item.id === activeSourceId);
const selectedClip = () => source()?.clips.find((clip) => clip.id === source().review.selectedClipId);
const note = (message) => { $('status').textContent = message; };
const safely = (action) => Promise.resolve().then(action).catch((error) => note(errorText(error)));
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
  $('save-state').textContent = `${labels[view.save.status] || '正在恢复…'}${navigationError ? '；页面位置未保存' : ''}${view.save.error ? `：${view.save.error}` : ''}`;
  $('save-state').classList.toggle('error', view.save.status === 'error' || !!navigationError);
  $('retry-save').hidden = view.save.status !== 'error' && !navigationError;
}
const workspace = createReviewWorkspace({ storage: createIndexedDBStorage(), onChange(next) { view = next; render(); } });
const queue = createBrowserAnalysis({ MB,
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
    render();
  },
});
const player = createSourcePlayer({ MB, canvas: $('source-canvas'), onState(next) {
  playerState = next;
  if (!loadingSource && playerSourceId && playerSourceId === activeSourceId) {
    const saved = workspace.getSource(playerSourceId).review.position;
    if (Math.abs(saved - next.position) >= 0.25 || (!next.playing && saved !== next.position)) workspace.setReview(playerSourceId, { position: next.position });
  }
  renderPlayer();
} });

async function importFiles(files) {
  await ready;
  if (!restoreReady) throw new Error('请先重试恢复已有记录，再导入录像');
  const incoming = [];
  for (const file of files) {
    const identity = await identifyFile(file);
    identified.set(file, identity);
    if (bindings.has(identity.id) || pendingImports.has(identity.id)) { note(`${file.name} 已在当前工作区中。`); continue; }
    pendingImports.add(identity.id); incoming.push({ file, identity });
  }
  try {
    if (incoming.length) {
      note(`正在准备 ${incoming.length} 份录像；准备就绪后自动分析。`);
      await queue.importFiles(incoming.map((entry) => entry.file), { model: $('model').value, threshold: 0.2 });
    }
  } finally { incoming.forEach(({ identity }) => pendingImports.delete(identity.id)); render(); }
}
async function openReview(id) {
  if (!view.sources.some((item) => item.id === id)) return;
  if (currentPage === 'review') player.pause();
  activeSourceId = id; currentPage = 'review'; rememberNavigation();
  seenCandidates.set(id, workspace.getSource(id).clips.filter((clip) => !clip.provisional).length);
  render();
  const record = bindings.get(id), token = ++loadToken;
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
  player.pause(); loadToken++; loadingSource = false; currentPage = 'analysis'; rememberNavigation(); render();
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
  const keys = new Set(rows.map((row) => row.key));
  for (const [key, node] of queueRows) if (!keys.has(key)) { node.remove(); queueRows.delete(key); }
  $('queue').querySelector('.empty')?.remove();
  if (!rows.length) $('queue').append(element('p', '导入一份或多份录像，开始本地分析。', 'empty'));
  for (const item of rows) {
    let row = queueRows.get(item.key);
    if (!row) {
      row = element('div', undefined, 'file'); row.dataset.sourceId = item.key;
      row.append(element('div', undefined, 'file-info'), element('div', undefined, 'file-progress'), element('div', undefined, 'row file-actions'));
      queueRows.set(item.key, row); $('queue').append(row);
    }
    const { record, saved } = item;
    const identity = saved?.identity || record.file;
    const status = record?.status || saved.analysis.status;
    const duration = saved?.duration || record.duration;
    const count = saved?.clips.filter((clip) => !clip.provisional).length || 0;
    const info = row.querySelector('.file-info');
    info.replaceChildren(element('strong', identity.name), element('small', `${duration ? time(duration) : '准备媒体信息'} · ${(identity.size / 1048576).toFixed(1)} MiB`));
    const details = row.querySelector('.file-progress');
    details.replaceChildren(element('span', `${statuses[status]}${!record && saved ? ' · 原录像待关联' : ''}`), element('small', `已分析至 ${time(record?.processedUntil ?? saved?.analysis.processedUntil)}${duration ? ` / ${time(duration)}` : ''} · ${count} 个确定范围`));
    if (record?.error || saved?.analysis.error) details.append(element('small', record?.error || saved.analysis.error, 'error'));
    if (record?.status === 'analyzing' && record.message) details.append(element('small', record.message));
    const actions = row.querySelector('.file-actions'); actions.replaceChildren();
    if (saved) { const review = button(count ? `复核 ${count} 段` : '浏览原片', () => openReview(saved.id)); review.dataset.action = 'review'; actions.append(review); }
    if (!record && saved) { const attach = button('关联原录像', () => requestRelink(saved.id)); attach.dataset.action = 'relink'; actions.append(attach); }
    if (record && ['preparing', 'queued', 'analyzing'].includes(status)) { const stop = button(status === 'queued' ? '移出队列' : '停止分析', () => queue.stop(record.id)); stop.dataset.action = 'stop'; actions.append(stop); }
    else if (record && ['stopped', 'failed', 'complete'].includes(status)) { const retry = button(status === 'complete' ? '重新分析' : '从头重试', () => queue.retry(record.id)); retry.dataset.action = 'retry'; actions.append(retry); }
  }
}
function renderSources() {
  const select = $('source-select');
  const ids = view.sources.map((item) => item.id);
  if ([...select.options].map((option) => option.value).join('|') !== ids.join('|')) select.replaceChildren(...view.sources.map((item) => new Option(item.identity.name, item.id)));
  select.value = activeSourceId || '';
}
function selectRange(clip, jump = true) {
  workspace.setReview(activeSourceId, { selectedClipId: clip.id, zoomStart: Math.max(0, clip.start - 5), zoomEnd: Math.min(source().duration, clip.end + 5) });
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
function renderMarkers(saved) {
  const clips = saved?.clips || [], keys = new Set(clips.map((clip) => clip.id));
  for (const [id, node] of markerRows) if (!keys.has(id)) { node.remove(); markerRows.delete(id); }
  for (const clip of clips) {
    let marker = markerRows.get(clip.id);
    if (!marker) { marker = button('', () => selectRange(source().clips.find((item) => item.id === marker.dataset.clipId))); marker.dataset.clipId = clip.id; markerRows.set(clip.id, marker); $('overview-markers').append(marker); }
    marker.className = `marker${clip.provisional ? ' provisional' : ''}${clip.supplemental ? ' supplemental' : ''}${clip.id === saved.review.selectedClipId ? ' active' : ''}`;
    marker.style.left = `${clip.start / saved.duration * 100}%`; marker.style.width = `${(clip.end - clip.start) / saved.duration * 100}%`;
    marker.title = `${time(clip.start)}—${time(clip.end)}`; marker.setAttribute('aria-label', `定位候选 ${marker.title}`); marker.disabled = clip.provisional;
  }
}
function renderRange(saved) {
  const clip = selectedClip(), valid = !!clip && !clip.provisional;
  $('range-label').textContent = clip ? `${clip.start.toFixed(2)}—${clip.end.toFixed(2)} 秒 · ${(clip.end - clip.start).toFixed(2)} 秒` : '选择候选或添加手动范围';
  for (const key of ['start', 'end']) {
    const field = $(`range-${key}`), handle = $(`range-${key}-handle`);
    field.disabled = handle.disabled = !valid; field.max = saved.duration;
    handle.min = saved.review.zoomStart; handle.max = saved.review.zoomEnd;
    setValue(field, clip ? clip[key].toFixed(2) : ''); setValue(handle, clip ? clip[key] : saved.review.zoomStart);
    setValue($(`zoom-${key}`), saved.review[`zoom${key === 'start' ? 'Start' : 'End'}`].toFixed(2));
  }
  $('fit-selection').disabled = !valid;
}
function renderPlayer() {
  const saved = source(); if (!saved) return;
  const bound = bindings.has(saved.id);
  $('play-pause').disabled = !bound || loadingSource || playerState.status === 'loading' || playerState.status === 'error';
  $('play-pause').textContent = playerState.playing ? '暂停' : '播放';
  const position = playerSourceId === saved.id ? playerState.position : saved.review.position;
  setValue($('overview'), position); setValue($('seek-time'), position.toFixed(2));
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
  $('overview').max = saved.duration; $('seek-time').max = saved.duration;
  $('overview-label').textContent = `候选 ${saved.clips.filter((clip) => !clip.provisional).length} 段 · 全片 ${time(saved.duration)}`;
  $('duration-label').textContent = time(saved.duration);
  const added = saved.clips.filter((clip) => !clip.provisional).length - (seenCandidates.get(saved.id) || 0);
  $('new-candidates').textContent = added > 0 ? `新增 ${added} 段` : '';
  $('candidate-tail').textContent = analyzing ? '当前候选已到末尾，后续仍在分析。全片可继续浏览。' : '当前候选列表已到末尾。';
  $('selection-summary').textContent = `已选 ${selected.length} 段 · 共 ${selected.reduce((total, clip) => total + clip.end - clip.start, 0).toFixed(2)} 秒${saved.hasUnexportedChanges ? ' · 有选片尚未提交导出' : ''}`;
  $('recompute').disabled = !(record?.scores || record?.windowScores);
  $('reset-decisions').disabled = !saved.decisions.length;
  renderClips(saved); renderMarkers(saved); renderRange(saved); renderPlayer();
}
function renderDiagnostics() {
  const record = bindings.get(activeSourceId) || queue.records.find((item) => item.status === 'analyzing') || queue.records.at(-1);
  $('analysis-report').disabled = !record;
  $('analysis-timing').textContent = record ? JSON.stringify({ name: record.file.name, status: record.status, model: record.model, windows: record.windows, audioPolicy: record.audioPolicy, timings: record.timings }, null, 2) : '尚无分析记录。';
}
function render() {
  $('analysis-page').hidden = currentPage !== 'analysis'; $('review-page').hidden = currentPage !== 'review';
  $('nav-analysis').setAttribute('aria-current', currentPage === 'analysis' ? 'page' : 'false');
  $('nav-review').setAttribute('aria-current', currentPage === 'review' ? 'page' : 'false'); $('nav-review').disabled = !view.sources.length;
  $('files').disabled = !restoreReady; $('demo').disabled = !restoreReady || makingDemo;
  renderSave(); renderQueue(); renderSources(); renderReview(); renderDiagnostics();
}

async function demo() {
  if (makingDemo) return;
  makingDemo = true; render(); note('正在生成双音轨合成样本…');
  try {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const ctx = canvas.getContext('2d');
    const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
    const video = new MB.CanvasSource(canvas, { codec: 'vp8', bitrate: 600000 });
    const audio = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 }), second = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
    output.addVideoTrack(video, { frameRate: 12 }); output.addAudioTrack(audio, { name: '合成脉冲' }); output.addAudioTrack(second, { name: '440 Hz 对照' }); await output.start();
    const pulse = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 }), tone = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
    let seed = 12345;
    for (let i = 0; i < pulse.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; const t = i / 48000; pulse.getChannelData(0)[i] = t % 2 < 0.12 ? ((seed >>> 0) / 4294967296 - 0.5) * 0.6 * Math.exp(-30 * (t % 2)) : 0; tone.getChannelData(0)[i] = 0.08 * Math.sin(2 * Math.PI * 440 * t); }
    await audio.add(pulse); await second.add(tone);
    for (let i = 0; i < 144; i++) { ctx.fillStyle = '#101b22'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#afedc9'; ctx.fillRect(30 + (i * 3) % 500, 240, 80, 10); ctx.font = '24px sans-serif'; ctx.fillText('BROWSER / SYNTHETIC SAMPLE', 30, 65); ctx.font = '64px monospace'; ctx.fillText(`${(i / 12).toFixed(2)} s`, 30, 165); await video.add(i / 12, 1 / 12); }
    video.close(); audio.close(); second.close(); await output.finalize();
    await importFiles([new File([output.target.buffer], 'browser-synthetic.webm', { type: 'video/webm', lastModified: 1793059200000 })]);
  } finally { makingDemo = false; render(); }
}

$('files').onchange = () => { const files = [...$('files').files]; $('files').value = ''; safely(() => importFiles(files)); };
$('demo').onclick = () => safely(demo);
$('nav-analysis').onclick = $('back-analysis').onclick = showAnalysis;
$('nav-review').onclick = () => safely(() => openReview(activeSourceId || view.sources[0].id));
$('source-select').onchange = () => safely(() => openReview($('source-select').value));
$('relink-current').onclick = () => requestRelink(activeSourceId);
$('relink-file').onchange = () => { const file = $('relink-file').files[0]; $('relink-file').value = ''; safely(() => relink(file)); };
$('retry-save').onclick = () => safely(async () => { restoreReady = await workspace.retrySave(); rememberNavigation(); render(); });
$('play-pause').onclick = () => { if (playerState.playing) player.pause(); else player.play().catch((error) => note(errorText(error))); };
$('overview').oninput = () => { $('overview-label').textContent = `定位目标 ${time(Number($('overview').value))} · 松手后准备画面`; };
async function seek(value) {
  const saved = source(); if (!saved) return;
  const position = Math.max(0, Math.min(saved.duration, Number(value)));
  if (!Number.isFinite(position)) return;
  workspace.setReview(saved.id, { position });
  if (bindings.has(saved.id)) await player.seek(position);
}
$('overview').onchange = () => safely(() => seek($('overview').value));
$('seek-time').onchange = () => safely(() => seek($('seek-time').value));
$('next-candidate').onclick = () => safely(() => { const saved = source(); const clip = saved.clips.find((item) => !item.provisional && item.start > saved.review.position + 0.01); if (clip) return selectRange(clip); note(saved.analysis.status === 'analyzing' ? '当前候选已到末尾，后续仍在分析。' : '没有后续候选，可继续浏览原片。'); });
$('manual').onclick = () => safely(() => { const saved = source(), start = Math.min(saved.review.position, Math.max(0, saved.duration - 5)); const id = workspace.addManual(saved.id, { start, end: Math.min(saved.duration, start + 5) }); selectRange(workspace.getSource(saved.id).clips.find((clip) => clip.id === id), false); });
for (const key of ['start', 'end']) {
  const commit = (node) => safely(() => { const clip = selectedClip(); if (!clip) return; workspace.trim(activeSourceId, clip.id, { start: clip.start, end: clip.end, [key]: Number(node.value) }); });
  $(`range-${key}`).onchange = () => commit($(`range-${key}`));
  $(`range-${key}-handle`).oninput = () => commit($(`range-${key}-handle`));
  $(`zoom-${key}`).onchange = () => safely(() => workspace.setReview(activeSourceId, { [`zoom${key === 'start' ? 'Start' : 'End'}`]: Number($(`zoom-${key}`).value) }));
}
$('fit-selection').onclick = () => safely(() => { const clip = selectedClip(); if (clip) selectRange(clip, false); });
$('recompute').onclick = () => safely(() => { const record = bindings.get(activeSourceId); queue.recompute(record.id, Number($('threshold').value)); note('已用已有分数调整筛选，人工裁边和排除决定保留。'); });
$('reset-decisions').onclick = () => { const saved = source(); if (confirm(`重置“${saved.identity.name}”的人工选片？将清除裁边、手动范围与排除记录；已提交导出批次保留。`)) safely(() => workspace.resetDecisions(saved.id)); };
$('analysis-report').onclick = () => { const record = bindings.get(activeSourceId) || queue.records.find((item) => item.status === 'analyzing') || queue.records.at(-1); if (!record) return; const report = { date: new Date().toISOString(), source: { name: record.file.name, bytes: record.file.size, duration: record.duration }, model: record.modelInfo, audioPolicy: record.audioPolicy, status: record.status, windows: record.windows, timings: record.timings, candidates: record.candidates }; const link = element('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); link.download = 'apex-analysis-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); };
$('capabilities').textContent = `音频解码 ${typeof AudioDecoder !== 'undefined' ? '✓' : '✗'} · 视频解码 ${typeof VideoDecoder !== 'undefined' ? '✓' : '✗'} · 隔离上下文 ${crossOriginIsolated ? '✓' : '✗'}`;
window.addEventListener('pagehide', () => { player.pause(); void workspace.flush(); });
const ready = (async () => {
  restoreReady = await workspace.restore();
  try { const navigation = JSON.parse(localStorage.getItem('apex-review-navigation-v1') || 'null'); if (navigation && view.sources.some((item) => item.id === navigation.sourceId)) { activeSourceId = navigation.sourceId; if (navigation.page === 'review') currentPage = 'review'; } } catch (error) { navigationError = errorText(error); }
  render(); note(restoreReady ? '就绪。导入后自动分析，已有选片记录已恢复。' : '无法恢复已有复核记录，请重试；原记录没有被覆盖。');
})();
window.reviewApp = { workspace, queue, player, importFiles, demo, openReview, showAnalysis, ready, bindings, get activeSourceId() { return activeSourceId; }, get page() { return currentPage; } };

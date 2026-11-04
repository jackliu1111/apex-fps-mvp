import { preview, mountReviewPreview, renderReviewPreview } from './review-preview.mjs';
import { createSelectionTimeline, selectionWindow } from './selection-timeline.mjs';
import { batchSummary, justCompleted, taskFeedback, createFrameSignal } from './task-feedback.mjs';
import * as MB from '/assets/vendor/mediabunny.mjs';
import { createReviewWorkspace } from './review-workspace.mjs';
import { identifyFile } from './media-identity.mjs';
import { createBrowserAnalysis } from './browser-analysis.mjs';
import { createSourcePlayer } from './source-player.mjs';
import { createExportQueue } from './export-queue.mjs';
import { createBrowserConverter } from './browser-export.mjs';
import { DEFAULT_EXPORT_SETTINGS, sourceExportSettings, exportSettings } from './export-policy.mjs';
import { t, getLang, setLang, onLanguageChange, applyTranslations } from './i18n.js';

const $ = (id) => document.getElementById(id);
const bindings = new Map(), identified = new WeakMap(), pendingImports = new Set();
const queueRows = new Map(), clipRows = new Map(), batchRows = new Map();
const seenCandidates = new Map();
const presentedRecords = new WeakSet();
const startingExports = new Set();
let currentPage = 'analysis', activeSourceId = null, playerSourceId = null, loadingSource = false, loadToken = 0;
let makingDemo = false, directoryHandle = null, exportQueue, selectionTimeline;
let view = { sources: [], batches: [] }, playerState = { position: 0, playing: false, status: 'empty' };

const getStatuses = () => ({
  preparing: t('status_preparing'),
  queued: t('status_queued'),
  analyzing: t('status_analyzing'),
  complete: t('status_completed'),
  completed: t('status_completed'),
  stopped: t('status_stopped'),
  failed: t('status_failed'),
  interrupted: t('status_interrupted')
});

const time = (seconds = 0) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const errorText = (error) => error?.message || String(error);
const source = () => view.sources.find((item) => item.id === activeSourceId);
const selectedClip = () => source()?.clips.find((clip) => clip.id === source().review.selectedClipId && !clip.excluded);
let noteTimer = null;
const note = (message, tone = 'info') => {
  $('status').textContent = message;
  $('status').dataset.tone = tone;
  $('status').dataset.page = currentPage;
  $('status').hidden = false;
  clearTimeout(noteTimer);
  if (currentPage === 'review') {
    noteTimer = setTimeout(() => {
      if (currentPage === 'review') $('status').hidden = true;
    }, tone === 'error' ? 6000 : 3500);
  }
};
const safely = (action) => Promise.resolve().then(action).catch((error) => note(errorText(error), 'error'));
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, action) => { const node = element('button', text); node.onclick = () => safely(action); return node; };
const setValue = (node, value) => { if (document.activeElement !== node) node.value = value; };
const workspace = createReviewWorkspace({ onChange(next) { view = next; render(); } });
const queue = createBrowserAnalysis({ MB,
  onWaveform(record, waveform) { if (record.sourceId) workspace.updateWaveform(record.sourceId, waveform); },
  async onPrepared(record) {
    const identity = identified.get(record.file) || await identifyFile(record.file);
    record.sourceId = workspace.addSource({ ...identity, duration: record.duration });
    bindings.set(record.sourceId, record);
  },
  onCandidates(record, candidates) { if (record.sourceId) workspace.publishCandidates(record.sourceId, candidates); },
  onChange(record) {
    let workspaceUpdated = false;
    if (record.sourceId) {
      const next = { status: record.status === 'complete' ? 'completed' : record.status, processedUntil: Math.min(record.duration, Math.max(0, record.processedUntil || 0)), error: record.error || null };
      const prior = workspace.getSource(record.sourceId).analysis;
      if (Object.keys(next).some((key) => next[key] !== prior[key])) {
        workspace.updateAnalysis(record.sourceId, next);
        workspaceUpdated = true;
      }
    }
    if (!workspaceUpdated) render();
    exportQueue?.pump();
  },
});
let idleTimer = null;
function resetPlayerIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  const frame = $('player-frame');
  if (!frame) return;
  frame.dataset.idle = 'false';
  if (playerState.playing) {
    idleTimer = setTimeout(() => {
      if (playerState.playing) frame.dataset.idle = 'true';
    }, 2500);
  }
}
const player = createSourcePlayer({ MB, canvas: $('source-canvas'), onState(next) {
  playerState = next;
  const frame = $('player-frame');
  if (frame) {
    frame.dataset.playing = String(!!next.playing);
    if (!next.playing) {
      if (idleTimer) clearTimeout(idleTimer);
      frame.dataset.idle = 'false';
    } else {
      resetPlayerIdle();
    }
  }
  if (!loadingSource && playerSourceId && playerSourceId === activeSourceId) {
    const saved = workspace.getSource(playerSourceId).review.position;
    if (Math.abs(saved - next.position) >= 0.25 || (!next.playing && saved !== next.position)) workspace.setReview(playerSourceId, { position: next.position });
  }
  renderPlayer();
} });

let outputSettings = DEFAULT_EXPORT_SETTINGS;
exportQueue = createExportQueue({
  convert: createBrowserConverter({ MB }),
  canRun: () => !queue.records.some((record) => ['preparing', 'queued', 'analyzing'].includes(record.status)),
  onChange({ id, status, outputs, error, progress, clipResults, destination }) { workspace.updateBatch(id, { status, outputs, error, progress, clipResults, destination }); },
});
function directoryCapabilityError() {
  if (!window.isSecureContext) return t('err_dir_secure');
  if (typeof window.showDirectoryPicker !== 'function') return t('err_dir_support');
  return null;
}
async function chooseOutputDirectory() {
  const unavailable = directoryCapabilityError();
  if (unavailable) throw new Error(unavailable);
  const selected = await window.showDirectoryPicker({ id: 'apex-clip-exports', mode: 'readwrite' });
  let permission = await selected.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') permission = await selected.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error(t('err_dir_permission'));
  directoryHandle = selected;
  $('output-directory').textContent = t('output_dir_next', { name: directoryHandle.name });
  $('choose-directory').textContent = t('change_directory');
  return selected;
}
async function submitExport() {
  const saved = source(), record = bindings.get(activeSourceId);
  if (!saved) throw new Error(t('err_select_video_first'));
  if (!record) throw new Error(t('err_no_source_record'));
  const clips = saved.clips.filter((clip) => clip.selected && !clip.provisional);
  if (!clips.length) throw new Error(t('err_no_clips_selected'));
  const batch = workspace.submitBatch(saved.id, { audio: { trackIndex: record.outputAudioTrackIndex, policy: 'source-primary' }, output: { ...sourceExportSettings(outputSettings, record.video), model: record.model } });
  return startExport(batch.id);
}
async function startExport(id) {
  const live = exportQueue.getBatch(id);
  if (startingExports.has(id) || (live && live.status !== 'awaiting-destination')) return;
  const batch = view.batches.find((item) => item.id === id), record = bindings.get(batch?.sourceId);
  if (!record) throw new Error(t('err_no_batch_source'));
  startingExports.add(id);
  let destination = directoryHandle;
  try {
    workspace.updateBatch(id, { status: 'awaiting-destination', error: null });
    showExports();
    const unavailable = directoryCapabilityError();
    if (unavailable) throw new Error(unavailable);
    // The picker is only invoked from this user action, never from queue execution.
    if (!destination || batch.status === 'awaiting-destination') destination = await chooseOutputDirectory();
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    if (await destination.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error(t('err_dir_permission_lost'));
    }
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    if (live) exportQueue.resume(id, destination);
    else exportQueue.enqueue(batch, { file: record.file, origin: record.origin, directoryHandle: destination });
  } catch (error) {
    if (view.batches.find((item) => item.id === id)?.status === 'cancelled') return;
    const message = error.name === 'AbortError' ? t('err_dir_aborted') : errorText(error);
    workspace.updateBatch(id, { status: 'awaiting-destination', error: message });
    return;
  } finally { startingExports.delete(id); renderExports(); }
  note(t('note_export_submitted'));
}

async function importFiles(files) {
  await ready;
  const options = { model: $('model').value, threshold: 0.2 };
  const failures = [];
  const importMessage = t('note_prep_files', { count: files.length });
  note(importMessage);
  await Promise.all([...files].map(async (file) => {
    let reservedId;
    try {
      const identity = await identifyFile(file);
      identified.set(file, identity);
      if (bindings.has(identity.id) || pendingImports.has(identity.id)) { note(t('note_file_exists', { name: file.name })); return; }
      reservedId = identity.id; pendingImports.add(reservedId);
      await queue.importFiles([file], options);
    } catch (error) {
      failures.push(`${file.name}: ${errorText(error)}`);
    } finally {
      if (reservedId) pendingImports.delete(reservedId);
      render();
    }
  }));
  if (failures.length) note(t('note_import_failed', { list: failures.join('; ') }), 'error');
  else if ($('status').textContent === importMessage) note(t('note_files_added'), 'quiet');
}
async function openReview(id) {
  if (!view.sources.some((item) => item.id === id)) return;
  if (currentPage === 'review') player.pause();
  activeSourceId = id; currentPage = 'review';
  seenCandidates.set(id, workspace.getSource(id).clips.filter((clip) => !clip.provisional && !clip.excluded).length);
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
  player.pause(); loadToken++; loadingSource = false; currentPage = 'analysis'; selectionTimeline?.suspend(); render();
}
function showExports() {
  player.pause(); loadToken++; loadingSource = false; currentPage = 'exports'; selectionTimeline?.suspend(); render();
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
  $('queue-count').textContent = t('queue_count', { count: rows.length });
  $('queue-summary').textContent = analyzing || waiting
    ? t('queue_summary_analyzing', { analyzing, waiting })
    : view.sources.length ? t('queue_summary_idle')
      : rows.length ? t('queue_summary_failed') : t('queue_summary_empty');
  const keys = new Set(rows.map((row) => row.key));
  for (const [key, node] of queueRows) if (!keys.has(key)) { node.remove(); queueRows.delete(key); }
  if (rows.length) $('queue').querySelector('.empty')?.remove();
  if (!rows.length && !$('queue').querySelector('.empty')) {
    const empty = element('div', undefined, 'empty');
    empty.append(createFrameSignal(), element('strong', t('empty_drop_title')), element('span', t('empty_drop_desc')), element('small', t('empty_drop_types')));
    $('queue').append(empty);
  }
  const statusDict = getStatuses();
  for (const item of rows) {
    let row = queueRows.get(item.key);
    if (!row) {
      row = element('div', undefined, 'file'); row.dataset.sourceId = item.key;
      const fileInfo = element('div', undefined, 'file-info');
      const filename = element('strong');
      const fileMeta = element('small');
      fileInfo.append(createFrameSignal(), filename, fileMeta);

      const fileProgress = element('div', undefined, 'file-progress');
      const statusSpan = element('span', undefined, 'file-status');
      const countSmall = element('small');
      const meter = element('progress', undefined, 'file-meter');
      const errorSmall = element('small', undefined, 'error');
      const messageSmall = element('small');
      fileProgress.append(statusSpan, countSmall, meter);

      const actions = element('div', undefined, 'row file-actions');
      const reviewBtn = button(t('action_browse_source'), () => openReview(row.item.saved.id)); reviewBtn.dataset.action = 'review';
      const stopBtn = button(t('action_stop'), () => queue.stop(row.item.record.id)); stopBtn.dataset.action = 'stop';
      const retryBtn = button(t('action_retry'), () => queue.retry(row.item.record.id)); retryBtn.dataset.action = 'retry';
      actions.append(reviewBtn, stopBtn, retryBtn);

      row.append(fileInfo, fileProgress, actions);
      row.refs = { filename, fileMeta, fileProgress, statusSpan, countSmall, meter, errorSmall, messageSmall, reviewBtn, stopBtn, retryBtn };
      queueRows.set(item.key, row); $('queue').append(row);
    }
    row.item = item;
    const { record, saved } = item;
    const identity = saved?.identity || record.file;
    const status = record?.status || saved.analysis.status;
    const completedNow = justCompleted(row.dataset.status, status);
    row.dataset.status = status;
    const duration = saved?.duration || record.duration;
    const processedUntil = record?.processedUntil ?? saved?.analysis.processedUntil ?? 0;
    const count = saved?.clips.filter((clip) => !clip.provisional && !clip.excluded).length || 0;

    const { filename, fileMeta, fileProgress, statusSpan, countSmall, meter, errorSmall, messageSmall, reviewBtn, stopBtn, retryBtn } = row.refs;
    if (filename.textContent !== identity.name) {
      filename.textContent = identity.name;
      filename.title = identity.name;
    }
    const metaText = `${duration ? time(duration) : t('status_preparing')} · ${(identity.size / 1048576).toFixed(1)} MiB`;
    if (fileMeta.textContent !== metaText) fileMeta.textContent = metaText;

    const statusText = `${statusDict[status] || status}`;
    if (statusSpan.textContent !== statusText) statusSpan.textContent = statusText;

    const countText = `${t('source_analyzed_until', { time: time(processedUntil) })}${duration ? ` / ${time(duration)}` : ''} · ${t('source_clips_count', { count })}`;
    if (countSmall.textContent !== countText) countSmall.textContent = countText;

    const meterMax = duration > 0 ? duration : 1;
    if (meter.max !== meterMax) meter.max = meterMax;
    const meterVal = Math.max(0, Math.min(processedUntil, meterMax));
    if (meter.value !== meterVal) meter.value = meterVal;
    meter.setAttribute('aria-label', `${identity.name} ${t('status_analyzing')}`);
    meter.setAttribute('aria-valuetext', duration > 0 ? `${t('source_analyzed_until', { time: time(processedUntil) })}, ${time(duration)}` : t('status_preparing'));

    const err = record?.error || saved?.analysis.error;
    if (err) {
      if (!errorSmall.isConnected) fileProgress.append(errorSmall);
      if (errorSmall.textContent !== err) errorSmall.textContent = err;
    } else if (errorSmall.isConnected) {
      errorSmall.remove();
    }

    if (record?.status === 'analyzing' && record.message) {
      if (!messageSmall.isConnected) fileProgress.append(messageSmall);
      if (messageSmall.textContent !== record.message) messageSmall.textContent = record.message;
    } else if (messageSmall.isConnected) {
      messageSmall.remove();
    }

    reviewBtn.hidden = !saved;
    const reviewText = count ? t('action_review_count', { count }) : t('action_browse_source');
    if (reviewBtn.textContent !== reviewText) reviewBtn.textContent = reviewText;

    stopBtn.hidden = !record || !['preparing', 'queued', 'analyzing'].includes(status);
    const stopText = status === 'queued' ? t('action_remove_queue') : t('action_stop');
    if (stopBtn.textContent !== stopText) stopBtn.textContent = stopText;

    retryBtn.hidden = !record || !['stopped', 'failed', 'complete'].includes(status);
    const retryText = status === 'complete' ? t('action_reanalyze') : t('action_retry');
    if (retryBtn.textContent !== retryText) retryBtn.textContent = retryText;

    if (completedNow) taskFeedback(row, 'completed');
    else if (record && !presentedRecords.has(record)) taskFeedback(row, 'added');
    if (record) presentedRecords.add(record);
  }
}
function renderSources() {
  const select = $('source-select');
  const ids = view.sources.map((item) => item.id);
  if ([...select.options].map((option) => option.value).join('|') !== ids.join('|')) {
    select.replaceChildren(...view.sources.map((item) => new Option(item.identity.name, item.id)));
  }
  if (activeSourceId && !ids.includes(activeSourceId)) {
    activeSourceId = ids[0] || null;
  }
  select.value = activeSourceId || '';
}
function selectRange(clip, jump = true) {
  const shouldMove = jump && (bindings.has(activeSourceId) || preview);
  workspace.setReview(activeSourceId, {
    selectedClipId: clip.id,
    ...selectionWindow(source().duration, clip),
    ...(shouldMove ? { position: clip.start } : {}),
  });
  if (jump && bindings.has(activeSourceId)) return player.seek(clip.start);
}
function renderClips(saved) {
  let number = 0;
  const clipNumbers = new Map();
  for (const item of (saved?.clips || [])) {
    if (!item.excluded) clipNumbers.set(item.id, ++number);
  }
  const clips = (saved?.clips || []).filter((clip) => !clip.excluded || $('show-excluded').checked), keys = new Set(clips.map((clip) => clip.id));
  for (const [key, node] of clipRows) if (!keys.has(key) || node.sourceId !== saved?.id) {
    if (node.contains(document.activeElement)) $('prediction-workspace').focus({ preventScroll: true });
    node.remove(); clipRows.delete(key);
  }
  $('clips').querySelector('.empty')?.remove();
  if (!clips.length) $('clips').append(element('p', saved?.clips.some((clip) => clip.excluded) ? t('clip_empty_excluded') : saved?.analysis.status === 'completed' ? t('clip_empty_filtered') : t('clip_empty_analyzing'), 'empty'));
  for (const clip of clips) {
    let row = clipRows.get(clip.id);
    if (!row) {
      row = element('div', undefined, 'clip'); row.dataset.clipId = clip.id; row.sourceId = saved.id;
      const selected = element('input'); selected.type = 'checkbox'; selected.className = 'clip-selected';
      selected.onchange = () => safely(() => workspace.choose(row.sourceId, row.dataset.clipId, selected.checked));
      const title = element('span', undefined, 'clip-title');
      const badge = element('span', undefined, 'clip-badge');
      const text = element('span', undefined, 'clip-text');
      title.append(badge, text);
      const jump = button(t('clip_locate_btn'), () => selectRange(workspace.getSource(row.sourceId).clips.find((item) => item.id === row.dataset.clipId))); jump.className = 'clip-jump';
      const exclude = button(t('clip_exclude_btn'), () => {
        const clip = workspace.getSource(row.sourceId).clips.find((item) => item.id === row.dataset.clipId);
        return clip.excluded ? workspace.restoreExcluded(row.sourceId, clip.id) : workspace.exclude(row.sourceId, clip.id);
      }); exclude.className = 'clip-exclude';
      row.append(selected, title, jump, exclude); clipRows.set(clip.id, row); $('clips').append(row);
    }
    row.querySelector('.clip-selected').checked = clip.selected;
    row.querySelector('.clip-selected').setAttribute('aria-label', `${time(clip.start)} — ${time(clip.end)}`);
    const badgeNumber = clipNumbers.get(clip.id);
    const badgeText = clip.excluded ? t('clip_excluded_badge') : (badgeNumber ? `[${badgeNumber}]` : '');
    let badge = row.querySelector('.clip-badge');
    if (!badge) {
      badge = element('span', undefined, 'clip-badge');
      row.querySelector('.clip-title').prepend(badge);
    }
    badge.textContent = badgeText;
    let text = row.querySelector('.clip-text');
    if (!text) {
      text = element('span', undefined, 'clip-text');
      row.querySelector('.clip-title').append(text);
    }
    const clipType = clip.excluded ? t('clip_excluded_desc') : clip.provisional ? t('clip_provisional_desc') : clip.supplemental ? t('clip_supplemental_desc') : clip.manual ? t('clip_manual_desc') : t('clip_candidate_desc');
    text.textContent = ` ${time(clip.start)}—${time(clip.end)} · ${clipType}`;
    row.classList.toggle('selected-range', saved.review.selectedClipId === clip.id);
    row.querySelector('.clip-jump').textContent = saved.review.selectedClipId === clip.id ? t('clip_editing_btn') : t('clip_locate_btn');
    row.classList.toggle('supplemental', clip.supplemental);
    row.classList.toggle('unselected', !clip.selected && !clip.excluded);
    row.classList.toggle('excluded', clip.excluded);
    row.querySelector('.clip-exclude').textContent = clip.excluded ? t('clip_restore_btn') : t('clip_exclude_btn');
    row.querySelector('.clip-exclude').disabled = clip.provisional;
    row.querySelector('.clip-selected').disabled = clip.provisional || clip.excluded;
    row.querySelector('.clip-jump').disabled = clip.provisional || clip.excluded;
  }
  // Appending existing nodes would move focus; only move a row when its order changed.
  let previous = null;
  for (const clip of clips) { const row = clipRows.get(clip.id); if (previous ? previous.nextElementSibling !== row : $('clips').firstElementChild !== row) $('clips').insertBefore(row, previous ? previous.nextElementSibling : $('clips').firstElementChild); previous = row; }
}
function renderRange(saved) {
  const clip = selectedClip(), valid = !!clip && !clip.provisional;
  $('range-label').textContent = clip ? `${clip.start.toFixed(2)}—${clip.end.toFixed(2)} s · ${(clip.end - clip.start).toFixed(2)} s` : t('range_select_hint');
  for (const key of ['start', 'end']) {
    const field = $(`range-${key}`);
    field.disabled = !valid; field.max = saved.duration;
    $(`range-${key}-current`).disabled = !valid || (key === 'start' ? saved.review.position >= clip.end : saved.review.position <= clip.start);
    setValue(field, clip ? clip[key].toFixed(2) : '');
    setValue($(`zoom-${key}`), saved.review[`zoom${key === 'start' ? 'Start' : 'End'}`].toFixed(2));
  }
  $('fit-selection').disabled = !valid;
}
function renderPlayer() {
  if (currentPage === 'review') selectionTimeline?.render(source());
  const saved = source(); if (!saved) return;
  const bound = bindings.has(saved.id);
  $('play-pause').disabled = !bound || loadingSource || playerState.status === 'loading' || playerState.status === 'error';
  $('play-pause').textContent = playerState.playing ? t('pause') : t('play');
  const clip = selectedClip();
  $('play-selection').disabled = $('play-pause').disabled || !clip || clip.provisional || !(clip.end > clip.start);
  $('play-selection').dataset.playing = String(!!playerState.playRange && playerState.playing);
  const volume = playerState.volume ?? 0.5, muted = !!playerState.muted;
  const volumeText = `${Math.round(volume * 100)}%`;
  setValue($('player-volume'), volume);
  $('player-volume').setAttribute('aria-valuetext', `${volumeText}${muted ? ` (${t('volume_muted')})` : ''}`);
  $('player-volume-value').textContent = muted ? t('volume_muted') : volumeText;
  $('player-mute').setAttribute('aria-pressed', String(muted));
  $('player-mute').dataset.silent = String(muted || volume === 0);
  $('player-mute').title = muted ? t('unmute_title') : t('mute_title');
  $('player-mute').setAttribute('aria-label', $('player-mute').title);
  const position = playerSourceId === saved.id ? playerState.position : saved.review.position;
  $('playback-time').textContent = `${time(position)} / ${time(saved.duration)}${playerState.actual !== null && playerSourceId === saved.id ? ` · ${t('frame_text')} ${time(playerState.actual)}` : ''}`;
  const stable = saved.clips.filter((item) => !item.provisional && !item.excluded);
  $('prev-candidate').disabled = !stable.some((item) => item.start < position - 0.01);
  $('next-candidate').disabled = !stable.some((item) => item.start > position + 0.01) && saved.analysis.status !== 'analyzing';
  const fsBtn = $('player-fullscreen');
  if (fsBtn) {
    fsBtn.disabled = !bound || loadingSource || playerState.status === 'error';
    const isFull = document.fullscreenElement === $('player-frame') || document.webkitFullscreenElement === $('player-frame');
    fsBtn.title = isFull ? t('exit_fullscreen_title') : t('fullscreen_title');
    fsBtn.setAttribute('aria-label', fsBtn.title);
  }
  $('player-status').textContent = !bound ? t('player_select_hint') : loadingSource || ['loading', 'seeking'].includes(playerState.status) ? (getLang() === 'zh' ? '正在准备该位置…' : 'Preparing position...') : playerState.status === 'error' ? playerState.error : '';
  renderReviewPreview(saved, bound);
}
function renderReview() {
  const saved = source();
  if (!saved) return;
  const record = bindings.get(saved.id), selected = saved.clips.filter((clip) => clip.selected && !clip.provisional);
  const analyzing = ['analyzing', 'queued', 'preparing'].includes(saved.analysis.status);
  $('review-progress').textContent = t('review_progress_text', { name: saved.identity.name, current: time(saved.analysis.processedUntil), total: time(saved.duration), status: getStatuses()[saved.analysis.status] || saved.analysis.status, analyzing: analyzing ? t('analyzing_ongoing') : '' });
  const added = saved.clips.filter((clip) => !clip.provisional && !clip.excluded).length - (seenCandidates.get(saved.id) || 0);
  $('new-candidates').textContent = added > 0 ? t('new_candidates_badge', { count: added }) : '';
  $('candidate-tail').textContent = analyzing ? t('tail_analyzing') : t('tail_done');
  const selectionSummary = t('selection_summary_text', { count: selected.length, duration: selected.reduce((total, clip) => total + clip.end - clip.start, 0).toFixed(2), unexported: saved.hasUnexportedChanges ? t('unexported_changes_tag') : '' });
  if ($('selection-summary').textContent !== selectionSummary) $('selection-summary').textContent = selectionSummary;
  $('export').disabled = !selected.length || !record;
  $('export').textContent = t('submit_export');
  $('recompute').disabled = !(record?.scores || record?.windowScores);
  $('reset-decisions').disabled = !saved.decisions.length && !Object.keys(saved.selection).length;
  $('retain-all').disabled = $('exclude-all').disabled = !saved.clips.some((clip) => !clip.provisional);
  renderClips(saved); renderRange(saved); renderPlayer();
}
function renderExports() {
  const batchStatusMap = {
    'awaiting-destination': t('batch_awaiting_dir'),
    queued: t('batch_queued'),
    running: t('batch_running'),
    completed: t('batch_completed'),
    cancelled: t('batch_cancelled'),
    failed: t('batch_failed'),
    interrupted: t('batch_interrupted')
  };
  $('export-count').textContent = t('export_count', { count: view.batches.length });
  $('export-batches').querySelector('.empty-batches')?.remove();
  if (!view.batches.length && !$('export-batches').children.length) $('export-batches').append(element('p', t('batch_empty'), 'muted empty-batches'));
  for (const batch of view.batches) {
    let row = batchRows.get(batch.id);
    if (!row) {
      row = element('article', undefined, 'export-batch'); row.dataset.batchId = batch.id;
      const title = element('strong', undefined, 'batch-title'), state = element('p', undefined, 'batch-state');
      const destination = element('p', undefined, 'batch-destination');
      const summary = element('p', undefined, 'batch-summary');
      const attention = element('p', undefined, 'batch-attention');
      const files = element('details', undefined, 'batch-files');
      files.append(element('summary', t('batch_view_files', { count: 0 })));
      const details = element('details', undefined, 'inline-details batch-details');
      details.append(element('summary', t('batch_detail_summary')));
      const ranges = element('p', undefined, 'muted batch-ranges'), outcomes = element('ol', undefined, 'clip-outcomes'), outputs = element('div', undefined, 'batch-outputs');
      const cancel = button(t('batch_cancel_btn'), () => {
        if (exportQueue.getBatch(batch.id)) exportQueue.cancel(batch.id);
        else workspace.updateBatch(batch.id, { status: 'cancelled', error: t('batch_cancelled') });
      }); cancel.className = 'batch-cancel';
      const start = button(t('batch_start_btn'), () => startExport(batch.id)); start.className = 'batch-start';
      const review = button(t('batch_back_review_btn'), () => openReview(batch.sourceId)); review.className = 'batch-review';
      const actions = element('div', undefined, 'row'); actions.append(start, cancel, review);
      details.append(ranges, outcomes);
      files.append(outputs);
      row.append(title, state, summary, destination, attention, files, details, actions); batchRows.set(batch.id, row); $('export-batches').append(row);
    }
    const live = exportQueue.getBatch(batch.id);
    const completedNow = justCompleted(row.dataset.status, batch.status);
    row.dataset.status = batch.status;
    const summary = batchSummary(batch);
    row.querySelector('.batch-summary').textContent = batch.status === 'awaiting-destination' ? t('batch_summary_awaiting', { summary: summary.text }) : summary.text;
    const failures = (batch.clipResults || []).filter((result) => result.status === 'failed');
    const attention = row.querySelector('.batch-attention');
    const cleanupWarnings = (batch.clipResults || []).flatMap(result => result.cleanupWarnings || []);
    attention.hidden = !failures.length && !cleanupWarnings.length;
    attention.textContent = [failures.length ? `${getLang() === 'zh' ? '需处理' : 'Attention'}: ${failures.map((result) => `${time(result.start)}—${time(result.end)}${result.error ? `: ${result.error}` : ''}`).join('; ')}` : '', ...cleanupWarnings].filter(Boolean).join('; ');
    const files = row.querySelector('.batch-files');
    files.hidden = !(batch.outputs || []).length;
    files.querySelector('summary').textContent = t('batch_view_files', { count: (batch.outputs || []).length });
    if (completedNow) taskFeedback(row, 'completed');
    row.querySelector('.batch-title').textContent = t('batch_title_text', { name: batch.source.name, count: batch.clips.length });
    row.querySelector('.batch-destination').textContent = batch.destination?.mode === 'directory' ? t('batch_dest_dir', { name: batch.destination.name }) : batch.status === 'awaiting-destination' ? t('batch_dest_awaiting') : t('batch_dest_unrecorded');
    if (live?.pendingDestination && live.pendingDestination.name !== batch.destination?.name) row.querySelector('.batch-destination').textContent += t('batch_dest_pending', { name: live.pendingDestination.name });
    row.querySelector('.batch-state').textContent = `${batchStatusMap[batch.status] || batch.status}${batch.status === 'running' ? ` · ${Math.round(batch.progress * 100)}%` : ''}${live?.waitingReason ? ` · ${live.waitingReason}` : ''}${batch.error ? ` · ${batch.error}` : ''}`;
    row.querySelector('.batch-state').classList.toggle('error', batch.status === 'failed');
    row.querySelector('.batch-ranges').textContent = t('batch_ranges_info', {
      time: new Date(batch.createdAt).toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US'),
      ranges: batch.clips.map((clip) => `${clip.start.toFixed(2)}—${clip.end.toFixed(2)}s`).join('; '),
      format: (batch.output.format || outputSettings.format).toUpperCase(),
      video: (batch.output.videoCodec || outputSettings.videoCodec).toUpperCase(),
      audio: batch.output.audioCodec || outputSettings.audioCodec
    });
    row.querySelector('.batch-cancel').textContent = t('batch_cancel_btn');
    row.querySelector('.batch-cancel').hidden = batch.status !== 'awaiting-destination' && (!live || !['queued', 'running'].includes(batch.status));
    row.querySelector('.batch-start').hidden = batch.status !== 'awaiting-destination';
    row.querySelector('.batch-start').disabled = startingExports.has(batch.id);
    row.querySelector('.batch-start').textContent = bindings.has(batch.sourceId) ? t('batch_start_btn') : t('batch_resume_link_btn');
    row.querySelector('.batch-review').textContent = t('batch_back_review_btn');
    row.querySelector('.batch-details summary').textContent = t('batch_detail_summary');
    const resultKey = JSON.stringify(batch.clipResults || []);
    if (row.resultKey !== resultKey) {
      row.resultKey = resultKey;
      const labels = {
        'not-started': t('outcome_not_started'),
        running: t('outcome_running'),
        completed: t('outcome_completed'),
        failed: t('outcome_failed'),
        cancelled: t('outcome_cancelled'),
        interrupted: t('outcome_interrupted')
      };
      row.querySelector('.clip-outcomes').replaceChildren(...(batch.clipResults || []).map((result) => element('li', `${result.start.toFixed(2)}—${result.end.toFixed(2)} s · ${labels[result.status]}${result.error ? `: ${result.error}` : ''}`, 'clip-outcome')));
    }
    const outputKey = JSON.stringify(batch.outputs || []);
    if (row.outputKey !== outputKey) {
      row.outputKey = outputKey; const outputList = row.querySelector('.batch-outputs'); outputList.replaceChildren();
      for (const output of batch.outputs || []) {
        const item = element('div', undefined, 'output-item');
        const destName = output.destination?.name || batch.destination?.name || (getLang() === 'zh' ? '所选目录' : 'chosen folder');
        item.append(element('span', `${t('output_item_saved', { name: output.name, dest: destName })}${output.available ? '' : t('output_item_unverified')}`));
        if (output.verificationError) item.append(element('small', t('output_item_check_error', { err: output.verificationError }), 'muted'));
        const metadata = element('details', undefined, 'output-details');
        metadata.append(element('summary', t('output_item_details_summary', { size: (output.bytes / 1048576).toFixed(2) })));
        const reusedStr = output.reused ? t('output_item_reused') : '';
        const measuredStr = Number.isFinite(output.measuredDuration) ? t('output_item_readback', { duration: output.measuredDuration.toFixed(3) }) : t('output_item_readback_incomplete');
        metadata.append(element('small', t('output_item_meta', {
          reused: reusedStr,
          size: (output.bytes / 1048576).toFixed(2),
          duration: output.requestedDuration.toFixed(2),
          measured: measuredStr
        }), 'muted'));
        item.append(metadata);
        outputList.append(item);
      }
    }
  }
}
function renderDiagnostics() {
  const record = bindings.get(activeSourceId) || queue.records.find((item) => item.status === 'analyzing') || queue.records.at(-1);
  $('analysis-report').disabled = !record;
  $('analysis-timing').textContent = record ? JSON.stringify({ name: record.file.name, status: record.status, model: record.model, windows: record.windows, audioPolicy: record.audioPolicy, timings: record.timings }, null, 2) : (getLang() === 'zh' ? '尚无分析记录。' : 'No analysis records yet.');
}
function render() {
  $('exports-section').hidden = currentPage !== 'exports';
  $('nav-exports').setAttribute('aria-current', currentPage === 'exports' ? 'page' : 'false');
  const activeExports = view.batches.filter((batch) => ['awaiting-destination', 'queued', 'running'].includes(batch.status)).length;
  $('nav-exports').textContent = activeExports ? t('nav_exports_badge', { count: activeExports }) : t('nav_exports');
  $('analysis-page').hidden = currentPage !== 'analysis'; $('review-page').hidden = currentPage !== 'review';
  $('status').hidden = $('status').dataset.page !== currentPage && $('status').dataset.tone !== 'error';
  $('nav-analysis').setAttribute('aria-current', currentPage === 'analysis' ? 'page' : 'false');
  $('nav-review').setAttribute('aria-current', currentPage === 'review' ? 'page' : 'false'); $('nav-review').disabled = !view.sources.length;
  $('demo').disabled = makingDemo;
  $('drop-zone').setAttribute('aria-disabled', String(currentPage !== 'analysis'));
  if (currentPage !== 'analysis') $('drop-zone').classList.remove('drag-over');

  if (currentPage === 'analysis') {
    renderQueue();
  } else if (currentPage === 'review') {
    renderSources();
    renderReview();
  } else if (currentPage === 'exports') {
    renderExports();
  }
  renderDiagnostics();
}

async function demo() {
  if (makingDemo) return;
  makingDemo = true; render(); note(t('note_demo_loading'));
  try {
    const metadata = await fetch('/demo/manifest.json');
    if (!metadata.ok) throw new Error(t('err_demo_not_found'));
    const { name, bytes, lastModified } = await metadata.json();
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes >= 100 * 1048576) throw new Error(t('err_demo_too_large'));
    const response = await fetch('/demo/recording.mp4');
    if (!response.ok) throw new Error(t('err_demo_read'));
    const blob = await response.blob();
    if (blob.size !== bytes) throw new Error(t('err_demo_corrupted'));
    await importFiles([new File([blob], name, { type: 'video/mp4', lastModified })]);
    note(t('note_demo_ready'));
  } finally { makingDemo = false; render(); }
}

$('export').onclick = () => safely(submitExport);
$('choose-directory').onclick = () => { chooseOutputDirectory().catch((error) => note(error.name === 'AbortError' ? t('err_no_dir_picker') : errorText(error), 'error')); };
$('import-files').onclick = () => { $('files').click(); };
$('files').onchange = () => { const files = [...$('files').files]; $('files').value = ''; safely(() => importFiles(files)); };
const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
document.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  const canImport = currentPage === 'analysis' && $('drop-zone').contains(event.target);
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
  const files = Array.from(event.dataTransfer.files);
  if (files.length) safely(() => importFiles(files));
});
$('demo').onclick = () => safely(demo);
$('nav-exports').onclick = $('view-exports').onclick = showExports;
$('nav-analysis').onclick = $('back-analysis').onclick = showAnalysis;
$('nav-review').onclick = () => safely(() => openReview(activeSourceId || view.sources[0].id));
$('source-select').onchange = () => safely(() => openReview($('source-select').value));
$('play-pause').onclick = () => { if (playerState.playing) player.pause(); else player.play().catch((error) => note(errorText(error))); };
$('play-selection').onclick = () => safely(() => {
  const clip = selectedClip();
  if (!$('play-selection').disabled && clip) return player.playRange({ start: clip.start, end: clip.end });
});
$('player-mute').onclick = () => player.toggleMute();
$('player-volume').oninput = () => {
  player.setVolume(Number($('player-volume').value));
  if (playerState.muted && playerState.volume > 0) player.toggleMute();
};
const playerFrame = $('player-frame');
if (playerFrame) {
  playerFrame.addEventListener('mousemove', resetPlayerIdle);
  playerFrame.addEventListener('mouseenter', resetPlayerIdle);
  playerFrame.addEventListener('mouseleave', () => {
    if (playerState.playing) {
      if (idleTimer) clearTimeout(idleTimer);
      playerFrame.dataset.idle = 'true';
    }
  });
}
function updateFullscreenState() {
  const isFull = document.fullscreenElement === playerFrame || document.webkitFullscreenElement === playerFrame;
  const btn = $('player-fullscreen');
  if (btn) {
    btn.dataset.fullscreen = String(isFull);
    btn.title = isFull ? t('exit_fullscreen_title') : t('fullscreen_title');
    btn.setAttribute('aria-label', btn.title);
  }
  if (playerFrame) playerFrame.dataset.fullscreen = String(isFull);
}
function toggleFullscreen() {
  if (!playerFrame) return;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (playerFrame.requestFullscreen) playerFrame.requestFullscreen().catch((err) => note(errorText(err)));
    else if (playerFrame.webkitRequestFullscreen) playerFrame.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen().catch((err) => note(errorText(err)));
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}
$('player-fullscreen').onclick = () => safely(toggleFullscreen);
$('source-canvas').ondblclick = () => safely(toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenState);
document.addEventListener('webkitfullscreenchange', updateFullscreenState);
async function seek(value) {
  const saved = source(); if (!saved) return;
  const position = Math.max(0, Math.min(saved.duration, Number(value)));
  if (!Number.isFinite(position)) return;
  workspace.setReview(saved.id, { position });
  if (bindings.has(saved.id)) await player.seek(position);
}
function stepCandidate(direction) {
  const saved = source(); if (!saved) return;
  const position = playerSourceId === saved.id ? playerState.position : saved.review.position;
  const stable = saved.clips.filter((item) => !item.provisional && !item.excluded);
  const clip = direction < 0
    ? [...stable].reverse().find((item) => item.start < position - 0.01)
    : stable.find((item) => item.start > position + 0.01);
  if (clip) return selectRange(clip);
  if (direction < 0) note(t('note_no_earlier_candidate'));
  else note(saved.analysis.status === 'analyzing' ? t('note_tail_analyzing') : t('note_no_later_candidate'));
}
$('prev-candidate').onclick = () => safely(() => stepCandidate(-1));
$('next-candidate').onclick = () => safely(() => stepCandidate(1));
$('manual').onclick = () => safely(() => { const saved = source(), start = Math.min(saved.review.position, Math.max(0, saved.duration - 5)); const id = workspace.addManual(saved.id, { start, end: Math.min(saved.duration, start + 5) }); selectRange(workspace.getSource(saved.id).clips.find((clip) => clip.id === id), false); });
function trimBoundary(key, value) {
  const saved = source(), clip = selectedClip();
  if (!clip || clip.provisional) return;
  if (value === '' || !Number.isFinite(Number(value))) throw new Error(t('err_valid_trim_time'));
  const next = Number(value);
  workspace.trim(saved.id, clip.id, { start: clip.start, end: clip.end, [key]: next });
  $(`range-${key}`).value = next.toFixed(2);
}
for (const key of ['start', 'end']) {
  const commit = (node) => safely(() => {
    try { trimBoundary(key, node.value); }
    catch (error) { const clip = selectedClip(); node.value = clip ? clip[key].toFixed(2) : ''; throw error; }
  });
  $(`range-${key}`).onchange = () => commit($(`range-${key}`));
  $(`range-${key}-current`).onclick = () => safely(() => trimBoundary(key, source().review.position));
  $(`zoom-${key}`).onchange = () => safely(() => workspace.setReview(activeSourceId, { [`zoom${key === 'start' ? 'Start' : 'End'}`]: Number($(`zoom-${key}`).value) }));
}
selectionTimeline = createSelectionTimeline({ MB, workspace, getSource: source, getRecord: (id) => bindings.get(id), selectRange, seek, pause: () => player.pause(),
  isActive: () => currentPage === 'review' && !loadingSource,
  playPause: () => { if (!$('play-pause').disabled) $('play-pause').click(); },
  playRange: () => { if (!$('play-selection').disabled) $('play-selection').click(); },
  toggleMute: () => player.toggleMute(),
  toggleFullscreen: () => { if (!$('player-fullscreen').disabled) $('player-fullscreen').click(); },
  isPlayerBusy: () => loadingSource || ['loading', 'seeking'].includes(playerState.status), report: (error) => note(errorText(error)) });
$('show-excluded').addEventListener('change', () => renderClips(source()));
$('fit-selection').onclick = () => safely(() => { const clip = selectedClip(); if (clip) selectRange(clip, false); });
$('recompute').onclick = () => safely(() => { const record = bindings.get(activeSourceId); queue.recompute(record.id, Number($('threshold').value)); note(t('note_recompute_done')); });
$('retain-all').onclick = () => safely(() => workspace.chooseAll(activeSourceId, true));
$('exclude-all').onclick = () => safely(() => workspace.chooseAll(activeSourceId, false));
$('reset-decisions').onclick = () => { const saved = source(); if (confirm(t('confirm_reset_decisions', { name: saved.identity.name }))) safely(() => workspace.resetDecisions(saved.id)); };
$('analysis-report').onclick = () => { const record = bindings.get(activeSourceId) || queue.records.find((item) => item.status === 'analyzing') || queue.records.at(-1); if (!record) return; const report = { date: new Date().toISOString(), source: { name: record.file.name, bytes: record.file.size, duration: record.duration }, model: record.modelInfo, audioPolicy: record.audioPolicy, status: record.status, windows: record.windows, timings: record.timings, candidates: record.candidates }; const link = element('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); link.download = 'apex-analysis-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); };
function renderOutputFormat() {
  $('output-format').textContent = t('output_format_render', {
    format: outputSettings.format.toUpperCase(),
    video: outputSettings.videoCodec === 'avc' ? 'H.264' : outputSettings.videoCodec.toUpperCase(),
    audio: outputSettings.audioCodec.toUpperCase()
  });
}
function renderCapabilities() {
  const audioOk = typeof AudioDecoder !== 'undefined';
  const videoOk = typeof VideoDecoder !== 'undefined';
  const isoOk = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  $('capabilities').textContent = `${t('audio_decoder')} ${audioOk ? t('cap_available') : t('cap_unavailable')} · ${t('video_decoder')} ${videoOk ? t('cap_available') : t('cap_unavailable')} · ${t('isolated_context')} ${isoOk ? t('cap_available') : t('cap_unavailable')}`;
}
$('export-format').onchange = () => { outputSettings = exportSettings({ format: $('export-format').value }); renderOutputFormat(); };

// Language switcher
const langBtn = $('lang-toggle');
if (langBtn) {
  langBtn.onclick = () => {
    setLang(getLang() === 'en' ? 'zh' : 'en');
  };
}
onLanguageChange(() => {
  applyTranslations();
  render();
  renderOutputFormat();
  renderCapabilities();
});

// Session state is intentionally not written to browser storage.
const shouldWarnOnLeave = () => !preview && (
  pendingImports.size > 0 || queue.records.some(record => ['preparing', 'queued', 'analyzing'].includes(record.status)) ||
  view.sources.some(item => item.hasUnexportedChanges) ||
  view.batches.some(batch => ['awaiting-destination', 'queued', 'running'].includes(batch.status))
);
window.addEventListener('beforeunload', event => {
  if (!shouldWarnOnLeave()) return;
  event.preventDefault(); event.returnValue = '';
});
window.addEventListener('pagehide', () => { player.pause(); selectionTimeline?.suspend(); });
const ready = Promise.resolve();
$('import-files').disabled = false;
applyTranslations();
renderOutputFormat();
renderCapabilities();
render();
note(t('status_ready'), 'quiet');
window.reviewApp = { workspace, queue, player, exportQueue, submitExport, importFiles, demo, openReview, showAnalysis, ready, bindings, shouldWarnOnLeave, get activeSourceId() { return activeSourceId; }, get page() { return currentPage; } };

if (preview) void ready.then(() => mountReviewPreview(window.reviewApp)).catch((error) => note(errorText(error), 'error'));

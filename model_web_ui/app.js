import { service, artifactUrl } from './transport.js';

const el = (id) => document.getElementById(id);
let media = null, selected = null, recordings = [], parent = null;
let busy = false, taskRunning = false, activeTaskId = null, pollTimer = null;
let analysis = null, draft = [], selectionDirty = false, nextScoreStart = null;
const resultSources = new Map();
const stages = { extracting_audio: '抽取音频', model_loading: '加载模型', inference: '模型推理',
  postprocessing: '生成候选', previewing: '生成预览', exporting: '导出片段',
  starting: '准备任务', preparing_export: '准备导出',
  completed: '已完成', failed: '失败', cancelled: '已取消', cancelling: '正在取消' };

function controls() {
  document.querySelectorAll('button, input, textarea').forEach((c) => { c.disabled = busy; });
  document.querySelectorAll('#source, #probe, #browse-toggle, #browser button, #browser input, #tracks input, #confirm, #recordings button')
    .forEach((c) => { c.disabled = busy || taskRunning; });
  document.querySelectorAll('#parameters-form input, #parameters-form button, #candidates input, #candidates button, #select-all, #select-none, #save-selection, #export-form input, #export')
    .forEach((c) => { c.disabled = busy || taskRunning || !analysis; });
  el('confirm').disabled = busy || taskRunning || !media || selected === null;
  el('analyze').disabled = busy || taskRunning || !recordings.length
    || recordings.some((item) => !item.selected_audio)
    || !!(media && selected !== media.selected_audio?.stream_index);
  el('cancel').disabled = busy || !taskRunning;
  el('save-selection').disabled = busy || taskRunning || !analysis || !selectionDirty;
  el('export').disabled = busy || taskRunning || !analysis || !draft.some((item) => item.selected);
  el('score-next').disabled = busy || nextScoreStart === null;
}
function notice(message, error = false) {
  el('notice').textContent = message; el('notice').classList.toggle('error', error);
}
async function perform(action) {
  if (busy) return;
  busy = true; controls();
  try { await action(); } catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
}
function persistRecordings() {
  sessionStorage.setItem('modelMediaIds', JSON.stringify(recordings.map((item) => item.media_id)));
  if (media) sessionStorage.setItem('modelMediaId', media.media_id);
}
function clearMedia() {
  media = null; selected = null; el('media').hidden = true;
  sessionStorage.removeItem('modelMediaId'); controls();
}
function renderRecordings() {
  el('recordings').replaceChildren();
  recordings.forEach((item, index) => {
    const row = document.createElement('li'), choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'secondary' + (media?.media_id === item.media_id ? ' current' : '');
    choose.textContent = `${index + 1}. ${item.source.path} · ${item.selected_audio ? '已确认音轨 #' + item.selected_audio.stream_index : '待确认音轨'}`;
    choose.addEventListener('click', () => showMedia(item));
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'secondary'; remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除录像 ${index + 1}`);
    remove.addEventListener('click', () => {
      recordings = recordings.filter((recording) => recording.media_id !== item.media_id);
      if (media?.media_id === item.media_id) clearMedia();
      persistRecordings(); renderRecordings(); controls();
    });
    row.append(choose, remove); el('recordings').append(row);
  });
  const confirmed = recordings.filter((item) => item.selected_audio).length;
  el('queue-info').textContent = recordings.length
    ? `${recordings.length} 份录像 · ${confirmed} 份已确认音轨。按列表顺序分析；请选择待确认录像完成音轨确认。`
    : '每份录像都需要明确确认游戏音轨，然后按列表顺序分析。';
}
function showMedia(result) {
  media = result;
  const existing = recordings.findIndex((item) => item.media_id === result.media_id);
  if (existing >= 0) recordings[existing] = result; else recordings.push(result);
  selected = result.selected_audio?.stream_index ?? null;
  el('source').value = result.source.path; el('media').hidden = false;
  el('video-info').textContent = `${result.video.width} × ${result.video.height} · ${result.video.codec} · ${result.duration_s.toFixed(3)} 秒 · ${result.audio_tracks.length} 条音轨`;
  el('tracks').replaceChildren();
  for (const track of result.audio_tracks) {
    const label = document.createElement('label'), radio = document.createElement('input');
    label.className = 'track'; radio.type = 'radio'; radio.name = 'audio-track';
    radio.value = String(track.stream_index); radio.checked = track.stream_index === selected;
    const description = document.createElement('span');
    description.textContent = `音轨 #${track.stream_index} · ${track.title || '未命名'} · ${track.language} · ${track.codec} · ${track.channels} 声道 · ${track.sample_rate} Hz · 起点 ${track.start_time_s.toFixed(3)} 秒`;
    radio.addEventListener('change', () => { selected = track.stream_index; el('selection').textContent = '音轨选择待确认。'; controls(); });
    label.append(radio, description); el('tracks').append(label);
  }
  const m = result.selected_audio;
  el('selection').textContent = m
    ? `已保存音轨 #${m.stream_index}。音频原点 ${m.audio_origin_s.toFixed(3)} 秒，视频原点 ${m.video_origin_s.toFixed(3)} 秒；音频时间加 ${m.audio_to_video_offset_s.toFixed(3)} 秒映射到录像时间。`
    : '尚未确认音轨。请选择后点击确认。';
  persistRecordings(); renderRecordings(); controls();
}
function appendRow(target, values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement('td');
    if (value instanceof Node) cell.append(value); else cell.textContent = String(value);
    row.append(cell);
  }
  target.append(row);
}
function clearPreview() {
  el('preview-video').pause(); el('preview-video').removeAttribute('src'); el('preview-video').load(); el('preview').hidden = true;
}
function selectionSummary() {
  const kept = draft.filter((item) => item.selected), duration = kept.reduce((sum, item) => sum + item.end_s - item.start_s, 0);
  el('selection-summary').textContent = `已选 ${kept.length} / ${draft.length} 段 · 请求时长 ${duration.toFixed(3)} 秒${selectionDirty ? ' · 修改尚未保存，预览或导出时会先保存。' : ' · 选择与范围已保存。'}`;
  controls();
}
function renderCandidates() {
  draft = (analysis.selection || analysis.candidates.map((c) => ({ ...c, selected: true }))).map((item) => ({ ...item }));
  selectionDirty = false; el('candidates').replaceChildren();
  analysis.candidates.forEach((candidate, index) => {
    const item = draft.find((entry) => entry.candidate_id === candidate.candidate_id), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = item.selected; checkbox.setAttribute('aria-label', `保留候选 ${index + 1}`);
    checkbox.addEventListener('change', () => { item.selected = checkbox.checked; selectionDirty = true; selectionSummary(); });
    const automaticDuration = document.createElement('span'), requestedDuration = document.createElement('span');
    automaticDuration.setAttribute('aria-label', `候选 ${index + 1} 自动时长`);
    requestedDuration.setAttribute('aria-label', `候选 ${index + 1} 请求时长`);
    automaticDuration.textContent = `${(candidate.end_s - candidate.start_s).toFixed(3)} 秒`;
    const updateDuration = () => {
      const seconds = item.end_s - item.start_s;
      requestedDuration.textContent = Number.isFinite(seconds) && seconds > 0 ? `${seconds.toFixed(3)} 秒` : '范围无效';
    };
    updateDuration();
    const fields = ['start_s', 'end_s'].map((key) => {
      const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = String(analysis.media.duration_s);
      input.step = '0.001'; input.value = item[key].toFixed(3);
      input.setAttribute('aria-label', `候选 ${index + 1} 请求${key === 'start_s' ? '起点' : '终点'} / 秒`);
      input.addEventListener('input', () => { item[key] = Number(input.value); selectionDirty = true; updateDuration(); clearPreview(); selectionSummary(); });
      return input;
    });
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'secondary'; preview.textContent = '预览';
    preview.addEventListener('click', () => perform(async () => {
      await saveSelection();
      await startTask('request_preview', { result_id: analysis.result_id, candidate_version: analysis.candidate_version, candidate_id: candidate.candidate_id });
    }));
    appendRow(el('candidates'), [checkbox, index + 1, `${candidate.start_s.toFixed(3)} – ${candidate.end_s.toFixed(3)}`, automaticDuration, ...fields, requestedDuration, preview]);
  });
  selectionSummary();
}
async function saveSelection() {
  if (!analysis || !selectionDirty) return;
  if (draft.some((item) => !Number.isFinite(item.start_s) || !Number.isFinite(item.end_s)
    || item.start_s < 0 || item.start_s >= item.end_s || item.end_s > analysis.media.duration_s)) {
    throw new Error('每段请求范围须满足 0 ≤ 起点 < 终点 ≤ 录像时长。');
  }
  analysis = await service('update_selection', { result_id: analysis.result_id, candidate_version: analysis.candidate_version,
    clips: draft.map(({ candidate_id, selected, start_s, end_s }) => ({ candidate_id, selected, start_s, end_s })) });
  clearPreview(); renderCandidates();
}
async function readScores(start = Number(el('score-start').value)) {
  const end = Number(el('score-end').value);
  if (!analysis || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > analysis.media.duration_s) {
    throw new Error('查看范围须满足 0 ≤ 起点 < 终点 ≤ 录像时长。');
  }
  const page = await service('read_scores', { prediction_id: analysis.prediction_id, start_s: start, end_s: end });
  nextScoreStart = page.next_start_s; el('score-start').value = start.toFixed(3);
  const gun = page.classes.indexOf('Gunshot, gunfire'), machine = page.classes.indexOf('Machine gun');
  el('score-rows').replaceChildren();
  for (let i = 0; i < page.scores.length; i++) appendRow(el('score-rows'), [page.frame_onsets_s[i].toFixed(3), page.frame_offsets_s[i].toFixed(3), page.scores[i][gun].toFixed(4), page.scores[i][machine].toFixed(4)]);
  el('score-info').textContent = `${page.scores.length} 帧 · 完整类别 ${page.classes.length} 类 · ${nextScoreStart === null ? '已读完此范围' : '此范围还有分数，点击下一页'}`;
  const canvas = el('score-chart'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#677b70'; ctx.font = '13px sans-serif';
  ctx.fillText('1.0', 4, 20); ctx.fillText('0.0', 4, 180);
  if (page.scores.length) {
    const first = page.frame_onsets_s[0], last = page.frame_offsets_s.at(-1);
    for (const [index, color, label, labelX] of [[gun, '#276e4e', 'Gunshot, gunfire', 70], [machine, '#d38b34', 'Machine gun', 270]]) {
      ctx.strokeStyle = color; ctx.beginPath();
      page.scores.forEach((scores, i) => {
        const x = 40 + (page.frame_onsets_s[i] - first) / (last - first) * 840, y = 180 - scores[index] * 160;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke(); ctx.fillStyle = color; ctx.fillText(label, labelX, 16);
    }
    ctx.fillStyle = '#677b70'; ctx.fillText(`${first.toFixed(3)} 秒`, 40, 198); ctx.fillText(`${last.toFixed(3)} 秒`, 800, 198);
  }
  controls();
}
function showCandidateResult(result) {
  analysis = result; el('result').hidden = false; el('result-source').textContent = result.media.source.path;
  resultSources.set(result.result_id, result.media.source.path);
  const prediction = result.prediction, model = prediction.model;
  el('result-summary').textContent = result.candidates.length ? `${result.candidates.length} 段枪声候选 · ${result.events.length} 条事件。完整预测已保存。`
    : '没有枪声候选。完整预测仍已保存，可查看分数或调整参数。';
  el('model-version').textContent = `模型 ${model.name} · 权重 SHA-256 ${model.checkpoint_sha256} · 前处理 ${model.preprocessing_version} · ${prediction.frame_count} 帧 / ${prediction.classes.length} 类 · ${(prediction.frame_step_s * 1000).toFixed(0)} ms 网格 · 有效音频 ${prediction.valid_duration_s.toFixed(6)} 秒`;
  for (const [id, key] of [['threshold', 'threshold'], ['merge-gap', 'merge_gap_s'], ['before', 'before_s'], ['after', 'after_s']]) el(id).value = String(result.parameters[key]);
  sessionStorage.setItem('modelResultId', result.result_id); clearPreview(); renderCandidates();
}
async function showResult(resultId) {
  showCandidateResult(await service('get_result', { result_id: resultId }));
  el('score-start').value = '0'; el('score-end').value = Math.min(analysis.media.duration_s, 40);
  for (const id of ['score-start', 'score-end']) el(id).max = analysis.media.duration_s;
  el('exports').hidden = true; await readScores();
}
function renderBatchResults(task) {
  const results = task.results?.length ? task.results : task.result_id ? [{ media_id: task.media_id, result_id: task.result_id, status: 'completed' }] : [];
  el('batch-results').hidden = !results.length; el('result-list').replaceChildren();
  results.forEach((item, index) => {
    const row = document.createElement('li'), source = recordings.find((r) => r.media_id === item.media_id)?.source.path || `录像 ${index + 1}`;
    if (item.result_id) resultSources.set(item.result_id, source);
    if (item.status === 'completed' && item.result_id) {
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'secondary'; choose.textContent = `${source} · 查看候选`;
      choose.addEventListener('click', () => perform(() => showResult(item.result_id))); row.append(choose);
    } else { row.className = 'failed'; row.textContent = `${source} · ${item.error?.code || item.status}：${item.error?.message || '未完成'}`; }
    el('result-list').append(row);
  });
  return results;
}
function rangeText(value) {
  if (!value) return '未记录';
  if (Array.isArray(value)) return `${Number(value[0]).toFixed(3)} – ${Number(value[1]).toFixed(3)} 秒`;
  return `${Number(value.start_s ?? value.start).toFixed(3)} – ${Number(value.end_s ?? value.end).toFixed(3)} 秒`;
}
function renderExports(task) {
  el('exports').hidden = false; el('export-list').replaceChildren();
  for (const item of task.exports || []) {
    const row = document.createElement('li'), path = document.createElement('div'), ranges = document.createElement('div');
    path.textContent = item.path || item.output_path || item.output || ''; ranges.className = 'hint';
    ranges.textContent = `请求 ${rangeText(item.requested_range || item.requested)} · 实际 ${rangeText(item.actual_range || item.actual)} · ${stages[item.status] || item.status || '已完成'}${item.error ? ' · ' + item.error.message : ''}`;
    if (item.status === 'completed' && item.artifact_id) {
      const play = document.createElement('button'); play.type = 'button'; play.className = 'secondary'; play.textContent = '播放成片';
      play.addEventListener('click', () => perform(async () => {
        const artifact = await service('get_artifact', { artifact_id: item.artifact_id });
        el('preview').hidden = false; el('preview-video').src = artifactUrl(item.artifact_id);
        el('preview-info').textContent = `成片 · 请求 ${rangeText(artifact.requested_range)} · 实际 ${rangeText(artifact.actual_range)}`;
        await el('preview-video').play(); notice('正在播放已导出的独立片段。');
      }));
      row.append(play);
      if (window.apex?.openArtifactFolder) {
        const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.textContent = '打开文件所在目录';
        open.addEventListener('click', () => perform(() => window.apex.openArtifactFolder(item.artifact_id)));
        row.append(open);
      }
    }
    row.append(path, ranges); el('export-list').append(row);
  }
  if (!task.exports?.length) el('export-list').textContent = '尚无完成片段。';
}
async function finishTask(task) {
  if (task.kind === 'preview' && task.status === 'completed') {
    const artifact = await service('get_artifact', { artifact_id: task.preview_id });
    el('preview').hidden = false; el('preview-video').src = artifactUrl(task.preview_id);
    el('preview-info').textContent = `请求 ${rangeText(artifact.requested_range || artifact.requested)} · 预览仅用于人工复核。`;
    notice('预览已就绪。请播放检查请求范围。');
  } else if (task.kind === 'export') {
    renderExports(task); notice(task.status === 'completed' ? '独立片段导出完成。请检查请求范围与实际范围。'
      : `${task.status === 'cancelled' ? '导出已取消' : '导出失败'}。已完成片段和记录保留。${task.error?.message || ''}`, task.status === 'failed');
  } else if (task.kind === 'analysis' || !task.kind) {
    const results = renderBatchResults(task), first = results.find((item) => item.status === 'completed');
    const preferred = results.find((item) => item.status === 'completed' && item.result_id === analysis?.result_id) || first;
    if (preferred && preferred.result_id !== analysis?.result_id) await showResult(preferred.result_id);
    notice(task.status === 'completed' ? '分析完成。请分别复核各录像的候选。'
      : `${task.status === 'cancelled' ? '分析已取消' : '分析失败'}：${task.error?.message || '请查看各录像的任务记录。'}`, task.status === 'failed');
  } else if (task.status !== 'completed') notice(`${task.error?.code || task.status}：${task.error?.message || '任务未完成'}`, task.status === 'failed');
}
async function pollTask(taskId) {
  clearTimeout(pollTimer);
  try {
    const task = await service('get_task', { task_id: taskId }); activeTaskId = taskId;
    taskRunning = ['running', 'pending', 'cancelling'].includes(task.status); el('task').hidden = false;
    const percent = Math.round((task.progress || 0) * 100);
    const position = Math.min(task.media_ids?.length || 1,
      taskRunning ? (task.current_index ?? task.results?.length ?? 0) + 1 : task.results?.length || 1);
    const batch = task.media_ids?.length > 1 ? ` · 录像 ${position} / ${task.media_ids.length}` : '';
    const source = recordings.find(item => item.media_id === (task.current_media_id || task.media_id))?.source.path || resultSources.get(task.result_id);
    el('task-status').textContent = `${stages[task.stage] || task.stage} · ${percent}%${batch}${source ? ' · ' + source : ''} · 总耗时 ${(task.elapsed_s || 0).toFixed(2)} 秒`;
    el('task-progress').value = task.progress || 0; el('timings').replaceChildren();
    for (const [stage, seconds] of Object.entries(task.timings || {})) {
      const label = document.createElement('dt'), value = document.createElement('dd');
      label.textContent = stages[stage] || stage; value.textContent = `${seconds.toFixed(3)} 秒`; el('timings').append(label, value);
    }
    el('task-log').textContent = `任务 ${task.task_id}\n${(task.logs || []).map((log) => `${stages[log.stage] || log.stage} ${Math.round((log.progress || 0) * 100)}%`).join('\n')}${task.error ? '\n' + task.error.code + '：' + task.error.message : ''}${task.media_log ? '\n媒体日志：' + task.media_log : ''}${task.media_log_tail ? '\n' + (task.media_log_truncated ? '以下为日志末尾，完整记录见上述路径。\n' : '') + task.media_log_tail : ''}`;
    if (task.kind === 'export' && task.exports?.length) renderExports(task); controls();
    if (taskRunning) pollTimer = setTimeout(() => pollTask(taskId), 600); else await finishTask(task);
  } catch (error) {
    if (error.code === 'task_not_found') {
      taskRunning = false; activeTaskId = null; el('task').hidden = true;
      for (const key of ['modelTaskId', 'modelAnalysisTaskId']) {
        if (sessionStorage.getItem(key) === taskId) sessionStorage.removeItem(key);
      }
      notice('原任务不存在，已清除旧任务引用。可重新分析录像。', true);
      controls();
      return;
    }
    notice(`任务查询失败：${error.message}。使用当前启动地址刷新可重试。`, true);
    if (taskRunning) pollTimer = setTimeout(() => pollTask(taskId), 2000);
  }
}
async function startTask(operation, payload) {
  const task = await service(operation, payload); activeTaskId = task.task_id; taskRunning = true;
  sessionStorage.setItem('modelTaskId', task.task_id);
  if (operation === 'analyze') sessionStorage.setItem('modelAnalysisTaskId', task.task_id);
  notice('任务在本机后台执行，关闭页面不会停止；可以取消当前任务。'); await pollTask(task.task_id);
}
async function browse(path) {
  const listing = await service('browse', { path }); el('browser').hidden = false;
  el('directory').value = listing.path; parent = listing.parent; el('entries').replaceChildren();
  for (const entry of listing.entries) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.className = 'file'; button.type = 'button'; button.textContent = `${entry.is_dir ? '目录 / ' : ''}${entry.name}`;
    button.addEventListener('click', () => {
      if (entry.is_dir) perform(() => browse(entry.path));
      else { clearMedia(); el('source').value = entry.path; el('browser').hidden = true; notice('已选择本地文件，点击“探测并添加录像”查看音轨。'); }
    });
    item.append(button); el('entries').append(item);
  }
  if (!listing.entries.length) el('entries').textContent = '目录为空。';
}

el('source').addEventListener('input', clearMedia);
el('probe-form').addEventListener('submit', (event) => {
  event.preventDefault(); perform(async () => {
    const paths = el('source').value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean); clearMedia(); notice('正在探测本地录像…');
    const errors = [];
    for (const path of paths) {
      try { showMedia(await service('probe_media', { path })); } catch (error) { errors.push(`${path}：${error.message}`); }
    }
    notice(errors.length ? `部分录像无法添加。${errors.join('；')}` : '探测完成。请逐份录像明确选择检测音轨。', !!errors.length);
  });
});
el('browse-toggle').addEventListener('click', () => perform(() => browse(el('directory').value)));
el('browse-form').addEventListener('submit', (event) => { event.preventDefault(); perform(() => browse(el('directory').value)); });
el('parent').addEventListener('click', () => perform(() => browse(parent)));
el('confirm').addEventListener('click', () => perform(async () => {
  showMedia(await service('confirm_audio', { media_id: media.media_id, stream_index: selected })); notice('音轨与时间映射已保存，请继续确认列表中的其他录像。');
}));
el('analyze').addEventListener('click', () => perform(async () => {
  analysis = null; nextScoreStart = null; clearPreview(); el('result').hidden = true; el('batch-results').hidden = true;
  sessionStorage.removeItem('modelResultId'); await startTask('analyze', { media_ids: recordings.map((item) => item.media_id) });
}));
el('cancel').addEventListener('click', () => perform(async () => {
  await service('cancel_task', { task_id: activeTaskId }); notice('已请求取消，等待当前媒体或模型进程停止。已完成产物保留。'); await pollTask(activeTaskId);
}));
el('parameters-form').addEventListener('submit', (event) => {
  event.preventDefault(); perform(async () => {
    const parameters = { threshold: Number(el('threshold').value), merge_gap_s: Number(el('merge-gap').value), before_s: Number(el('before').value), after_s: Number(el('after').value) };
    const result = await service('recompute_candidates', { result_id: analysis.result_id, candidate_version: analysis.candidate_version, parameters });
    showCandidateResult(result); notice('候选已更新，全部重新预选。旧范围与预览已失效，请重新复核。');
  });
});
el('save-selection').addEventListener('click', () => perform(async () => { await saveSelection(); notice('选择与请求范围已保存。'); }));
for (const [id, value] of [['select-all', true], ['select-none', false]]) el(id).addEventListener('click', () => {
  draft.forEach((item) => { item.selected = value; }); el('candidates').querySelectorAll('input[type=checkbox]').forEach((input) => { input.checked = value; });
  selectionDirty = true; selectionSummary();
});
el('export-form').addEventListener('submit', (event) => {
  event.preventDefault(); perform(async () => {
    await saveSelection(); await startTask('export', { result_id: analysis.result_id, candidate_version: analysis.candidate_version, output_dir: el('output-dir').value, mode: 'copy' });
  });
});
el('score-form').addEventListener('submit', (event) => { event.preventDefault(); perform(() => readScores()); });
el('score-next').addEventListener('click', () => perform(() => readScores(nextScoreStart)));
el('preview-video').addEventListener('error', () => {
  if (el('preview-video').hasAttribute('src')) notice('预览无法播放。范围或候选版本可能已更新，请重新生成预览。', true);
});
perform(async () => {
  const config = await service('get_config'); el('directory').value = config.home; el('output-dir').value = config.output_dir || config.data_dir + '/exports';
  const previousDirectory = sessionStorage.getItem('modelDataDir');
  if (previousDirectory && previousDirectory !== config.data_dir) {
    for (const key of ['modelMediaId', 'modelMediaIds', 'modelTaskId', 'modelAnalysisTaskId', 'modelResultId']) sessionStorage.removeItem(key);
  }
  sessionStorage.setItem('modelDataDir', config.data_dir);
  const analysisTask = config.latest_analysis_task_id || sessionStorage.getItem('modelAnalysisTaskId');
  const previousTask = config.active_task_id || sessionStorage.getItem('modelTaskId') || config.latest_task_id;
  let discoveredAnalysis = null;
  if (analysisTask) {
    try { discoveredAnalysis = await service('get_task', { task_id: analysisTask }); }
    catch (error) { if (error.code !== 'task_not_found') throw error; }
  }
  for (const [label, value] of [['模型工作目录', config.model_workspace || '未配置'], ['模型权重', config.checkpoint || '未配置'],
    ['权重文件', config.checkpoint_available ? '文件存在（尚未加载或校验）' : '未就绪'], ['FFmpeg', config.ffmpeg], ['ffprobe', config.ffprobe], ['数据目录', config.data_dir]]) {
    const term = document.createElement('dt'), valueNode = document.createElement('dd'); term.textContent = label; valueNode.textContent = value; el('configuration').append(term, valueNode);
  }
  const previous = sessionStorage.getItem('modelMediaId'); let ids;
  try { ids = JSON.parse(sessionStorage.getItem('modelMediaIds') || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = []; if (previous && !ids.includes(previous)) ids.push(previous);
  if (!sessionStorage.getItem('modelMediaIds') || config.active_task_id) {
    ids = [...new Set([...ids, ...(discoveredAnalysis?.media_ids || [])])];
  }
  for (const mediaId of ids) {
    try { recordings.push(await service('get_media', { media_id: mediaId })); } catch { /* Removed records leave the restored queue. */ }
  }
  const current = recordings.find((item) => item.media_id === previous) || recordings.at(-1);
  if (current) showMedia(current); else renderRecordings();
  notice(recordings.length ? '已恢复录像列表。音轨确认和任务记录保留。' : '服务已就绪，请选择本地录像。');
  const previousResult = sessionStorage.getItem('modelResultId')
    || discoveredAnalysis?.results?.find(item => item.status === 'completed')?.result_id;
  if (previousResult) { try { await showResult(previousResult); } catch (error) { notice(`上次结果无法打开：${error.message}`, true); } }
  if (analysisTask && analysisTask !== previousTask) {
    if (discoveredAnalysis) renderBatchResults(discoveredAnalysis);
  }
  if (analysisTask) sessionStorage.setItem('modelAnalysisTaskId', analysisTask);
  if (previousTask) sessionStorage.setItem('modelTaskId', previousTask);
  if (previousTask) { taskRunning = true; await pollTask(previousTask); }
});

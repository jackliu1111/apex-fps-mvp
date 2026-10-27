import * as MB from '/assets/vendor/mediabunny.mjs';
import { sequentialAudio, renderContinuous } from './stream-audio.js';
import { openSparseAudio } from './sparse-audio.prototype.js';

// Throwaway functional prototype: real media and real model, no backend API.
const $ = (id) => document.getElementById(id);
const files = [];
const log = [];
let busy = false, cancelled = false, worker, conversion, activeId = null, nextRequest = 0;
let previewUrl;
let analyzing = false, reviewBusy = false;
const pending = new Map();
const downloads = [];
let metadata;
const modelKey = () => $('model').value;
const assetRoot = () => modelKey() === 'efficientat' ? '/assets/efficientat' : '/assets';
async function loadMetadata() {
  if (!metadata) {
    const response = await fetch(`${assetRoot()}/model.json`);
    if (!response.ok) throw new Error('模型清单无法读取');
    metadata = await response.json();
  }
  return metadata;
}
let lastReference = null;
let lastWindowTiming = null;
const active = () => files.find((file) => file.id === activeId);
const seconds = (value) => `${value.toFixed(2)} s`;
const errorText = (error) => error?.message || String(error);

function note(message) {
  $('status').textContent = message;
  log.push(`${new Date().toLocaleTimeString()}  ${message}`);
  $('log').textContent = log.slice(-35).join('\n');
  renderState();
}

function renderState() {
  const current = active();
  if (current?.timings) {
    const t = current.timings, s = (v) => ((v || 0) / 1000).toFixed(3);
    $('analysis-timing').textContent = `${current.file.name}\n状态：${current.status}；已完成窗口：${current.windows || 0}\n模型读取 ${s(t.readMs)} 秒；初始化 ${s(t.initializeMs)} 秒\n音频解码／重采样 ${s(t.decodeMs)} 秒；特征提取 ${s(t.frontendMs)} 秒；模型推理 ${s(t.inferenceMs)} 秒\n完整分析耗时：${t.totalMs === undefined ? (current.status === '分析中' ? '进行中' : '未完成') : s(t.totalMs) + ' 秒'}\n首个可复核候选：${t.firstReviewableMs === undefined ? '尚无' : s(t.firstReviewableMs) + ' 秒'}；解码与推理并行，分项耗时不可相加\n读取／解码等待 ${s(t.sourceDecodeWaitMs)} 秒；PCM 拼接 ${s(t.pcmAssemblyMs)} 秒；混音／重采样 ${s(t.resampleMs)} 秒\n音轨准备 ${s(t.audioSetupMs)} 秒；候选与页面更新 ${s(t.postprocessAndRenderMs)} 秒\n主流程等待音频 ${s(t.audioWaitMs)} 秒；模型调用往返 ${s(t.inferenceRoundTripMs)} 秒`;
    if (t.audioReader) $('analysis-timing').textContent += `\n实验跳读：${(t.sparseReadBytes / 1e6).toFixed(1)} MB / ${t.sparseReadCalls} 次范围读取`;
  } else $('analysis-timing').textContent = '尚无分析计时';
  $('state').textContent = JSON.stringify({
    processing: busy, cancelled, backend: 'WASM / CPU · Web Worker',
    model: metadata?.model || '尚未载入', currentFile: active()?.file.name || null,
    files: files.map((f) => ({ name: f.file.name, bytes: f.file.size, status: f.status,
      videoOrigin: f.origin, duration: f.duration, selectedTrack: f.selected,
      windowsCompleted: f.windows || 0, scoreFrames: f.windowScores ? null : f.scores?.length / 2 || 0, scoreWindows: f.windowScores?.length || 0,
      timings: f.timings, clips: f.clips, error: f.error || null })), exports: downloads.map(({ name, bytes, requestedDuration, measuredDuration, exportMs }) => ({ name, bytes, requestedDuration, browserReadbackDuration: measuredDuration, exportMs })),
    browserReference: lastReference,
  }, null, 2);
}

function clearPreview() {
  $('player').pause(); $('player').removeAttribute('src'); $('player').load();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('preview-label').textContent = '导出后复核画面与所选音轨';
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render() {
  const queue = $('queue');
  queue.replaceChildren();
  if (!files.length) queue.append(element('p', '选择一份或多份录像开始。', 'empty'));
  for (const f of files) {
    const row = element('div', undefined, 'file');
    const name = element('div');
    name.append(element('strong', f.file.name), element('small', `${seconds(f.duration)} · ${(f.file.size / 1048576).toFixed(1)} MiB`));
    const select = element('select');
    select.setAttribute('aria-label', `${f.file.name} 的游戏音轨`);
    select.append(new Option('请选择游戏音轨', ''));
    f.tracks.forEach((track, index) => select.append(new Option(`音轨 ${index + 1} · ${track.name || track.codec} · ${track.languageCode || '未标注语言'}`, String(index))));
    select.value = f.selected === null ? '' : String(f.selected);
    select.disabled = busy || reviewBusy;
    select.onchange = () => {
      if (f.id === activeId) clearPreview();
      f.selected = select.value === '' ? null : Number(select.value);
      f.scores = null; f.windowScores = null; f.timings = null; f.clips = []; f.windows = 0; f.error = null;
      f.status = f.selected === null ? '待选音轨' : '待分析';
      render();
    };
    row.append(name, select, element('span', f.status));
    queue.append(row);
  }
  $('result-file').replaceChildren(...files.map((f) => new Option(f.file.name, f.id)));
  $('result-file').value = activeId || '';
  const f = active();
  renderClips(f);
  for (const id of ['files', 'demo', 'analyze', 'manual', 'recompute', 'export', 'reference', 'benchmark', 'result-file', 'threshold', 'model', 'decode-reference', 'sparse-audio']) $(id).disabled = busy || reviewBusy;
  $('analyze').disabled = busy || reviewBusy || !files.length || files.some((f) => f.selected === null);
  $('manual').disabled = (busy && !analyzing) || reviewBusy || !f;
  $('result-file').disabled = (busy && !analyzing) || reviewBusy;
  $('recompute').disabled = busy || reviewBusy || !(f?.scores || f?.windowScores);
  $('export').disabled = busy || reviewBusy || !f?.clips.some((c) => c.selected && !c.provisional) || f.selected === null;
  $('cancel').disabled = !busy && !reviewBusy;
  renderState();
}

function renderClips(f) {
  // Keep finalized row nodes alive across updates, including focused inputs.
  for (const row of [...$('clips').children]) {
    if (!f?.clips.includes(row.clip)) row.remove();
  }
  if (!f?.clips.length) $('clips').append(element('p', (f?.scores || f?.windowScores) ? '未发现超过阈值的枪声候选。可调阈值或添加手动范围。' : '完成识别后在这里复核，也可添加手动范围。', 'empty'));
  for (const [index, clip] of (f?.clips || []).entries()) {
    const existing = [...$('clips').children].find((row) => row.clip === clip);
    if (existing) {
      existing.querySelector('span').textContent = `${String(index + 1).padStart(2, '0')} · ${clip.manual ? '手动' : clip.provisional ? (f.status === '分析中' ? '处理中' : '未完成') : '可复核'}`;
      existing.querySelector('input').setAttribute('aria-label', `导出片段 ${index + 1}`);
      existing.querySelectorAll('input,button').forEach((node) => { node.disabled = clip.provisional || reviewBusy || (busy && !analyzing); });
      continue;
    }
    const row = element('div', undefined, 'clip'); row.clip = clip;
    const selected = element('input'); selected.type = 'checkbox'; selected.checked = clip.selected;
    selected.setAttribute('aria-label', `导出片段 ${index + 1}`);
    selected.onchange = () => { clip.selected = selected.checked; renderState(); };
    row.append(selected, element('span', `${String(index + 1).padStart(2, '0')} · ${clip.manual ? '手动' : clip.provisional ? (f.status === '分析中' ? '处理中' : '未完成') : '可复核'}`));
    for (const [key, label] of [['start', '起点'], ['end', '终点']]) {
      const input = element('input'); input.type = 'number'; input.min = 0; input.max = f.duration;
      input.step = 0.04; input.value = clip[key].toFixed(2);
      input.onchange = () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 0 || value > f.duration || (key === 'start' ? value >= clip.end : value <= clip.start)) {
          input.value = clip[key].toFixed(2); return;
        }
        clip[key] = value; clearPreview(); renderState();
      };
      const wrapper = element('label', `${label} `); wrapper.append(input); row.append(wrapper);
    }
    const preview = element('button', '预览'); preview.onclick = () => reviewPreview(f, clip);
    const remove = element('button', '移除'); remove.onclick = () => { if (clip.key) (f.removed ||= new Set()).add(clip.key); f.clips.splice(f.clips.indexOf(clip), 1); clearPreview(); render(); };
    row.append(preview, remove); row.querySelectorAll('input,button').forEach((node) => { node.disabled = clip.provisional || reviewBusy || (busy && !analyzing); });
    $('clips').append(row);
  }
}

async function reviewPreview(f, clip) {
  if (reviewBusy || clip.provisional || (busy && !analyzing)) return;
  if (!busy) return run(() => makePreview(f, { ...clip }));
  reviewBusy = true; render();
  try { await makePreview(f, { ...clip }); }
  catch (error) { note(cancelled ? '预览已取消' : `预览失败：${errorText(error)}`); }
  finally { reviewBusy = false; conversion = null; render(); }
}

async function run(action) {
  if (busy || reviewBusy) return;
  busy = true; cancelled = false; $('progress').value = 0; render();
  try { return await action(); }
  catch (error) { note(cancelled ? '已取消；已完成的录像和导出保留。' : `未完成：${errorText(error)}`); }
  finally { busy = false; analyzing = false; if (!reviewBusy) conversion = null; render(); }
}

function checkCancelled() { if (cancelled) throw new Error('已取消'); }

function infer(waveform) {
  if (!worker) {
    worker = new Worker('./inference-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') {
        if (data.progress === null) $('progress').removeAttribute('value');
        else if (typeof data.progress === 'number') $('progress').value = data.progress;
        note(data.message); return;
      }
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.type === 'error') request?.reject(new Error(data.message));
      else { lastWindowTiming = data.timings; request?.resolve(data.values); }
    };
    worker.onerror = (error) => {
      for (const request of pending.values()) request.reject(new Error(error.message));
      pending.clear(); worker.terminate(); worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++nextRequest;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, waveform, model: modelKey() }, [waveform.buffer]);
  });
}

async function importFiles(incoming) {
  for (const file of incoming) {
    checkCancelled();
    note(`正在读取 ${file.name} 的轨道信息…`);
    const importStarted = performance.now();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      const tracks = await input.getAudioTracks();
      if (!video || !tracks.length) throw new Error('需要同时包含视频和音轨的文件');
      const origin = Math.max(0, await video.getFirstTimestamp());
      const duration = (await video.computeDuration()) - origin;
      if (!(duration > 0)) throw new Error('无法确定有效视频时长');
      const id = crypto.randomUUID();
      files.push({ id, file, input, video, tracks, origin, duration, selected: null, status: '待选音轨', clips: [], importMs: performance.now() - importStarted });
      activeId = id; clearPreview();
    } catch (error) { input.dispose(); note(`${file.name}：${errorText(error)}`); }
  }
  render();
  note('请为每份录像确认包含游戏声音的音轨，再开始分析。');
}

async function audioWindow(track, start, length = 10) {
  const context = new OfflineAudioContext(1, metadata.sampleRate * length, metadata.sampleRate);
  const sink = new MB.AudioBufferSink(track);
  let samples = 0;
  for await (const { buffer, timestamp } of sink.buffers(start, start + length)) {
    checkCancelled();
    const offset = Math.max(0, start - timestamp);
    const when = Math.max(0, timestamp - start);
    const duration = Math.min(buffer.duration - offset, length - when);
    if (duration <= 0) continue;
    const source = context.createBufferSource(); source.buffer = buffer;
    source.connect(context.destination); source.start(when, offset, duration); samples++;
  }
  if (!samples) throw new Error('该窗口未解码出音频');
  return (await context.startRendering()).getChannelData(0);
}

function candidates(f, frontier = Infinity) {
  const threshold = Number($('threshold').value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('阈值须在 0 到 1 之间');
  if (f.windowScores) {
    const hits = f.windowScores.filter((w) => Math.max(...w.scores) > threshold);
    return mergeEvents(f, hits.map((w) => ({ start: w.start, end: w.end })), frontier);
  }
  const n = f.scores.length / 2;
  const smooth = (i, k) => [f.scores[Math.max(0, i - 1) * 2 + k], f.scores[i * 2 + k], f.scores[Math.min(n - 1, i + 1) * 2 + k]].sort((a, b) => a - b)[1];
  const events = [];
  let start = null;
  for (let i = 0; i <= n; i++) {
    const hit = i < n && (smooth(i, 0) > threshold || smooth(i, 1) > threshold);
    if (hit && start === null) start = i * 0.04;
    if (!hit && start !== null) { events.push({ start: start + f.audioOffset, end: Math.min(i * 0.04, f.audioDuration) + f.audioOffset }); start = null; }
  }
  return mergeEvents(f, events, frontier);
}

function mergeEvents(f, events, frontier) {
  const groups = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && event.start - last.end <= 5) last.end = event.end;
    else groups.push({ ...event });
  }
  return groups.map((g) => ({ key: `event-${g.start.toFixed(6)}`, provisional: frontier <= g.end + 5, start: Math.max(0, g.start - 5), end: Math.min(f.duration, g.end + 5), selected: true, manual: false })).filter((g) => g.end > g.start);
}

function publishCandidates(f, frontier) {
  f.frontier = frontier;
  const preserved = f.clips.filter((c) => !c.provisional);
  const keys = new Set(preserved.map((c) => c.key));
  const incoming = candidates(f, frontier).filter((c) => !keys.has(c.key) && !f.removed?.has(c.key));
  f.clips = [...preserved, ...incoming];
  if (f.timings.firstReviewableMs === undefined && f.clips.some((c) => !c.manual && !c.provisional)) {
    f.timings.firstReviewableMs = performance.now() - f.analysisStarted;
  }
  render();
}

async function analyzeQueue(targets = files) {
  analyzing = true;
  await loadMetadata();
  const classIndices = ['Gunshot, gunfire', 'Machine gun'].map((name) => metadata.classes.indexOf(name));
  if (classIndices.some((i) => i < 0)) throw new Error('模型类别清单不匹配');
  for (const f of targets) {
    if (f.selected === null) throw new Error('请先确认所有音轨');
    if (f.status === '完成') continue;
    activeId = f.id; if (!reviewBusy) clearPreview(); f.status = '分析中'; f.error = null; f.scores = null; f.windowScores = null; f.clips = []; f.windows = 0; f.removed = new Set(); f.frontier = -Infinity;
    f.timings = { decodeMs: 0, readMs: 0, initializeMs: 0, frontendMs: 0, inferenceMs: 0, audioSetupMs: 0, audioWaitMs: 0, inferenceRoundTripMs: 0, postprocessAndRenderMs: 0, progressUiMs: 0, timingVersion: 2 };
    const analysisStarted = performance.now(); f.analysisStarted = analysisStarted; render();
    let stream, ahead, sparse;
    try {
      const setupStarted = performance.now();
      let track = f.tracks[f.selected], audioMB = MB;
      if ($('sparse-audio').checked && /\.(mkv|webm)$/i.test(f.file.name)) {
        sparse = await openSparseAudio(f.file, track.id, f.timings);
        track = sparse.track; audioMB = sparse.MB;
        f.timings.audioReader = 'experimental-sparse-mkv';
      }
      if (!await track.canDecode()) throw new Error(`浏览器无法解码 ${track.codec} 音轨`);
      const origin = Math.max(0, await track.getFirstTimestamp());
      f.audioDuration = (await track.computeDuration()) - origin;
      f.audioOffset = origin - f.origin;
      const sampleCount = Math.round(f.audioDuration * 16000);
      if (sampleCount <= 0) throw new Error('音轨没有有效采样');
      const small = metadata.scoreType === 'window';
      const windowScores = [];
      const frames = Math.ceil(sampleCount / 640);
      const sums = new Float32Array(frames * 2), counts = new Uint16Array(frames);
      const windows = Math.ceil(Math.max(0, sampleCount - 160000) / 80000) + 1;
      stream = sequentialAudio(audioMB, track, origin, f.audioDuration, metadata.sampleRate, checkCancelled, f.timings);
      // At most one future window overlaps the current model invocation.
      const prefetch = () => stream.next().then((value) => ({ value }), (error) => ({ error }));
      f.timings.audioSetupMs = performance.now() - setupStarted;
      ahead = prefetch();
      for (let i = 0; i < windows; i++) {
        const progressStarted = performance.now();
        checkCancelled(); note(`${f.file.name}：解码并识别第 ${i + 1} / ${windows} 个窗口`);
        f.timings.progressUiMs += performance.now() - progressStarted;
        const audioWaitStarted = performance.now();
        const decoded = await ahead;
        f.timings.audioWaitMs += performance.now() - audioWaitStarted;
        if (decoded.error) throw decoded.error;
        checkCancelled();
        const inferenceStarted = performance.now();
        const inference = infer(decoded.value);
        ahead = i + 1 < windows ? prefetch() : null;
        const values = await inference;
        f.timings.inferenceRoundTripMs += performance.now() - inferenceStarted;
        const postprocessStarted = performance.now();
        for (const key of ['readMs', 'initializeMs', 'frontendMs', 'inferenceMs']) f.timings[key] += lastWindowTiming[key];
        checkCancelled();
        if (small) {
          if (values.length !== metadata.classes.length || values.some((v) => !Number.isFinite(v))) throw new Error('窗口分数无效');
          windowScores.push({ start: i * 5 + f.audioOffset, end: Math.min(i * 5 + 10, f.audioDuration) + f.audioOffset,
            scores: classIndices.map((k) => values[k]) });
        } else {
          if (values.length !== 250 * 447 || values.some((v) => !Number.isFinite(v))) throw new Error('模型输出无效');
          for (let j = 0; j < 250 && i * 125 + j < frames; j++) {
            const frame = i * 125 + j;
            counts[frame]++;
            for (let k = 0; k < 2; k++) sums[frame * 2 + k] += values[j * 447 + classIndices[k]];
          }
        }
        f.windows = i + 1; $('progress').value = (i + 1) / windows;
        const complete = i + 1 === windows;
        if (small) f.windowScores = windowScores;
        else {
          // Future overlapping windows can only change frames at/after (i+1)*125.
          // Retain one extra finalized frame for median lookahead; publish conservatively.
          const stable = complete ? frames : Math.min(frames, (i + 1) * 125);
          f.scores = new Float32Array(stable * 2);
          for (let j = 0; j < stable; j++) for (let k = 0; k < 2; k++) f.scores[j * 2 + k] = sums[j * 2 + k] / counts[j];
        }
        const frontier = complete ? Infinity : (small ? (i + 1) * 5 : (f.scores.length / 2 - 1) * 0.04) + f.audioOffset;
        publishCandidates(f, frontier);
        f.timings.postprocessAndRenderMs += performance.now() - postprocessStarted;
      }
      const finalizeStarted = performance.now();
      if (small) f.windowScores = windowScores;
      else {
        if (counts.some((v) => v === 0)) throw new Error('分数时间轴有缺口');
        for (let j = 0; j < frames; j++) for (let k = 0; k < 2; k++) sums[j * 2 + k] /= counts[j];
        f.scores = sums;
      }
      publishCandidates(f, Infinity); f.status = '完成';
      f.timings.postprocessAndRenderMs += performance.now() - finalizeStarted;
      f.timings.totalMs = performance.now() - analysisStarted;
    } catch (error) {
      f.status = cancelled ? '已取消' : '失败'; f.error = errorText(error);
      if (cancelled) throw error;
      note(`${f.file.name}：${f.error}`);
    } finally {
      await ahead; // Settle the sole prefetched decode before releasing its iterator.
      try { await stream?.close(); } finally { sparse?.close(); }
    }
    render();
  }
  analyzing = false;
  note(`分析结束：${files.filter((f) => f.status === '完成').length} / ${files.length} 份完成。请复核候选范围。`);
}

async function convertClip(f, clip) {
  if (f.selected === null) throw new Error('请先确认音轨');
  const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
  conversion = await MB.Conversion.init({ input: f.input, output,
    trim: { start: f.origin + clip.start, end: f.origin + clip.end },
    video: (track) => track === f.video ? { codec: 'vp8', width: Math.min(1280, track.displayWidth), height: Math.min(720, track.displayHeight), fit: 'contain', bitrate: 2000000, forceTranscode: true } : { discard: true },
    audio: (track) => track === f.tracks[f.selected] ? { codec: 'opus', bitrate: 96000, forceTranscode: true } : { discard: true },
  });
  const discarded = conversion.discardedTracks.filter((entry) => entry.track === f.video || entry.track === f.tracks[f.selected]);
  if (!conversion.isValid || discarded.length) throw new Error(`浏览器无法完整导出所选声画轨：${discarded.map((d) => d.reason).join(', ')}`);
  conversion.onProgress = (value) => { if (!analyzing) $('progress').value = value; };
  await conversion.execute(); checkCancelled(); conversion = null;
  const blob = new Blob([output.target.buffer], { type: 'video/webm' });
  const probe = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  try {
    return { blob, measuredDuration: await probe.computeDuration() };
  } finally { probe.dispose(); }
}

async function makePreview(f, clip) {
  note(`正在生成 ${seconds(clip.start)}—${seconds(clip.end)} 的预览…`);
  const { blob, measuredDuration } = await convertClip(f, clip);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob); $('player').src = previewUrl;
  $('preview-label').textContent = `${f.file.name} · 音轨 ${f.selected + 1} · ${seconds(clip.start)}—${seconds(clip.end)} · 读回约 ${seconds(measuredDuration)}`;
  note('预览已就绪。播放检查画面和所选音轨。');
  return blob;
}

async function exportSelected() {
  const f = active();
  for (const [i, clip] of f.clips.entries()) {
    if (!clip.selected || clip.provisional) continue;
    checkCancelled(); note(`正在导出片段 ${i + 1}：${seconds(clip.start)}—${seconds(clip.end)}`);
    const started = performance.now();
    const { blob, measuredDuration } = await convertClip(f, clip);
    const exportMs = performance.now() - started;
    const name = `${f.file.name.replace(/\.[^.]+$/, '')}-${modelKey()}-track${f.selected + 1}-${String(i + 1).padStart(2, '0')}.webm`;
    const url = URL.createObjectURL(blob); downloads.push({ name, model: modelKey(), start: clip.start, end: clip.end, url, bytes: blob.size, requestedDuration: clip.end - clip.start, measuredDuration, exportMs });
    const link = element('a', `下载 ${name} · 读回约 ${seconds(measuredDuration)} · ${(blob.size / 1048576).toFixed(2)} MiB · 导出 ${(exportMs / 1000).toFixed(3)} 秒`);
    link.href = url; link.download = name; $('downloads').append(link); renderState();
  }
  note('导出完成，点击预览区的下载链接保存。');
}

async function demo() {
  note('正在浏览器中生成带两条音轨的 12 秒合成视频…');
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
  const video = new MB.CanvasSource(canvas, { codec: 'vp8', bitrate: 600000 });
  const audio = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
  const second = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
  output.addVideoTrack(video, { frameRate: 12 }); output.addAudioTrack(audio, { name: '合成脉冲 · 链路样本' }); output.addAudioTrack(second, { name: '440 Hz · 音轨对照' });
  await output.start();
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
  const tone = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 12, sampleRate: 48000 });
  let seed = 12345;
  for (let i = 0; i < buffer.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const t = i / 48000;
    buffer.getChannelData(0)[i] = t % 2 < 0.12 ? ((seed >>> 0) / 4294967296 - 0.5) * 0.6 * Math.exp(-30 * (t % 2)) : 0;
    tone.getChannelData(0)[i] = 0.08 * Math.sin(2 * Math.PI * 440 * t);
  }
  await audio.add(buffer); await second.add(tone);
  for (let i = 0; i < 144; i++) {
    checkCancelled(); ctx.fillStyle = '#101b22'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#afedc9'; ctx.fillRect(30 + (i * 3) % 500, 240, 80, 10);
    ctx.font = '24px sans-serif'; ctx.fillText('BROWSER / SYNTHETIC SAMPLE', 30, 65);
    ctx.font = '64px monospace'; ctx.fillText(`${(i / 12).toFixed(2)} s`, 30, 165);
    ctx.font = '16px sans-serif'; ctx.fillText('Two audio tracks. No real gunfire.', 30, 310);
    await video.add(i / 12, 1 / 12);
  }
  video.close(); audio.close(); second.close(); await output.finalize();
  await importFiles([new File([output.target.buffer], 'browser-synthetic.webm', { type: 'video/webm' })]);
}

async function compareDecoding() {
  const f = active();
  if (!f || f.selected === null) throw new Error('请先导入录像并确认音轨');
  await loadMetadata();
  const track = f.tracks[f.selected];
  const origin = Math.max(0, await track.getFirstTimestamp());
  const duration = await track.computeDuration() - origin;
  const windows = Math.ceil(Math.max(0, Math.round(duration * 16000) - 160000) / 80000) + 1;
  const indices = new Set([0, 1, Math.floor(windows / 2), windows - 1].filter((i) => i < windows));
  const metrics = { decodeMs: 0 };
  const stream = sequentialAudio(MB, track, origin, duration, metadata.sampleRate, checkCancelled, metrics);
  const report = { date: new Date().toISOString(), source: f.file.name, model: metadata.model, duration, windows, metrics, comparisons: [] };
  let previousTail;
  // Independent 20-second continuous render checks the five-second stitching boundary.
  try {
    const referenceBlocks = [];
    for await (const block of new MB.AudioBufferSink(track).buffers(origin, origin + 20)) { checkCancelled(); referenceBlocks.push(block); }
    const continuous = await renderContinuous(referenceBlocks, origin, 20, metadata.sampleRate);
    for (let i = 0; i < windows; i++) {
      checkCancelled();
      const waveform = await stream.next();
      if (previousTail && waveform.subarray(0, previousTail.length).some((v, j) => v !== previousTail[j])) throw new Error('重叠音频没有精确复用');
      previousTail = waveform.slice(metadata.sampleRate * 5);
      if (indices.has(i)) {
        const legacy = await audioWindow(track, origin + i * 5);
        let max = 0, sum = 0, interiorMax = 0, continuousMax = 0;
        for (let j = 0; j < legacy.length; j++) { const d = waveform[j] - legacy[j]; max = Math.max(max, Math.abs(d)); sum += d*d;
          if (j >= metadata.sampleRate * 0.1 && j < legacy.length - metadata.sampleRate * 0.1) interiorMax = Math.max(interiorMax, Math.abs(d));
          if (i < 2) continuousMax = Math.max(continuousMax, Math.abs(waveform[j] - continuous[i * metadata.sampleRate * 5 + j])); }
        const oldScores = await infer(legacy), newScores = await infer(waveform);
        let scoreMax = 0;
        for (let j = 0; j < oldScores.length; j++) scoreMax = Math.max(scoreMax, Math.abs(oldScores[j] - newScores[j]));
        report.comparisons.push({ window: i, waveformMaxAbsoluteError: max, waveformRmsError: Math.sqrt(sum / (metadata.sampleRate * 10)), interiorMaxAbsoluteError: interiorMax, continuous20sMaxAbsoluteError: i < 2 ? continuousMax : null, scoreMaxAbsoluteError: scoreMax });
      }
      $('progress').value = (i + 1) / windows;
      note(`顺序解码对照：${i + 1} / ${windows} 窗口；重叠音频逐采样一致`);
    }
    report.overlapExactlyEqual = true;
    report.continuousRenderPassed = report.comparisons.filter((c) => c.continuous20sMaxAbsoluteError !== null).every((c) => c.continuous20sMaxAbsoluteError < 0.0001);
    $('decode-result').textContent = JSON.stringify(report, null, 2);
    const link = element('a', '下载解码对照报告');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    link.download = 'apex-browser-sequential-decode.json'; $('decode-download').replaceChildren(link);
    note('顺序解码对照完成；误差记录见报告，不能据此宣布识别质量相等。');
  } finally { await stream.close(); }
}

async function reference() {
  note('正在比较浏览器模型与固定 Python 基准…');
  await loadMetadata();
  const waveform = new Float32Array(await (await fetch(`${assetRoot()}/reference-waveform.f32`)).arrayBuffer());
  const expected = new Float32Array(await (await fetch(`${assetRoot()}/reference-probabilities.f32`)).arrayBuffer());
  const values = await infer(waveform);
  let max = 0;
  if (values.length !== expected.length) throw new Error('基准输出形状不一致');
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error('模型输出存在非有限数');
    max = Math.max(max, Math.abs(values[i] - expected[i]));
  }
  lastReference = { values: values.length, maxAbsoluteError: max, passed: max <= 0.001 };
  $('reference-status').textContent = `${lastReference.passed ? '通过' : '未通过'}：${values.length} 个分数，最大绝对误差 ${max}。仅覆盖此合成输入。`;
  note($('reference-status').textContent); return lastReference;
}

async function benchmark() {
  await loadMetadata();
  const report = { date: new Date().toISOString(), userAgent: navigator.userAgent,
    backend: 'onnxruntime-web 1.23.2 / WASM CPU / 1 thread',
    source: 'localhost HTTP, no-store; fresh Worker is cold session, OS disk cache not flushed',
    model: metadata.model, modelBytes: metadata.bytes, cold: [], warm: [], media: [] };
  const waveform = new Float32Array(await (await fetch(`${assetRoot()}/reference-waveform.f32`)).arrayBuffer());
  const expected = new Float32Array(await (await fetch(`${assetRoot()}/reference-probabilities.f32`)).arrayBuffer());
  const restartWorker = () => { worker?.terminate(); worker = null; };
  for (const mode of ['cold', 'warm']) {
    for (let i = 0; i < 3; i++) {
      checkCancelled();
      if (mode === 'cold') restartWorker();
      $('benchmark-result').textContent = `正在测量 ${mode} ${i + 1}/3…`;
      const started = performance.now();
      const values = await infer(waveform.slice());
      const totalMs = performance.now() - started;
      let maxAbsoluteError = 0;
      for (let j = 0; j < values.length; j++) maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(values[j] - expected[j]));
      if (values.length !== expected.length || !Number.isFinite(maxAbsoluteError) || maxAbsoluteError > 0.001) throw new Error('耗时测试中的模型精度校验未通过');
      report[mode].push({ ...lastWindowTiming, totalMs, maxAbsoluteError });
    }
  }
  checkCancelled(); await demo();
  const f = active();
  if (f.file.name !== 'browser-synthetic.webm') throw new Error('合成样本未就绪');
  // Only the generated fixture is auto-selected; user files retain explicit track confirmation.
  f.selected = 0;
  for (const mode of ['cold', 'warm']) {
    checkCancelled();
    if (mode === 'cold') restartWorker();
    f.status = '待分析';
    await analyzeQueue([f]);
    if (f.status !== '完成') throw new Error(f.error || '合成视频分析未完成');
    report.media.push({ mode, duration: f.audioDuration, windows: f.windows, ...f.timings });
  }
  const started = performance.now();
  const result = await convertClip(f, { start: 0, end: 5 });
  report.export = { duration: 5, totalMs: performance.now() - started, bytes: result.blob.size, width: 640, height: 360 };
  const median = (rows, key) => rows.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const sec = (ms) => `${(ms / 1000).toFixed(3)} 秒`;
  $('benchmark-result').textContent = [
    '测试完成（模型冷／热各 3 次取中位数；视频分析及导出各单次）：',
    `模型读取：${sec(median(report.cold, 'readMs'))}`,
    `特征提取（热）：${sec(median(report.warm, 'frontendMs'))}`,
    `WASM 初始化：${sec(median(report.cold, 'initializeMs'))}`,
    `首次 10 秒窗口推理：${sec(median(report.cold, 'inferenceMs'))}`,
    `冷启动到首个结果：${sec(median(report.cold, 'totalMs'))}`,
    `复用模型 10 秒窗口推理：${sec(median(report.warm, 'inferenceMs'))}`,
    ...report.media.map((r) => `12 秒视频分析（${r.mode}，2 窗口）：${sec(r.totalMs)}；解码 ${sec(r.decodeMs)}`),
    `导出 5 秒 640×360 WebM：${sec(report.export.totalMs)}`,
    '本机 HTTP 读取，不代表公网下载速度；合成短片，不代表长录像性能。',
  ].join('\n');
  const link = element('a', '下载耗时报告');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  link.download = 'apex-browser-benchmark.json'; $('benchmark-download').replaceChildren(link);
  note('耗时测试完成，详见下方“耗时测试”。');
}

$('model').onchange = () => {
  worker?.terminate(); worker = null; metadata = null; lastReference = null;
  clearPreview();
  for (const f of files) {
    f.scores = null; f.windowScores = null; f.timings = null; f.clips = []; f.windows = 0; f.error = null;
    f.status = f.selected === null ? '待选音轨' : '待分析';
  }
  $('reference-status').textContent = '尚未验证当前模型。';
  $('benchmark-result').textContent = ''; $('benchmark-download').replaceChildren();
  $('model-note').textContent = modelKey() === 'efficientat'
    ? 'EfficientAT mn04_as：10 秒窗口、5 秒步长，窗口级粗定位。阈值 0.2 仅作试验起点，尚未校准。'
    : 'BEATs：40 毫秒帧分数，10 秒窗口、5 秒步长。';
  $('threshold').value = '0.2';
  note('已切换模型，旧识别结果清空；请重新分析。'); render();
};
$('files').onchange = () => { const incoming = [...$('files').files]; $('files').value = ''; run(() => importFiles(incoming)); };
$('demo').onclick = () => run(demo);
$('analyze').onclick = () => run(analyzeQueue);
$('decode-reference').onclick = () => run(compareDecoding);
$('reference').onclick = () => run(reference);
$('benchmark').onclick = () => run(benchmark);
$('analysis-report').onclick = () => {
  const f = active();
  if (!f) return;
  const report = { date: new Date().toISOString(), userAgent: navigator.userAgent,
    model: metadata?.model, backend: 'WASM CPU / 1 thread',
    source: { name: f.file.name, bytes: f.file.size, width: f.video.displayWidth, height: f.video.displayHeight, duration: f.duration, selectedAudioIndex: f.selected, importMs: f.importMs },
    status: f.status, windows: f.windows, finalizedBefore: Number.isFinite(f.frontier) ? f.frontier : null, removedCandidateKeys: [...(f.removed || [])], scoreFrames: f.scores?.length / 2, windowScores: f.windowScores, timings: f.timings,
    browserReference: lastReference, modelSha256: metadata?.sha256,
    threshold: Number($('threshold').value), clips: f.clips,
    exports: downloads.map(({ url, ...record }) => record) };
  const link = element('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  link.download = `apex-browser-${modelKey()}-analysis-report.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 60000);
};
$('result-file').onchange = () => { activeId = $('result-file').value; clearPreview(); render(); };
$('manual').onclick = () => { const f = active(); f.clips.push({ start: 0, end: Math.min(5, f.duration), selected: true, manual: true }); render(); };
$('recompute').onclick = () => { try { active().removed = new Set(); active().clips = candidates(active(), active().status === '完成' ? Infinity : (active().frontier ?? -Infinity)); clearPreview(); note('已按当前阈值重新生成候选，原手动修改已替换。'); render(); } catch (error) { note(errorText(error)); } };
$('export').onclick = () => run(exportSelected);
$('cancel').onclick = () => {
  cancelled = true; worker?.terminate(); worker = null;
  for (const request of pending.values()) request.reject(new Error('已取消'));
  pending.clear(); conversion?.cancel(); note('正在取消…');
};
const guides = {
  happy: '生成合成样本或导入录像 → 选择音轨 → 开始分析 → 预览候选 → 导出。没有候选时，添加手动范围验证导出。',
  tracks: '生成合成样本 → 选第一条脉冲音轨 → 添加手动范围并预览。再选第二条 440 Hz 音轨，旧结果清空；重新添加范围并预览，听取差异。',
  cancel: '开始分析 → 点击取消 → 检查文件标为“已取消”且未出现完整结果 → 再次开始分析，重新处理该文件；已完成文件保留。',
};
$('walkthroughs').onclick = (event) => { if (event.target.dataset.guide) $('guide').textContent = guides[event.target.dataset.guide]; };
$('capabilities').textContent = `音频解码 ${typeof AudioDecoder !== 'undefined' ? '✓' : '✗'} · 视频编码 ${typeof VideoEncoder !== 'undefined' ? '✓' : '✗'} · 隔离上下文 ${crossOriginIsolated ? '✓' : '✗'}`;
note('就绪。所有媒体处理和推理在浏览器内执行；模型按需加载。'); render();
// Only exposed in this explicitly throwaway route, for reproducible manual smoke checks.
window.prototypeApi = { run, demo, reference, importFiles, analyzeQueue, makePreview, exportSelected, files, downloads, active, render, get busy() { return busy; } };

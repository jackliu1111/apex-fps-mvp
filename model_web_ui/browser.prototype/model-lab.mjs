import * as MB from '/assets/vendor/mediabunny.mjs';
import { createMediaReadSource } from './media-read-source.mjs';
import { sequentialAudio } from './stream-audio.js';
import { chooseAudioTracks } from './browser-analysis.mjs';
import { createSourcePlayer } from './source-player.mjs';
import { FrameOverlap, ScoreStatistics, displayWeights, writeFile, writeJson } from './lab-scores.mjs';
import { DISPLAY_GROUPS, createDisplayGrouping } from './lab-display-groups.mjs';

const $ = id => document.getElementById(id);
const time = n => `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toFixed(2).padStart(5, '0')}`;
const color = id => DISPLAY_GROUPS[id].color;
let file, rootDirectory, runDirectory, scoresDirectory, run, statistics, overview, overviewCounts, binFrames;
let busy = false, controller, worker, requestId = 0, pending = new Map(), selectedTime = 0;
let inspectRevision = 0, cachedBlock;
let groupScores;
const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
const safe = fn => async (...args) => { try { await fn(...args); } catch (error) { status(error.message || String(error), true); } };
const player = createSourcePlayer({ MB, canvas: $('video'), onState(s) {
  $('clock').textContent = time(s.position);
  $('seek').max = s.duration || 1;
  $('seek').value = s.position;
  if (s.error) status(s.error, true);
} });
function controls() {
  $('start').disabled = busy || !file || !rootDirectory;
  $('cancel').disabled = !busy || !controller;
  for (const id of ['directory', 'open-run', 'file', 'limit', 'benchmark']) $(id).disabled = busy;
  $('recompute').disabled = busy || !run?.chunks?.length;
}
function stopWorker() {
  worker?.terminate(); worker = null;
  for (const { reject } of pending.values()) reject(new DOMException('推理已停止', 'AbortError'));
  pending.clear();
}
function ask(type, data = {}, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./lab-inference-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const waiting = pending.get(data.id); if (!waiting) return;
      pending.delete(data.id);
      if (data.error) waiting.reject(new Error(data.error)); else waiting.resolve(data);
    };
    worker.onerror = event => { const error = new Error(event.message); for (const p of pending.values()) p.reject(error); pending.clear(); stopWorker(); };
  }
  const id = ++requestId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ type, id, ...data }, transfer); });
}
function initializeOverview() {
  binFrames = Math.max(5, Math.ceil(run.totalFrames / 5000));
  const bins = Math.ceil(run.totalFrames / binFrames);
  groupScores = createDisplayGrouping(run.classes);
  overview = new Float32Array(bins * DISPLAY_GROUPS.length); overviewCounts = new Uint16Array(bins);
  cachedBlock = null;
}
function addOverview(block) {
  const c = run.classes.length;
  for (let f = 0; f < block.frameCount; f++) {
    const bin = Math.floor((block.startFrame + f) / binFrames);
    const grouped = groupScores(block.values.subarray(f * c, (f + 1) * c));
    for (let k = 0; k < grouped.length; k++) overview[bin * grouped.length + k] += grouped[k];
    overviewCounts[bin]++;
  }
}
function parameters() {
  const threshold = Number($('threshold').value), temperature = Number($('temperature').value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 || !Number.isFinite(temperature) || temperature <= 0) throw new Error('阈值须在 0–1，温度须大于 0');
  return { threshold, temperature };
}
function drawTimeline() {
  if (!run || !overview) return;
  const { threshold, temperature } = parameters();
  const canvas = $('timeline'), ctx = canvas.getContext('2d'), c = DISPLAY_GROUPS.length, bins = overviewCounts.length;
  ctx.fillStyle = '#edf0f4'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let bin = 0; bin < bins; bin++) {
    if (!overviewCounts[bin]) continue;
    const scores = overview.slice(bin * c, (bin + 1) * c).map(v => v / overviewCounts[bin]);
    const items = displayWeights(scores, threshold, temperature);
    let y = 0;
    for (const item of items) {
      ctx.fillStyle = color(item.id);
      const h = canvas.height * item.weight;
      ctx.fillRect(bin / bins * canvas.width, y, Math.ceil(canvas.width / bins), h);
      y += h;
    }
  }
  ctx.fillStyle = '#172c40'; ctx.fillRect(selectedTime / run.analysisDuration * canvas.width, 0, 1.5, canvas.height);
  $('end-time').textContent = time(run.analysisDuration);
  $('legend').replaceChildren(...DISPLAY_GROUPS.map((group, id) => {
    const span = document.createElement('span'), swatch = document.createElement('i'); swatch.className = 'swatch'; swatch.style.background = color(id);
    span.append(swatch, group.name); span.title = group.labels.join(' / '); return span;
  }));
}
function renderStatistics() {
  if (!statistics) return;
  const report = statistics.report();
  $('stats-note').textContent = `统计阈值 ${report.threshold} · ${report.frames.toLocaleString()} 帧 · 展示前 50 类，文件保留全部 ${run.classes.length} 类`;
  $('stats').replaceChildren(...report.rows.slice(0, 50).map(row => {
    const tr = document.createElement('tr');
    for (const text of [row.name, `${(row.coverage * 100).toFixed(1)}%`, row.coveredSeconds.toFixed(2), row.segments, row.mean.toFixed(3), row.peak.toFixed(3)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    const td = document.createElement('td'), button = document.createElement('button'); button.textContent = time(row.peakTime + run.audioOffset);
    button.onclick = safe(() => inspect(row.peakTime, true)); td.append(button); tr.append(td); return tr;
  }));
  $('details').textContent = JSON.stringify({ timings: run.timings, scoreBytes: run.chunks.reduce((n, x) => n + x.bytes, 0),
    source: run.source, model: run.model, status: run.status,
    topCooccurrence: report.cooccurrence.slice(0, 20).map(x => ({ a: run.classes[x.a], b: run.classes[x.b], seconds: +x.seconds.toFixed(2) })) }, null, 2);
}
async function readBlock(chunk) {
  const handle = await scoresDirectory.getFileHandle(chunk.file);
  const bytes = await (await handle.getFile()).arrayBuffer();
  if (bytes.byteLength !== chunk.bytes) throw new Error(`分数文件长度不匹配：${chunk.file}`);
  return { ...chunk, values: new Float32Array(bytes) };
}
async function inspect(seconds, seek = false) {
  if (!run) return;
  const rev = ++inspectRevision;
  selectedTime = Math.max(0, Math.min(seconds, run.analysisDuration - .001));
  drawTimeline();
  if (seek && file) await player.seek(selectedTime + run.audioOffset);
  if (rev !== inspectRevision) return;
  const frame = Math.floor(selectedTime / run.frameSeconds + 1e-9);
  const chunk = run.chunks.find(x => frame >= x.startFrame && frame < x.startFrame + x.frameCount);
  if (!chunk) { $('frame-scores').textContent = '该位置尚未分析'; return; }
  if (cachedBlock?.file !== chunk.file) cachedBlock = await readBlock(chunk);
  if (rev !== inspectRevision) return;
  const c = run.classes.length, at = (frame - chunk.startFrame) * c;
  const scores = cachedBlock.values.subarray(at, at + c);
  $('frame-time').textContent = `${time(frame * run.frameSeconds + run.audioOffset)} · 第 ${frame} 帧`;
  const all = Array.from(groupScores(scores), (score, id) => ({ id, score })).sort((a, b) => b.score - a.score);
  $('frame-scores').replaceChildren(...all.filter(x => x.score >= parameters().threshold).map(item => {
    const row = document.createElement('div'); row.className = 'score-row';
    const dot = document.createElement('i'); dot.className = 'swatch'; dot.style.background = color(item.id);
    const name = document.createElement('span'); name.textContent = DISPLAY_GROUPS[item.id].name;
    row.title = DISPLAY_GROUPS[item.id].labels.filter(label => run.classes.includes(label)).map(label => `${label}: ${scores[run.classes.indexOf(label)].toFixed(4)}`).join('\n');
    const score = document.createElement('strong'); score.textContent = item.score.toFixed(4);
    row.append(dot, name, score); return row;
  }));
  if (!$('frame-scores').children.length) $('frame-scores').textContent = `五类声音均未超过阈值；最高 ${DISPLAY_GROUPS[all[0].id].name} ${all[0].score.toFixed(4)}`;
}
async function setFile(selected) {
  file = selected;
  if (!file) return;
  if (run && (file.name !== run.source.name || file.size !== run.source.size || file.lastModified !== run.source.lastModified)) {
    run = null; statistics = null; overview = null; cachedBlock = null;
    $('stats').replaceChildren(); $('frame-scores').textContent = '已切换录像，等待分析';
    $('legend').replaceChildren(); $('details').textContent = ''; $('stats-note').textContent = '未分析';
    const canvas = $('timeline'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    $('end-time').textContent = '—'; $('progress').value = 0;
  }
  $('filename').textContent = `${file.name} · ${(file.size / 1024 ** 3).toFixed(2)} GiB`;
  await player.load({ file }); $('play').disabled = false; controls();
}
async function analyze() {
  if (busy || !file || !rootDirectory) return;
  busy = true; controller = new AbortController(); controls();
  let input, stream;
  const started = performance.now();
  try {
    const { threshold } = parameters();
    status('正在校验模型并初始化浏览器 WASM…');
    stopWorker(); const initialized = await ask('init'); controller.signal.throwIfAborted();
    const manifest = initialized.manifest;
    input = new MB.Input({ source: createMediaReadSource({ MB, file }), formats: MB.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const origin = video ? Math.max(0, await video.getFirstTimestamp()) : 0;
    const tracks = await input.getAudioTracks(), chosen = await chooseAudioTracks(input, tracks), track = tracks[chosen.selected];
    const audioOrigin = Math.max(0, await track.getFirstTimestamp());
    const duration = await track.computeDuration() - audioOrigin;
    const limit = Number($('limit').value), analysisDuration = limit > 0 ? Math.min(limit, duration) : duration;
    if (!(analysisDuration > 0) || !Number.isFinite(analysisDuration)) throw new Error('无有效音频时长');
    const name = `efficientsed-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 6)}`;
    runDirectory = await rootDirectory.getDirectoryHandle(name, { create: true });
    scoresDirectory = await runDirectory.getDirectoryHandle('scores', { create: true });
    run = { schema: 'apex-audio-lab-v1', status: 'running', directory: name, createdAt: new Date().toISOString(),
      source: { name: file.name, size: file.size, lastModified: file.lastModified },
      model: manifest, classes: manifest.classes, frameSeconds: manifest.frameSeconds,
      windowSeconds: manifest.windowSeconds, strideSeconds: manifest.strideSeconds,
      analysisDuration, audioOffset: audioOrigin - origin, audioTrack: chosen.selected, audioPolicy: chosen.audioPolicy,
      totalFrames: Math.ceil(analysisDuration / manifest.frameSeconds),
      format: 'little-endian float32, row-major [frame,class], sigmoid then overlap mean; no temporal smoothing, threshold or softmax applied',
      chunks: [], timings: { initializeMs: initialized.initializeMs, frontendMs: 0, inferenceMs: 0, decodeMs: 0, writeMs: 0 }, display: parameters() };
    await writeJson(runDirectory, 'run.json', run);
    selectedTime = 0; initializeOverview(); statistics = new ScoreStatistics(run.classes, threshold, run.frameSeconds, analysisDuration);
    const overlap = new FrameOverlap(run.classes.length, run.totalFrames);
    const windows = Math.ceil(Math.max(0, analysisDuration - 10) / 5) + 1;
    stream = sequentialAudio(MB, track, audioOrigin, analysisDuration, manifest.sampleRate, () => controller.signal.throwIfAborted(), run.timings);
    for (let index = 0; index < windows; index++) {
      controller.signal.throwIfAborted();
      status(`正在分析 ${index + 1}/${windows} 窗口 · 已保存 ${(overlap.cursor * .04).toFixed(1)} 秒 · ${name}`);
      const waveform = await stream.next();
      const result = await ask('infer', { waveform }, [waveform.buffer]); controller.signal.throwIfAborted();
      run.timings.frontendMs += result.frontendMs; run.timings.inferenceMs += result.inferenceMs;
      const block = overlap.push(result.values, index === windows - 1);
      const blockName = `${String(block.startFrame).padStart(8, '0')}.f32`;
      const writeStart = performance.now();
      await writeFile(scoresDirectory, blockName, block.values);
      run.chunks.push({ file: blockName, startFrame: block.startFrame, frameCount: block.frameCount, bytes: block.values.byteLength });
      run.timings.writeMs += performance.now() - writeStart;
      await writeJson(runDirectory, 'run.json', run);
      statistics.add(block); addOverview(block);
      $('progress').value = (index + 1) / windows;
      drawTimeline(); if (index % 5 === 0 || index === windows - 1) renderStatistics();
    }
    if (overlap.cursor !== run.totalFrames) throw new Error('保存的时间轴帧数不完整');
    run.status = 'complete'; run.timings.totalMs = performance.now() - started;
    await writeJson(runDirectory, 'statistics.json', statistics.report());
    await writeJson(runDirectory, 'run.json', run);
    renderStatistics(); await inspect(0);
    status(`分析完成并已保存 · ${name} · ${(run.timings.totalMs / 1000).toFixed(1)} 秒 · ${run.totalFrames.toLocaleString()} 帧 / ${run.classes.length} 类`);
  } catch (error) {
    if (run?.status === 'running') {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'; run.error = String(error.message || error);
      run.timings.totalMs = performance.now() - started;
      try { await writeJson(runDirectory, 'run.json', run); if (statistics) await writeJson(runDirectory, 'statistics.json', statistics.report()); }
      catch (saveError) { run.error += `；保存错误状态也失败：${saveError.message}`; }
    }
    status(controller.signal.aborted ? '已停止，完整写入的分数块保留在实验目录。' : `分析失败：${run?.error || error.message}`, true);
  } finally {
    try { await stream?.close(); } finally { input?.dispose(); stopWorker(); controller = null; busy = false; controls(); }
  }
}
async function recompute(save = true) {
  if (busy || !run) return;
  busy = true; controls();
  try {
    statistics = new ScoreStatistics(run.classes, parameters().threshold, run.frameSeconds, run.analysisDuration);
    initializeOverview();
    for (const chunk of run.chunks) { const block = await readBlock(chunk); statistics.add(block); addOverview(block); }
    if (save) {
      run.display = parameters(); await writeJson(runDirectory, 'statistics.json', statistics.report()); await writeJson(runDirectory, 'run.json', run);
    }
    drawTimeline(); renderStatistics(); await inspect(selectedTime);
    status(save ? '已从外置盘原始分数重算并保存，无需重新推理。' : '已打开实验结果；选择原录像即可定位试听。');
  } finally { busy = false; controls(); }
}
async function openRun() {
  const dir = await window.showDirectoryPicker({ id: 'apex-model-lab-open', mode: 'readwrite' });
  const meta = JSON.parse(await (await (await dir.getFileHandle('run.json')).getFile()).text());
  if (meta.schema !== 'apex-audio-lab-v1' || !meta.classes?.length || !Array.isArray(meta.chunks)) throw new Error('不是模型实验目录');
  runDirectory = dir; scoresDirectory = await dir.getDirectoryHandle('scores'); run = meta;
  if (file && (file.name !== run.source.name || file.size !== run.source.size || file.lastModified !== run.source.lastModified)) {
    file = null; $('file').value = ''; $('filename').textContent = '请重新选择该实验对应录像'; await player.dispose(); $('play').disabled = true;
  }
  selectedTime = 0; $('threshold').value = run.display?.threshold ?? .2; $('temperature').value = run.display?.temperature ?? 1;
  await recompute(false);
}
async function benchmark() {
  if (busy) return;
  busy = true; controls();
  try {
    status('对照真实录像参考音频：浏览器前处理 + WASM 与 PyTorch…');
    stopWorker(); await ask('init');
    const fetchFloat = async name => { const r = await fetch(`/assets/efficientsed/${name}`); if (!r.ok) throw new Error(`缺少参考文件 ${name}`); return new Float32Array(await r.arrayBuffer()); };
    const waveform = await fetchFloat('reference-waveform.f32'), expected = await fetchFloat('reference-probabilities.f32');
    const result = await ask('infer', { waveform }, [waveform.buffer]);
    if (expected.length !== result.values.length) throw new Error('数值自检输出尺寸不一致');
    let maxError = 0;
    for (let i = 0; i < expected.length; i++) maxError = Math.max(maxError, Math.abs(expected[i] - result.values[i]));
    const report = { passed: maxError < 1e-3, maxError, values: expected.length, frontendMs: result.frontendMs, inferenceMs: result.inferenceMs, browser: navigator.userAgent };
    window.modelLab.benchmarkResult = report;
    if (rootDirectory) await writeJson(rootDirectory, 'browser-benchmark.json', report);
    status(`数值自检${report.passed ? '通过' : '失败'} · ${expected.length} 个分数 · 最大误差 ${maxError.toExponential(3)}`, !report.passed);
    return report;
  } finally { stopWorker(); busy = false; controls(); }
}
$('file').onchange = safe(() => setFile($('file').files[0]));
$('directory').onclick = safe(async () => { rootDirectory = await window.showDirectoryPicker({ id: 'apex-model-lab-results', mode: 'readwrite' }); $('dirname').textContent = rootDirectory.name; controls(); });
$('start').onclick = safe(analyze);
$('cancel').onclick = () => { controller?.abort(); stopWorker(); };
$('open-run').onclick = safe(openRun);
$('recompute').onclick = safe(() => recompute());
$('benchmark').onclick = safe(benchmark);
for (const id of ['threshold', 'temperature']) $(id).onchange = safe(async () => { drawTimeline(); await inspect(selectedTime); });
$('timeline').onclick = safe(event => inspect((event.clientX - $('timeline').getBoundingClientRect().left) / $('timeline').getBoundingClientRect().width * (run?.analysisDuration || 0), true));
$('seek').oninput = safe(async () => { await player.seek(Number($('seek').value)); if (run) await inspect(Number($('seek').value) - run.audioOffset); });
$('play').onclick = safe(() => player.state.playing ? player.pause() : player.play());
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.modelLab = { get run() { return run; }, get report() { return statistics?.report(); }, get busy() { return busy; }, get player() { return player; }, analyze, benchmark, inspect, setFile };

import { createLiveSession } from './live-session.mjs';
import { createLiveProxyBuffer } from './live-proxy-buffer.mjs';
import { createLiveResourceMonitor } from './live-resource-monitor.mjs';
import { createDirectoryWatcher } from './directory-watcher.mjs';
import { alignRecordingToLiveSession, extractMasterEnvelopeSlice } from './audio-aligner.mjs';
import { createMediaReadSource } from './media-read-source.mjs';
import { DEFAULT_MODEL, getModelSpec } from './model-registry.mjs';
import { DISPLAY_GROUPS, createDisplayGrouping } from './lab-display-groups.mjs';
import {
  createGroupToggleBar,
  ensureCanvasSize,
  formatHoverGroupScores,
  paintLayeredWaveform,
  paintOverviewDistribution,
  resolveWaveColor,
} from './waveform-renderer.mjs';

const formatClock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};
const formatSec = (sec = 0) => `${Math.floor(Math.max(0, sec) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, sec) % 60).toString().padStart(2, '0')}`;
const formatLag = (lagSec) => (lagSec <= 0.5 ? 'LIVE' : `-${formatSec(lagSec)}`);
const formatMB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const formatBitrate = (bps = 0) => {
  if (!bps || bps <= 0) return '0 Mbps';
  if (bps < 100_000) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
};
const formatFileStamp = (ms = Date.now()) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Independent Live Companion Workspace controller & renderer.
 * - Broadcast-style DVR player: drag left to scrub recent 2-min proxy replay, rightmost = LIVE.
 * - Reuses shared layered waveform, 4-group sound toggles, and gunshot distribution renderer
 *   from waveform-renderer.mjs / waveform-layers.mjs / lab-display-groups.mjs.
 */
export function createLiveCompanionWorkspace({
  MB,
  container,
  onLiveRunningChange = () => {},
  onOpenMasterReview = async () => {},
  onStatus = () => {},
}) {
  const modelId = DEFAULT_MODEL;
  const manifestCache = new Map();
  let inferenceWorker = null;
  let workerBusy = false;
  let pendingWindow = null;
  let reqSeq = 0;

  let audioCtx = null;
  let workletNode = null;
  let mediaStream = null;
  let simVideoEl = null;
  let simObjectUrl = null;
  let simSourceFile = null;
  let simGainNode = null;
  let simStartWallMs = 0;
  let simStartMediaSec = 0;
  let simRunToken = 0;

  // Broadcast DVR state: lagSec === 0 -> LIVE rightmost; lagSec > 0 -> timeshifted proxy replay.
  let dvrMode = false;
  let dvrPaused = false;
  let dvrLagSec = 0;
  let dvrMuted = true;
  let dvrDragging = false;
  let dvrAnchorWallMs = 0;
  let lastWaveformView = null;
  let lastHitAt = 0;
  let rafId = null;

  const enabledGroups = new Set(DISPLAY_GROUPS.map((g) => g.id));
  let proxyState = { mode: 'smooth', bufferedBytes: 0, maxBytes: 150 * 1024 * 1024, elapsedSec: 0, mimeType: null, filmstripCount: 0, replayUrl: null, bitrateBps: 0, lastChunkGapMs: 0 };
  let watcherState = { watching: false, directoryName: null, tracked: [] };
  let liveNotice = '选择「捕获屏幕」、「音频设备」或「本地视频模拟」开始实时识别与回看。';
  let liveTone = 'info';
  let resourceDetailsOpen = false;
  let lastResourceUiAt = 0;

  const resourceMonitor = createLiveResourceMonitor({
    onVisibilityReturn() {
      // Immediately flush background peaks & summary the instant user returns from game.
      renderResourceBar(true);
    },
  });

  const session = createLiveSession({
    windowSeconds: 120,
    threshold: 0.2,
    onChange() {
      if (!document.hidden) renderPanels();
    },
  });

  const proxyBuffer = createLiveProxyBuffer({
    windowSeconds: 120,
    mode: 'smooth',
    onState(next) {
      proxyState = next;
      // Pre-bind MSE replay URL immediately so dragging left responds with zero startup delay.
      if (next.replayUrl && replayVideo && replayVideo.src !== next.replayUrl) {
        replayVideo.src = next.replayUrl;
        replayVideo.muted = dvrMuted;
      }
      if (!document.hidden) renderMetrics();
    },
    onChunk(info) {
      resourceMonitor.recordProxyChunk(info);
      renderResourceBar();
    },
    onOverload(message) {
      resourceMonitor.recordProxyOverload({ message });
      setNotice(message, 'warn');
      renderResourceBar(true);
    },
  });

  async function probeMasterFile(file) {
    const input = new MB.Input({ source: createMediaReadSource({ MB, file, priority: 'analysis' }), formats: MB.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error('无视频轨');
      const origin = Math.max(0, await video.getFirstTimestamp());
      const duration = await video.computeDuration() - origin;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('无效视频时长');
      return { duration, origin, width: video.displayWidth, height: video.displayHeight };
    } finally {
      input.dispose();
    }
  }

  async function conformFile(file, { coarseStartOverrideMs = null, meta = null } = {}) {
    const conformStarted = performance.now();
    setNotice(`正在对齐「${file.name}」…`, 'info');
    const input = new MB.Input({ source: createMediaReadSource({ MB, file, priority: 'analysis' }), formats: MB.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error('录像缺少视频轨');
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack) throw new Error('录像缺少可用音轨');
      const tracks = await input.getAudioTracks();
      const trackIndex = Math.max(0, tracks.findIndex((t) => t === audioTrack || t.id === audioTrack.id));
      const origin = meta?.origin ?? Math.max(0, await video.getFirstTimestamp());
      const duration = meta?.duration ?? (await video.computeDuration() - origin);
      const audioOrigin = Math.max(0, await audioTrack.getFirstTimestamp());
      const liveHistory = session.getHistoryForAlignment();

      const result = await alignRecordingToLiveSession({
        file,
        duration,
        origin,
        trackIndex,
        liveHistory,
        coarseStartOverrideMs,
        extractSlice: ({ startSec, spanSec }) => extractMasterEnvelopeSlice({
          MB,
          track: audioTrack,
          origin: audioOrigin,
          startSec,
          spanSec,
        }),
      });

      resourceMonitor.recordConform({
        fileName: file.name,
        durationMs: performance.now() - conformStarted,
        confidence: result.confidence,
      });
      renderResourceBar(true);

      if (result.confidence === 'unmatched' || !result.mapped) {
        setNotice(`「${file.name}」不在当前录制时间内，已忽略。`, 'warn');
        return null;
      }

      const conformed = session.registerConformed({
        name: file.name,
        file,
        duration,
        alignment: {
          confidence: result.confidence,
          correlation: result.correlation,
          offsetMs: result.offsetMs,
          driftPpm: result.driftPpm,
          masterStartEpochMs: result.masterStartEpochMs,
          coarseStartEpochMs: result.coarseStartEpochMs,
        },
        windowScores: result.mapped.windowScores,
        waveform: result.mapped.waveform,
        scoreTimeline: result.mapped.scoreTimeline,
        liveDecisions: result.mapped.liveDecisions,
      }, liveHistory);

      const label = result.confidence === 'exact'
        ? `精确对齐 (${result.offsetMs >= 0 ? '+' : ''}${result.offsetMs}ms)`
        : '粗略对齐（建议微调或重新分析）';
      setNotice(`已关联「${file.name}」· ${label}`, result.confidence === 'exact' ? 'ok' : 'warn');
      renderPanels();
      return conformed;
    } catch (error) {
      setNotice(`关联失败（${file.name}）：${error.message || error}`, 'warn');
      return null;
    } finally {
      input.dispose();
    }
  }

  const watcher = createDirectoryWatcher({
    pollIntervalMs: 2000,
    stablePollsRequired: 2,
    probeFile: probeMasterFile,
    onStatus(next) {
      watcherState = next;
      if (!document.hidden) renderWatcher();
    },
    async onReady({ file, meta }) {
      await conformFile(file, { meta });
    },
    onError(error) {
      setNotice(`目录读取异常：${error.message || error}`, 'warn');
    },
  });

  // Build static DOM shell once.
  container.innerHTML = `
    <div class="live-shell">
      <div class="page-heading">
        <div>
          <h1>实时模式(demo)</h1>
          <p class="intro">实时监听游戏声音、标出交火片段并支持即时回看，新录像保存后自动关联以便剪辑导出。</p>
        </div>
        <div class="live-metrics-strip">
          <span id="live-pill-status" class="live-pill">未开始</span>
          <span id="live-pill-mem" class="live-pill">缓存 0.0 / 150 MB</span>
          <span id="live-pill-dir" class="live-pill">未选录像目录</span>
        </div>
      </div>

      <section class="panel">
        <div class="live-toolbar">
          <div class="live-source-controls">
            <button id="live-btn-display" class="primary" type="button">捕获屏幕</button>
            <button id="live-btn-device" class="quiet" type="button">音频设备</button>
            <button id="live-btn-sim" type="button">本地视频模拟</button>
            <input id="live-sim-file" type="file" accept="video/*,.mkv,.webm,.mp4,.mov" hidden>
            <button id="live-btn-stop" class="destructive" type="button" disabled>停止</button>
          </div>
          <div class="live-source-controls">
            <label class="field"><span>回看时长</span>
              <select id="live-window-sec">
                <option value="60">1 分钟</option>
                <option value="120" selected>2 分钟</option>
                <option value="180">3 分钟</option>
                <option value="300">5 分钟</option>
              </select>
            </label>
            <label class="field"><span>回看画质</span>
              <select id="live-proxy-mode">
                <option value="smooth" selected>流畅 720p</option>
                <option value="eco">省电缩略图</option>
              </select>
            </label>
            <label class="field"><span>阈值</span>
              <input id="live-threshold" type="number" min="0.05" max="0.95" step="0.05" value="0.20">
            </label>
            <button id="live-btn-watch-dir" type="button">选择录像目录</button>
          </div>
        </div>

        <div class="live-resource-bar" id="live-resource-bar" data-active="false">
          <div class="live-resource-row">
            <div class="live-resource-head">
              <span class="live-res-dot" id="live-res-dot" aria-hidden="true"></span>
              <strong class="live-res-title">资源消耗</strong>
              <span class="live-res-state" id="live-res-state">待机 · 含后台记录</span>
            </div>
            <div class="live-resource-meters">
              <div class="live-res-chip" id="live-res-infer-chip" title="每 2 秒音频模型前处理 + WASM 单核推理耗时（后台持续记录）">
                <div class="live-res-chip-top">
                  <span class="live-res-label">模型推理</span>
                  <span class="live-res-val" id="live-res-infer-val">--</span>
                </div>
                <div class="live-res-meter"><span class="live-res-fill" id="live-res-infer-fill"></span></div>
              </div>
              <div class="live-res-chip" id="live-res-encode-chip" title="浏览器代理视频编码吞吐量（流畅 720p / 省电 2fps / 纯音频无编码）">
                <div class="live-res-chip-top">
                  <span class="live-res-label">视频编码</span>
                  <span class="live-res-val" id="live-res-encode-val">--</span>
                </div>
                <div class="live-res-meter"><span class="live-res-fill" id="live-res-encode-fill"></span></div>
              </div>
              <div class="live-res-chip" id="live-res-render-chip" title="前台波形与进度条重绘帧率及单帧耗时（切入游戏后台自动停绘）">
                <div class="live-res-chip-top">
                  <span class="live-res-label">界面渲染</span>
                  <span class="live-res-val" id="live-res-render-val">--</span>
                </div>
                <div class="live-res-meter"><span class="live-res-fill" id="live-res-render-fill"></span></div>
              </div>
              <div class="live-res-chip" id="live-res-mem-chip" title="回看缓存体积与浏览器 JS 堆内存（点击右侧「测总内存」可测含 WASM 总内存）">
                <div class="live-res-chip-top">
                  <span class="live-res-label">内存</span>
                  <span class="live-res-val" id="live-res-mem-val">0.0 MB</span>
                </div>
                <div class="live-res-meter"><span class="live-res-fill" id="live-res-mem-fill"></span></div>
              </div>
              <div class="live-res-chip" id="live-res-stall-chip" title="主线程 >50ms 阻塞事件（长任务，前后台均自动记录）">
                <div class="live-res-chip-top">
                  <span class="live-res-label">卡顿</span>
                  <span class="live-res-val" id="live-res-stall-val">长任务 0</span>
                </div>
                <div class="live-res-meter"><span class="live-res-fill" id="live-res-stall-fill"></span></div>
              </div>
            </div>
            <div class="live-resource-actions">
              <button id="live-res-toggle" class="quiet" type="button" aria-expanded="false">后台明细</button>
              <button id="live-res-measure-mem" class="quiet" type="button" title="手动触发一次跨源隔离总内存检测（避免游戏期间自动 GC）">测总内存</button>
              <button id="live-res-export" class="quiet" type="button" disabled title="导出带毫秒时间戳与前/后台标记的 JSON 采样日志">导出日志</button>
            </div>
          </div>
          <div class="live-resource-details" id="live-res-details" hidden></div>
        </div>

        <p id="live-notice" class="workspace-status live-notice"></p>
        <div id="live-sim-banner" class="live-sim-banner" hidden>
          <div>
            <strong id="live-sim-title">模拟模式</strong>
            <span id="live-sim-meta" class="muted live-sim-meta"></span>
          </div>
          <div class="row">
            <label class="field"><input id="live-sim-audible" type="checkbox"> <span>开启声音</span></label>
            <label class="field"><span>时间偏移 (ms)</span>
              <input id="live-sim-offset" class="live-sim-offset" type="number" step="200" value="1400">
            </label>
            <button id="live-btn-sim-conform" class="primary" type="button">关联此录像</button>
          </div>
        </div>
      </section>

      <div class="live-grid">
        <section class="panel">
          <div class="live-stage" id="live-stage" data-hit="false">
            <video id="live-video" autoplay muted playsinline></video>
            <video id="live-replay-video" playsinline hidden></video>
            <img id="live-eco-frame" class="live-eco-frame" alt="回看缩略图" hidden>
            <div class="live-stage-empty" id="live-stage-empty">
              <strong id="live-stage-empty-title">等待开始</strong>
              <span id="live-stage-empty-desc" class="muted">点击上方「捕获屏幕」、「音频设备」或「本地视频模拟」开始实时枪声识别与即时回看。</span>
            </div>
            <div class="live-stage-overlay">
              <span id="live-stage-mode-tag" class="live-stage-tag">未开始</span>
              <span id="live-stage-score-tag" class="live-stage-tag">枪声: --</span>
            </div>

            <div class="live-dvr-bar" id="live-dvr-bar">
              <div class="live-dvr-scrubber" id="live-dvr-scrubber" role="slider" aria-label="回看进度条" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
                <div class="live-dvr-track">
                  <canvas id="live-dvr-overview" class="live-dvr-overview" height="12"></canvas>
                  <div id="live-dvr-fill" class="live-dvr-fill"></div>
                </div>
                <div id="live-dvr-thumb" class="live-dvr-thumb" data-dvr="false"></div>
                <div id="live-dvr-hover" class="live-dvr-hover" hidden>-00:00</div>
              </div>
              <div class="live-dvr-controls">
                <div class="live-dvr-controls-left">
                  <button id="live-dvr-playpause" class="live-dvr-btn" type="button" disabled>暂停</button>
                  <button id="live-dvr-mute" class="live-dvr-btn" type="button" disabled>静音</button>
                  <button id="live-badge-btn" class="live-badge-btn" type="button" data-dvr="false" disabled>
                    <span class="live-badge-dot" aria-hidden="true"></span>
                    <span id="live-badge-text">LIVE</span>
                  </button>
                </div>
                <div class="live-dvr-controls-right">
                  <span id="live-dvr-hint" class="live-dvr-hint">向左拖动进度条或波形回看</span>
                  <button id="live-btn-mark" class="live-dvr-btn" type="button" disabled>＋ 打点</button>
                </div>
              </div>
            </div>
          </div>

          <div class="live-timeline-box">
            <div class="panel-heading live-heading-flush">
              <div class="heading-label">
                <h2>声音波形</h2>
                <span id="live-timeline-span" class="count">00:00</span>
              </div>
              <span id="live-gate-hint" class="muted"></span>
            </div>
            <div class="waveform-group-bar">
              <span class="group-toggles-label">图层</span>
              <div id="live-group-toggles" class="waveform-group-toggles" role="group" aria-label="声音图层"></div>
            </div>
            <div id="live-wave-axis" class="live-wave-axis" title="点击或向左拖动波形回看">
              <canvas id="live-timeline-canvas" class="live-wave-canvas" height="84"></canvas>
              <div id="live-conformed-layer" class="live-conformed-layer"></div>
              <div id="live-markers-layer" class="live-markers-layer"></div>
              <div id="live-playhead" class="live-playhead" data-dvr="false"></div>
            </div>
            <div class="axis-meta-row">
              <div id="live-wave-ticks" class="axis-ticks"><span>-02:00</span><span>-01:00</span><span>LIVE</span></div>
              <span class="muted">向左拖动可回看近期画面，关联录像后可剪辑导出</span>
            </div>
            <div id="live-wave-hover" class="live-wave-hover" hidden>
              <strong id="live-hover-time">-00:00</strong>
              <div id="live-hover-scores" class="live-hover-scores"></div>
            </div>
            <div id="live-filmstrip-bar" class="live-filmstrip-bar" hidden></div>
          </div>
        </section>

        <div class="live-side">
          <section class="panel">
            <div class="panel-heading live-heading-compact">
              <div class="heading-label">
                <h2>已关联录像</h2>
                <span id="live-conformed-count" class="count">0</span>
              </div>
              <button id="live-btn-poll-now" class="quiet" type="button" disabled>刷新目录</button>
            </div>
            <p id="live-watcher-detail" class="muted live-watcher-detail">未选择录像目录；模拟模式下可点击上方「关联此录像」。</p>
            <div id="live-conformed-list" class="live-list"></div>
          </section>

          <section class="panel">
            <div class="panel-heading live-heading-compact">
              <div class="heading-label">
                <h2>交火与打点</h2>
                <span id="live-events-count" class="count">0</span>
              </div>
            </div>
            <div id="live-events-list" class="live-list"></div>
          </section>
        </div>
      </div>
    </div>
  `;

  const el = (id) => container.querySelector(`#${id}`);
  const liveVideo = el('live-video');
  const replayVideo = el('live-replay-video');
  const ecoFrameImg = el('live-eco-frame');
  const timelineCanvas = el('live-timeline-canvas');
  const dvrOverviewCanvas = el('live-dvr-overview');
  const dvrScrubber = el('live-dvr-scrubber');
  const waveAxis = el('live-wave-axis');

  const groupToggleBar = createGroupToggleBar({
    host: el('live-group-toggles'),
    enabledGroups,
    onToggle() {
      drawTimelineAndDvr();
    },
  });
  groupToggleBar.sync();

  function setNotice(message, tone = 'info') {
    liveNotice = message;
    liveTone = tone;
    const node = el('live-notice');
    if (node) {
      node.textContent = message;
      node.dataset.tone = tone;
    }
    onStatus(message, tone);
  }

  async function ensureModelMeta(modelId) {
    if (manifestCache.has(modelId)) return manifestCache.get(modelId);
    const spec = getModelSpec(modelId);
    const res = await fetch(spec.manifestUrl);
    if (!res.ok) throw new Error(`模型清单读取失败 (HTTP ${res.status})：${spec.manifestUrl}`);
    const manifest = await res.json();
    const gunshotIndices = spec.gunshotClasses.map((name) => manifest.classes.indexOf(name));
    if (gunshotIndices.some((i) => i < 0)) throw new Error(`模型 ${modelId} 类别清单缺少枪声类别`);
    const groupProjector = createDisplayGrouping(manifest.classes);
    const entry = { spec, manifest, gunshotIndices, groupProjector };
    manifestCache.set(modelId, entry);
    return entry;
  }

  function serializeSpec(spec) {
    return {
      id: spec.id,
      manifestUrl: spec.manifestUrl,
      onnxUrl: spec.onnxUrl,
      frontendUrl: spec.frontendUrl ?? null,
      frontendType: spec.frontendType || 'efficientsed',
      sampleRate: spec.sampleRate,
      windowSeconds: spec.windowSeconds,
      strideSeconds: spec.strideSeconds,
      frameSeconds: spec.frameSeconds,
      framesPerWindow: spec.framesPerWindow,
      hopFrames: spec.hopFrames,
      scoreType: spec.scoreType,
      inputName: spec.inputName,
      inputShape: [...spec.inputShape],
      ...(spec.outputName ? { outputName: spec.outputName } : {}),
      ...(spec.outputShape ? { outputShape: [...spec.outputShape] } : {}),
    };
  }

  function ensureInferenceWorker() {
    if (inferenceWorker) return inferenceWorker;
    inferenceWorker = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
    inferenceWorker.onmessage = ({ data }) => {
      if (data.type === 'status') {
        if (data.message) setNotice(`模型引擎：${data.message}`, 'info');
        return;
      }
      workerBusy = false;
      const meta = manifestCache.get(modelId);
      if (data.type === 'error') {
        setNotice(`模型推理报错：${data.message}`, 'warn');
      } else if (data.type === 'result' && meta) {
        const { spec, manifest, gunshotIndices, groupProjector } = meta;
        const classCount = manifest.classes.length;
        const groupCount = DISPLAY_GROUPS.length;
        const snap = session.snapshot();
        const wallEndMs = snap.latestEpochMs || Date.now();
        const wallStartMs = Math.max(snap.startEpochMs, wallEndMs - spec.windowSeconds * 1000);

        const gunshotPair = [0, 0];
        const peakGroupScores = new Float32Array(groupCount);
        const frames = spec.framesPerWindow || Math.floor(data.values.length / classCount);
        const frameGroupScores = new Float32Array(frames * groupCount);
        for (let f = 0; f < frames; f++) {
          const slice = data.values.subarray(f * classCount, (f + 1) * classCount);
          groupProjector(slice, frameGroupScores, f * groupCount);
          for (let g = 0; g < groupCount; g++) {
            const gv = frameGroupScores[f * groupCount + g];
            if (gv > peakGroupScores[g]) peakGroupScores[g] = gv;
          }
          for (let c = 0; c < gunshotIndices.length; c++) {
            const v = slice[gunshotIndices[c]] || 0;
            if (v > gunshotPair[c]) gunshotPair[c] = v;
          }
        }

        const maxGunshot = Math.max(...gunshotPair);
        const hit = maxGunshot > snap.threshold;
        const thumbnail = hit ? proxyBuffer.captureSnapshot(liveVideo) : null;
        session.pushScoreWindow({
          wallStartMs,
          wallEndMs,
          scores: gunshotPair,
          groupScores: peakGroupScores,
          frameGroupScores,
          frameSeconds: spec.frameSeconds || 0.04,
          thumbnail,
        });
        if (hit) lastHitAt = performance.now();
        resourceMonitor.recordInference({
          frontendMs: data.timings?.frontendMs || 0,
          inferenceMs: data.timings?.inferenceMs || 0,
          cold: !!data.timings?.cold,
        });
        renderResourceBar();
        const scoreTag = el('live-stage-score-tag');
        if (scoreTag) {
          scoreTag.textContent = `枪声 ${(peakGroupScores[0] * 100).toFixed(0)}% · 语音 ${(peakGroupScores[1] * 100).toFixed(0)}%${hit ? ' · 交火' : ''}`;
          scoreTag.dataset.alert = String(hit);
        }
      }
      if (pendingWindow) {
        const next = pendingWindow;
        pendingWindow = null;
        void dispatchInference(next);
      }
    };
    inferenceWorker.onerror = (event) => {
      workerBusy = false;
      setNotice(`模型 Worker 异常：${event.message || '未知错误'}`, 'warn');
    };
    return inferenceWorker;
  }

  async function dispatchInference(waveform) {
    try {
      const { spec, manifest } = await ensureModelMeta(modelId);
      const worker = ensureInferenceWorker();
      workerBusy = true;
      worker.postMessage({
        id: ++reqSeq,
        waveform,
        model: spec.id,
        spec: serializeSpec(spec),
        manifest: { sha256: manifest.sha256, bytes: manifest.bytes, modelFile: manifest.modelFile },
      }, [waveform.buffer]);
    } catch (error) {
      workerBusy = false;
      setNotice(error.message || String(error), 'warn');
    }
  }

  async function attachAudioPipeline(sourceNode, { connectToDestination = false } = {}) {
    const spec = getModelSpec(modelId);
    await audioCtx.audioWorklet.addModule(new URL('./live-audio-processor.js', import.meta.url));
    workletNode = new AudioWorkletNode(audioCtx, 'live-audio-processor', {
      processorOptions: { targetRate: spec.sampleRate, windowSeconds: spec.windowSeconds, hopSeconds: 2 },
    });
    workletNode.port.onmessage = ({ data }) => {
      if (data.type === 'envelope') {
        session.pushEnvelope(data.buckets, data.silentSeconds);
        if (data.silentSeconds >= 10) {
          setNotice('已连续 10 秒未检测到声音，请检查音频输入。', 'warn');
        }
      } else if (data.type === 'window') {
        if (session.snapshot().gateActive) return;
        if (workerBusy) {
          if (pendingWindow) resourceMonitor.recordDroppedWindow();
          pendingWindow = data.waveform;
        } else {
          void dispatchInference(data.waveform);
        }
      }
    };
    sourceNode.connect(workletNode);
    if (connectToDestination) {
      simGainNode = audioCtx.createGain();
      simGainNode.gain.value = el('live-sim-audible').checked ? 0.5 : 0;
      sourceNode.connect(simGainNode);
      simGainNode.connect(audioCtx.destination);
    }
    const silentSink = audioCtx.createGain();
    silentSink.gain.value = 0;
    workletNode.connect(silentSink);
    silentSink.connect(audioCtx.destination);
  }

  // --- Broadcast-style DVR Playback Engine ---
  function getMaxDvrSpanSec() {
    const snap = session.snapshot();
    const bounds = proxyBuffer.getDvrBounds();
    return Math.max(0, Math.min(snap.proxyWindowSeconds, Math.max(bounds.availableSec, snap.durationSec)));
  }

  function syncDvrGate() {
    const replayAudible = dvrMode && proxyState.mode === 'smooth' && !replayVideo.paused && !replayVideo.ended && !replayVideo.muted && replayVideo.volume > 0;
    session.setPlaybackGate(replayAudible, '回放有声，已暂停监听（静音回看可继续识别）');
    proxyBuffer.setPaused(replayAudible);
    if (workletNode) workletNode.port.postMessage({ type: 'pause', value: replayAudible });
  }

  function returnToLive() {
    dvrMode = false;
    dvrPaused = false;
    dvrLagSec = 0;
    replayVideo.pause();
    replayVideo.hidden = true;
    ecoFrameImg.hidden = true;
    if (session.snapshot().sourceKind !== 'device') liveVideo.hidden = false;
    syncDvrGate();
    syncDvrControlsUI();
  }

  function seekDvrByLag(targetLagSec, { autoPlay = true } = {}) {
    const snap = session.snapshot();
    if (!snap.active) return;
    const maxSpan = getMaxDvrSpanSec();
    const clampedLag = Math.max(0, Math.min(maxSpan, targetLagSec));

    // Snap cleanly back to LIVE when dragged to the rightmost edge (<= 1.2s behind live).
    if (clampedLag <= 1.2 && !dvrPaused) {
      returnToLive();
      return;
    }

    dvrMode = true;
    dvrLagSec = clampedLag;
    dvrAnchorWallMs = (snap.latestEpochMs || Date.now()) - clampedLag * 1000;

    if (proxyState.mode === 'smooth') {
      const url = proxyBuffer.getReplayUrl();
      const range = proxyBuffer.getReplayRange();
      if (!url || !range || range.end - range.start < 0.5) {
        setNotice('缓存准备中，请 2–4 秒后再拖动回看。', 'warn');
        returnToLive();
        return;
      }
      liveVideo.hidden = true;
      ecoFrameImg.hidden = true;
      replayVideo.hidden = false;
      if (replayVideo.src !== url) replayVideo.src = url;
      replayVideo.muted = dvrMuted;
      const targetMediaTime = Math.max(range.start + 0.1, Math.min(range.end - 0.1, range.end - clampedLag));
      try { replayVideo.currentTime = targetMediaTime; } catch {}
      if (autoPlay && !dvrPaused) {
        void replayVideo.play().catch(() => {});
      } else {
        replayVideo.pause();
      }
    } else {
      // Eco 2fps filmstrip DVR scrubbing
      const frame = proxyBuffer.getFrameAtLag(clampedLag);
      if (frame) {
        liveVideo.hidden = true;
        replayVideo.hidden = true;
        ecoFrameImg.src = frame.dataUrl;
        ecoFrameImg.hidden = false;
      }
    }
    syncDvrGate();
    syncDvrControlsUI();
  }

  function seekDvrByRatio(ratio, options = {}) {
    const r = Math.max(0, Math.min(1, ratio));
    const viewSpan = lastWaveformView?.duration || Math.max(30, getMaxDvrSpanSec());
    const lag = (1 - r) * viewSpan;
    seekDvrByLag(lag, options);
  }

  function syncDvrControlsUI() {
    const snap = session.snapshot();
    const active = snap.active;
    const hasVideo = active && snap.sourceKind !== 'device';
    el('live-dvr-playpause').disabled = !hasVideo;
    el('live-dvr-mute').disabled = !hasVideo;
    el('live-badge-btn').disabled = !active;
    el('live-btn-mark').disabled = !active;

    const badgeBtn = el('live-badge-btn');
    const badgeText = el('live-badge-text');
    const playBtn = el('live-dvr-playpause');
    const muteBtn = el('live-dvr-mute');
    const modeTag = el('live-stage-mode-tag');

    badgeBtn.dataset.dvr = String(dvrMode);
    if (!active) {
      badgeText.textContent = 'LIVE';
      playBtn.textContent = '暂停';
      modeTag.textContent = '未开始';
    } else if (!dvrMode) {
      badgeText.textContent = 'LIVE';
      playBtn.textContent = '暂停';
      modeTag.textContent = snap.sourceKind === 'simulated'
        ? 'LIVE · 模拟视频'
        : snap.sourceKind === 'device' ? 'LIVE · 音频设备' : 'LIVE · 屏幕';
    } else {
      badgeText.textContent = `⏪ ${formatLag(dvrLagSec)} · 回到实时`;
      playBtn.textContent = dvrPaused ? '继续' : '暂停';
      modeTag.textContent = `回看 ${formatLag(dvrLagSec)}`;
    }
    muteBtn.textContent = dvrMuted ? '已静音' : '有声';
  }

  // Track DVR playhead continuously when in smooth timeshift replay.
  function tickDvrState() {
    const snap = session.snapshot();
    if (!snap.active || !dvrMode || dvrDragging) return;
    if (proxyState.mode === 'smooth') {
      const range = proxyBuffer.getReplayRange();
      if (range) {
        if (dvrPaused) {
          // While paused, live edge keeps moving right, so lag grows until capped by window.
          const lag = Math.max(0, ((snap.latestEpochMs || Date.now()) - dvrAnchorWallMs) / 1000);
          dvrLagSec = Math.min(getMaxDvrSpanSec(), lag);
        } else if (!replayVideo.paused) {
          dvrLagSec = Math.max(0, range.end - replayVideo.currentTime);
          if (dvrLagSec <= 0.6) {
            returnToLive();
            return;
          }
        }
      }
    } else if (dvrPaused) {
      dvrLagSec = Math.min(getMaxDvrSpanSec(), Math.max(0, ((snap.latestEpochMs || Date.now()) - dvrAnchorWallMs) / 1000));
    } else {
      // Eco playback: step frames forward to keep pace with live or stay at fixed lag.
      const frame = proxyBuffer.getFrameAtLag(dvrLagSec);
      if (frame && ecoFrameImg.src !== frame.dataUrl) ecoFrameImg.src = frame.dataUrl;
    }
    syncDvrControlsUI();
  }

  // Bind scrubber & waveform synchronized dragging (broadcast DVR feel).
  function bindScrubTarget(targetEl, { onHover = null, onLeave = null } = {}) {
    const ratioOfEvent = (event) => {
      const rect = targetEl.getBoundingClientRect();
      return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    };
    targetEl.addEventListener('pointerdown', (event) => {
      if (!session.snapshot().active || event.target.closest('button.live-marker-pill')) return;
      dvrDragging = true;
      targetEl.dataset.dragging = 'true';
      targetEl.setPointerCapture?.(event.pointerId);
      const r = ratioOfEvent(event);
      dvrPaused = false;
      seekDvrByRatio(r, { autoPlay: false });
      drawTimelineAndDvr();
    });
    targetEl.addEventListener('pointermove', (event) => {
      if (!session.snapshot().active) return;
      const r = ratioOfEvent(event);
      onHover?.(r, event);
      if (!dvrDragging) return;
      seekDvrByRatio(r, { autoPlay: false });
      drawTimelineAndDvr();
    });
    const finishDrag = (event) => {
      if (!dvrDragging) return;
      dvrDragging = false;
      targetEl.dataset.dragging = 'false';
      const r = ratioOfEvent(event);
      seekDvrByRatio(r, { autoPlay: true });
      drawTimelineAndDvr();
    };
    targetEl.addEventListener('pointerup', finishDrag);
    targetEl.addEventListener('pointercancel', finishDrag);
    targetEl.addEventListener('pointerleave', () => {
      if (!dvrDragging) onLeave?.();
    });
  }

  bindScrubTarget(dvrScrubber, {
    onHover(ratio) {
      const hover = el('live-dvr-hover');
      const view = lastWaveformView;
      const span = view?.duration || 30;
      const lag = (1 - ratio) * span;
      hover.hidden = false;
      hover.style.left = `${(ratio * 100).toFixed(2)}%`;
      const scores = view?.scoreTimeline ? formatHoverGroupScores(view.scoreTimeline, ratio * span) : null;
      const gunText = scores ? ` · 枪声 ${(scores[0].score * 100).toFixed(0)}%` : '';
      hover.textContent = `${formatLag(lag)}${gunText}`;
    },
    onLeave() {
      el('live-dvr-hover').hidden = true;
    },
  });

  bindScrubTarget(waveAxis, {
    onHover(ratio) {
      const view = lastWaveformView;
      if (!view) return;
      const hoverBox = el('live-wave-hover');
      const tSec = ratio * view.duration;
      const lag = view.duration - tSec;
      hoverBox.hidden = false;
      el('live-hover-time').textContent = `${formatLag(lag)} (${formatClock(view.startEpochMs + tSec * 1000)})`;
      const scores = view.scoreTimeline ? formatHoverGroupScores(view.scoreTimeline, tSec) : null;
      const scoresHost = el('live-hover-scores');
      if (!scores) {
        scoresHost.innerHTML = '<span class="muted">分析中…</span>';
      } else {
        scoresHost.replaceChildren(...scores.map((s) => {
          const span = document.createElement('span');
          span.className = 'live-hover-score-item';
          const dot = document.createElement('span');
          dot.className = 'live-hover-dot';
          dot.style.background = s.color;
          const strong = document.createElement('strong');
          strong.textContent = `${(s.score * 100).toFixed(0)}%`;
          span.append(dot, `${s.name} `, strong);
          return span;
        }));
      }
    },
    onLeave() {
      el('live-wave-hover').hidden = true;
    },
  });

  function resetEmptyStage(mode = 'idle') {
    const titleEl = el('live-stage-empty-title');
    const descEl = el('live-stage-empty-desc');
    if (mode === 'device') {
      if (titleEl) titleEl.textContent = '音频设备监听中';
      if (descEl) descEl.textContent = '仅音频输入，无画面；波形与交火识别在下方实时更新。';
    } else {
      if (titleEl) titleEl.textContent = '等待开始';
      if (descEl) descEl.textContent = '点击上方「捕获屏幕」、「音频设备」或「本地视频模拟」开始实时枪声识别与即时回看。';
    }
  }

  async function stopCapture() {
    simRunToken++;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    proxyBuffer.stop();
    session.stop();
    resourceMonitor.stop();
    dvrMode = false;
    dvrPaused = false;
    dvrLagSec = 0;
    dvrDragging = false;
    pendingWindow = null;
    workerBusy = false;
    if (inferenceWorker) { inferenceWorker.terminate(); inferenceWorker = null; }
    if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch {} audioCtx = null; }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
    if (simVideoEl) {
      simVideoEl.pause();
      simVideoEl.src = '';
      simVideoEl = null;
    }
    if (simObjectUrl) {
      URL.revokeObjectURL(simObjectUrl);
      simObjectUrl = null;
    }
    simSourceFile = null;
    liveVideo.srcObject = null;
    replayVideo.pause();
    replayVideo.removeAttribute('src');
    replayVideo.hidden = true;
    ecoFrameImg.hidden = true;
    liveVideo.hidden = false;
    resetEmptyStage('idle');
    el('live-stage-empty').hidden = false;
    el('live-sim-banner').hidden = true;
    el('live-btn-stop').disabled = true;
    el('live-stage').dataset.hit = 'false';
    el('live-stage-score-tag').textContent = '枪声: --';
    el('live-stage-score-tag').dataset.alert = 'false';
    syncDvrControlsUI();
    onLiveRunningChange(false);
    renderMetrics();
    renderPanels();
    renderResourceBar(true);
  }

  function startRenderLoop() {
    const loop = () => {
      if (!session.snapshot().active) return;
      tickDvrState();
      if (!document.hidden) {
        const drawStart = performance.now();
        drawTimelineAndDvr();
        const hit = !dvrMode && (performance.now() - lastHitAt < 2400);
        el('live-stage').dataset.hit = String(hit);
        resourceMonitor.recordRenderFrame({ drawMs: performance.now() - drawStart });
        renderResourceBar();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  async function startSimulatedFromFile(file) {
    await stopCapture();
    const runToken = simRunToken;
    simSourceFile = file;
    simObjectUrl = URL.createObjectURL(file);
    simVideoEl = document.createElement('video');
    simVideoEl.src = simObjectUrl;
    simVideoEl.crossOrigin = 'anonymous';
    simVideoEl.playsInline = true;
    await new Promise((resolve, reject) => {
      simVideoEl.onloadedmetadata = resolve;
      simVideoEl.onerror = () => reject(new Error('浏览器无法解码该测试视频文件'));
    });

    audioCtx = new AudioContext();
    await audioCtx.resume();
    const mediaElSource = audioCtx.createMediaElementSource(simVideoEl);
    await attachAudioPipeline(mediaElSource, { connectToDestination: true });

    const capCanvas = document.createElement('canvas');
    const ratio = simVideoEl.videoHeight ? simVideoEl.videoWidth / simVideoEl.videoHeight : 16 / 9;
    capCanvas.height = Math.min(720, simVideoEl.videoHeight || 720);
    capCanvas.width = Math.round(capCanvas.height * ratio);
    const capCtx = capCanvas.getContext('2d');
    const videoStream = capCanvas.captureStream(30);
    const audioDest = audioCtx.createMediaStreamDestination();
    mediaElSource.connect(audioDest);
    mediaStream = new MediaStream([...videoStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]);

    const pumpCanvas = () => {
      if (!simVideoEl || !session.snapshot().active) return;
      if (simVideoEl.readyState >= 2) capCtx.drawImage(simVideoEl, 0, 0, capCanvas.width, capCanvas.height);
      if (simVideoEl.requestVideoFrameCallback) simVideoEl.requestVideoFrameCallback(pumpCanvas);
      else setTimeout(pumpCanvas, 33);
    };

    liveVideo.srcObject = mediaStream;
    liveVideo.muted = true;
    await simVideoEl.play();
    if (simVideoEl.readyState >= 2) capCtx.drawImage(simVideoEl, 0, 0, capCanvas.width, capCanvas.height);
    else { capCtx.fillStyle = '#0b1020'; capCtx.fillRect(0, 0, capCanvas.width, capCanvas.height); }

    simStartWallMs = Date.now();
    simStartMediaSec = simVideoEl.currentTime || 0;

    simVideoEl.addEventListener('ended', () => {
      if (runToken === simRunToken && session.snapshot().active) {
        setNotice('本地视频播放已结束；可点击上方「关联此录像」体验对齐，或点击「停止」。', 'info');
      }
    });

    session.start({ kind: 'simulated', nowMs: simStartWallMs, windowSec: Number(el('live-window-sec').value) });
    resourceMonitor.start({
      sourceKind: 'simulated',
      proxyMode: el('live-proxy-mode').value,
      hopSeconds: 2,
      maxBytes: proxyState.maxBytes,
      nowMs: simStartWallMs,
    });
    proxyBuffer.setWindowSeconds(Number(el('live-window-sec').value));
    proxyBuffer.setMode(el('live-proxy-mode').value);
    proxyBuffer.start({ stream: mediaStream, videoElement: liveVideo });
    pumpCanvas();
    void liveVideo.play().catch(() => {});

    el('live-stage-empty').hidden = true;
    el('live-sim-banner').hidden = false;
    el('live-sim-title').textContent = '模拟模式';
    el('live-sim-meta').textContent = `${file.name} (${formatSec(simVideoEl.duration)})`;
    el('live-btn-stop').disabled = false;
    syncDvrControlsUI();
    setNotice('模拟已开始：向左拖动进度条或波形可回看，拖到最右回到实时。', 'ok');
    onLiveRunningChange(true);
    startRenderLoop();
    renderMetrics();
    renderResourceBar(true);
  }

  async function startDisplayCapture() {
    await stopCapture();
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持屏幕捕获');
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!mediaStream.getAudioTracks().length) {
      await stopCapture();
      throw new Error('未获取到系统音频：Windows Chrome 请选择「整个屏幕」并勾选共享系统音频；macOS 请改用「音频设备」或「本地视频模拟」。');
    }
    audioCtx = new AudioContext();
    await audioCtx.resume();
    await attachAudioPipeline(audioCtx.createMediaStreamSource(mediaStream));
    liveVideo.srcObject = mediaStream;
    liveVideo.muted = true;
    await liveVideo.play().catch(() => {});

    for (const track of mediaStream.getTracks()) {
      track.addEventListener('ended', () => {
        setNotice('屏幕共享已结束，已停止监听。', 'warn');
        void stopCapture();
      });
    }

    const startedAt = Date.now();
    session.start({ kind: 'display', nowMs: startedAt, windowSec: Number(el('live-window-sec').value) });
    resourceMonitor.start({
      sourceKind: 'display',
      proxyMode: el('live-proxy-mode').value,
      hopSeconds: 2,
      maxBytes: proxyState.maxBytes,
      nowMs: startedAt,
    });
    proxyBuffer.setWindowSeconds(Number(el('live-window-sec').value));
    proxyBuffer.setMode(el('live-proxy-mode').value);
    proxyBuffer.start({ stream: mediaStream, videoElement: liveVideo });

    el('live-stage-empty').hidden = true;
    el('live-btn-stop').disabled = false;
    syncDvrControlsUI();
    setNotice('已开始捕获屏幕与音频，向左拖动进度条或波形可回看。', 'ok');
    onLiveRunningChange(true);
    startRenderLoop();
    renderMetrics();
    renderResourceBar(true);
  }

  async function startDeviceCapture() {
    await stopCapture();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持音频设备输入');
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    audioCtx = new AudioContext();
    await audioCtx.resume();
    await attachAudioPipeline(audioCtx.createMediaStreamSource(mediaStream));
    const startedAt = Date.now();
    session.start({ kind: 'device', nowMs: startedAt, windowSec: Number(el('live-window-sec').value) });
    resourceMonitor.start({
      sourceKind: 'device',
      proxyMode: el('live-proxy-mode').value,
      hopSeconds: 2,
      maxBytes: proxyState.maxBytes,
      nowMs: startedAt,
    });
    resetEmptyStage('device');
    el('live-stage-empty').hidden = false;
    el('live-btn-stop').disabled = false;
    syncDvrControlsUI();
    setNotice('已开始监听音频设备。', 'ok');
    onLiveRunningChange(true);
    startRenderLoop();
    renderMetrics();
    renderResourceBar(true);
  }

  replayVideo.addEventListener('play', syncDvrGate);
  replayVideo.addEventListener('pause', syncDvrGate);
  replayVideo.addEventListener('volumechange', syncDvrGate);
  replayVideo.addEventListener('ended', () => {
    returnToLive();
  });

  // --- Shared Waveform & DVR Scrubber Rendering ---
  function drawTimelineAndDvr() {
    const snap = session.snapshot();
    const view = session.toWaveformView(snap.proxyWindowSeconds);
    lastWaveformView = view;

    const waveColor = resolveWaveColor(timelineCanvas, '#7b8391');

    // 1) Reuse shared layered waveform renderer (identical visual language to offline review!)
    const mainCtx = timelineCanvas.getContext('2d');
    if (mainCtx) {
      const { dpr } = ensureCanvasSize(timelineCanvas, 900, 84);
      paintLayeredWaveform({
        canvas: timelineCanvas,
        context: mainCtx,
        dpr,
        wave: view.wave,
        scoreTimeline: view.scoreTimeline,
        start: 0,
        end: view.duration,
        waveColor,
        enabledGroups,
        threshold: snap.threshold,
      });
    }

    // 2) Reuse shared overview gunshot distribution renderer inside the DVR scrubber bar!
    const dvrCtx = dvrOverviewCanvas.getContext('2d');
    if (dvrCtx) {
      const { dpr } = ensureCanvasSize(dvrOverviewCanvas, 700, 12);
      paintOverviewDistribution({
        canvas: dvrOverviewCanvas,
        context: dvrCtx,
        dpr,
        wave: view.wave,
        scoreTimeline: view.scoreTimeline,
        duration: view.duration,
        waveColor: '#cbd5e1',
        enabledGroups,
        threshold: snap.threshold,
        padCss: 1,
      });
    }

    // 3) Sync DVR thumb + waveform playhead positions (rightmost = 100% LIVE, drag left = DVR replay)
    const playheadRatio = dvrMode ? Math.max(0, Math.min(1, 1 - dvrLagSec / Math.max(1, view.duration))) : 1;
    const pct = `${(playheadRatio * 100).toFixed(2)}%`;
    el('live-dvr-fill').style.width = pct;
    el('live-dvr-thumb').style.left = pct;
    el('live-dvr-thumb').dataset.dvr = String(dvrMode);
    dvrScrubber.setAttribute('aria-valuenow', String(Math.round(playheadRatio * 100)));

    const playhead = el('live-playhead');
    playhead.style.left = pct;
    playhead.dataset.dvr = String(dvrMode);

    // 4) Update axis ticks (-MM:SS ... LIVE) & status text
    el('live-timeline-span').textContent = `${formatSec(snap.durationSec)} · 窗口 ${Math.round(view.duration)}s`;
    el('live-gate-hint').textContent = snap.gateActive ? (snap.gateReason || '监听已暂停') : `EfficientSED · 阈值 ${snap.threshold.toFixed(2)}`;
    const ticksHost = el('live-wave-ticks');
    const tickLabels = [`-${formatSec(view.duration)}`, `-${formatSec(view.duration / 2)}`, 'LIVE'];
    if (ticksHost && ticksHost.textContent !== tickLabels.join('')) {
      ticksHost.replaceChildren(...tickLabels.map((txt) => {
        const s = document.createElement('span');
        s.textContent = txt;
        return s;
      }));
    }

    // 5) Conformed master coverage bands & clickable candidate/manual markers
    const conformedLayer = el('live-conformed-layer');
    const pctOf = (wallMs) => Math.max(0, Math.min(100, ((wallMs - view.startEpochMs) / (view.duration * 1000)) * 100));
    conformedLayer.replaceChildren(...snap.conformed.flatMap((item) => {
      const left = pctOf(item.wallStartMs);
      const right = pctOf(item.wallEndMs);
      if (right <= left) return [];
      const band = document.createElement('div');
      band.className = 'live-conformed-band';
      band.dataset.confidence = item.alignment.confidence;
      band.style.left = `${left}%`;
      band.style.width = `${right - left}%`;
      band.title = `已关联：${item.name}`;
      return [band];
    }));

    const markersLayer = el('live-markers-layer');
    const markerItems = [
      ...snap.candidates.map((c) => ({ kind: 'candidate', wallStartMs: c.wallStartMs, wallEndMs: c.wallEndMs, excluded: c.excluded })),
      ...snap.decisions.map((d) => ({ kind: d.kind, wallStartMs: d.wallStartMs, wallEndMs: d.wallEndMs, excluded: d.kind === 'exclude' })),
    ];
    markersLayer.replaceChildren(...markerItems.flatMap((m) => {
      const left = pctOf(m.wallStartMs);
      const right = pctOf(m.wallEndMs);
      if (right <= left) return [];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'live-marker-pill';
      btn.dataset.kind = m.kind;
      btn.dataset.excluded = String(!!m.excluded);
      btn.style.left = `${left}%`;
      btn.style.width = `${Math.max(0.8, right - left)}%`;
      btn.title = `点击回看 ${formatClock(m.wallStartMs)}`;
      btn.onclick = (event) => {
        event.stopPropagation();
        const lag = Math.max(0, (view.endEpochMs - m.wallStartMs) / 1000);
        dvrPaused = false;
        seekDvrByLag(lag, { autoPlay: true });
      };
      return [btn];
    }));

    // 6) Eco mode clickable filmstrip bar
    const stripEl = el('live-filmstrip-bar');
    if (proxyState.mode === 'eco') {
      stripEl.hidden = false;
      const frames = proxyBuffer.getFilmstrip().slice(-14);
      if (stripEl.childElementCount !== frames.length) {
        stripEl.replaceChildren(...frames.map((f) => {
          const img = document.createElement('img');
          img.src = f.dataUrl;
          img.alt = formatClock(f.wallMs);
          img.title = `点击查看 ${formatClock(f.wallMs)}`;
          img.onclick = () => {
            const lag = Math.max(0, ((snap.latestEpochMs || Date.now()) - f.wallMs) / 1000);
            seekDvrByLag(lag, { autoPlay: false });
          };
          return img;
        }));
      }
    } else {
      stripEl.hidden = true;
    }
  }

  function setMeter(chipId, fillId, valId, { text, pct = 0, tone = 'ok', title }) {
    const chip = el(chipId);
    const fill = el(fillId);
    const val = el(valId);
    if (!chip || !fill || !val) return;
    val.textContent = text;
    fill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
    chip.dataset.tone = tone;
    if (title) chip.title = title;
  }

  function formatEventLine(evt) {
    const t = formatClock(evt.ts);
    const ctx = evt.hidden ? '[后台]' : '[前台]';
    if (evt.type === 'visibility') return `${t} ${ctx} 切换至${evt.state === 'background' ? '后台（游戏）' : '前台'}`;
    if (evt.type === 'longtask') return `${t} ${ctx} 主线程长任务 ${evt.durationMs}ms`;
    if (evt.type === 'dropped_window') return `${t} ${ctx} 音频推理跳窗（模型忙）`;
    if (evt.type === 'proxy_overload') return `${t} ${ctx} 代理过载：${evt.message}`;
    if (evt.type === 'conform') return `${t} ${ctx} 关联对齐「${evt.fileName}」耗时 ${evt.durationMs}ms (${evt.confidence})`;
    if (evt.type === 'mode_change') return `${t} ${ctx} 回看画质切换：${evt.from} → ${evt.to}`;
    if (evt.type === 'total_memory_measure') return `${t} ${ctx} 手动测得标签页总内存 ${formatMB(evt.bytes)}`;
    if (evt.type === 'session_start') return `${t} ${ctx} 开始监听（${evt.sourceKind} / ${evt.proxyMode}）`;
    if (evt.type === 'session_stop') return `${t} ${ctx} 停止监听`;
    return `${t} ${ctx} ${evt.type}`;
  }

  function renderResourceBar(force = false) {
    if (!force && document.hidden) return;
    const nowPerf = performance.now();
    if (!force && nowPerf - lastResourceUiAt < 1000) return;
    lastResourceUiAt = nowPerf;

    const bar = el('live-resource-bar');
    if (!bar) return;
    const snap = resourceMonitor.getSnapshot();
    const hasData = snap.sampleCount > 0 || snap.eventCount > 0;

    bar.dataset.active = String(snap.active);
    const dot = el('live-res-dot');
    const stateEl = el('live-res-state');
    const hasWarn = snap.overall.droppedWindows > 0
      || snap.overall.longTaskCount > 0
      || snap.overloadCount > 0
      || snap.lastDutyPct >= 60;
    if (dot) dot.dataset.tone = snap.active ? (hasWarn ? 'warn' : 'live') : (hasData ? 'ok' : '');
    if (stateEl) {
      if (snap.active) {
        stateEl.textContent = snap.bgSeconds > 0
          ? `运行中 · 后台已记 ${formatSec(snap.bgSeconds)}`
          : `运行中 · ${formatSec(snap.totalSeconds)}`;
      } else if (hasData) {
        stateEl.textContent = snap.bgSeconds > 0
          ? `已停止 · 后台已记 ${formatSec(snap.bgSeconds)}`
          : `已停止 · 共 ${formatSec(snap.totalSeconds)}`;
      } else {
        stateEl.textContent = '待机 · 含后台记录';
      }
    }

    // 1. Model inference (CPU single-thread WASM)
    const inferTone = snap.overall.droppedWindows > 0 || snap.lastDutyPct >= 75
      ? 'alert'
      : snap.lastDutyPct >= 40 ? 'warn' : 'ok';
    const inferText = snap.overall.inferenceCount > 0
      ? `${snap.lastTotalMs.toFixed(0)}ms/${snap.hopSeconds}s (${snap.lastDutyPct.toFixed(0)}%核)`
      : (snap.active ? '等待首窗…' : '--');
    const inferTitle = snap.overall.inferenceCount > 0
      ? `最近: 前处理 ${snap.lastFrontendMs}ms + 推理 ${snap.lastInferenceMs}ms | 全程均 ${snap.overall.inferenceAvgMs}ms / 峰 ${snap.overall.inferenceMaxMs}ms | 后台均 ${snap.background.inferenceAvgMs}ms / 峰 ${snap.background.inferenceMaxMs}ms | 跳窗 ${snap.overall.droppedWindows}`
      : '每 2 秒音频模型前处理 + WASM 单核推理耗时（后台持续记录）';
    setMeter('live-res-infer-chip', 'live-res-infer-fill', 'live-res-infer-val', {
      text: inferText,
      pct: snap.lastDutyPct,
      tone: inferTone,
      title: inferTitle,
    });

    // 2. Proxy video encoding throughput
    const isAudioOnly = snap.sourceKind === 'device';
    const pipeTag = isAudioOnly ? '无视频' : (snap.proxyMode === 'eco' ? '2fps' : '720p30');
    const encBitrate = isAudioOnly ? 0 : snap.lastBitrateBps;
    const encText = (snap.active || hasData)
      ? `${formatBitrate(encBitrate)} · ${pipeTag}`
      : '--';
    const encTone = snap.overloadCount > 0 || snap.lastChunkGapMs > 4400
      ? 'warn'
      : 'ok';
    setMeter('live-res-encode-chip', 'live-res-encode-fill', 'live-res-encode-val', {
      text: encText,
      pct: (encBitrate / 3_000_000) * 100,
      tone: encTone,
      title: `当前管线: ${pipeTag} | 最近分片间隔: ${snap.lastChunkGapMs}ms | 后台均码率: ${formatBitrate(snap.background.encodeAvgBitrateBps)} | 过载次数: ${snap.overloadCount}`,
    });

    // 3. Foreground UI rendering
    const renderText = snap.active
      ? `${snap.renderFps}fps · ${snap.renderAvgMs.toFixed(1)}ms`
      : (hasData ? '已停绘' : '--');
    const renderTone = snap.renderAvgMs >= 12 ? 'alert' : (snap.renderAvgMs >= 6 ? 'warn' : 'ok');
    setMeter('live-res-render-chip', 'live-res-render-fill', 'live-res-render-val', {
      text: renderText,
      pct: (snap.renderAvgMs / 16.6) * 100,
      tone: renderTone,
      title: '前台波形与进度条重绘帧率及单帧耗时；切入游戏后台时自动停绘（0fps）',
    });

    // 4. Memory (proxy buffer + JS heap + optional measured total)
    const memParts = [`缓冲 ${formatMB(snap.proxyBytes)}`];
    if (snap.jsHeapBytes !== null) memParts.push(`堆 ${formatMB(snap.jsHeapBytes)}`);
    if (snap.totalMemory) memParts.push(`总 ${formatMB(snap.totalMemory.bytes)}`);
    const proxyPct = (snap.proxyBytes / Math.max(1, snap.proxyMaxBytes)) * 100;
    const memTone = proxyPct >= 80 ? 'warn' : 'ok';
    setMeter('live-res-mem-chip', 'live-res-mem-fill', 'live-res-mem-val', {
      text: memParts.join(' · '),
      pct: proxyPct,
      tone: memTone,
      title: `回看缓冲上限 ${formatMB(snap.proxyMaxBytes)} | 全程缓冲峰值 ${formatMB(snap.overall.peakProxyBytes)} | JS 堆峰值 ${formatMB(snap.overall.peakJsHeapBytes)}`,
    });

    // 5. Main-thread long tasks (stalls >50ms)
    const stallCount = snap.overall.longTaskCount;
    const bgStallCount = snap.background.longTaskCount;
    const stallText = stallCount > 0
      ? `长任务 ${stallCount} (峰${snap.overall.longTaskMaxMs.toFixed(0)}ms${bgStallCount > 0 ? ` · 后台${bgStallCount}` : ''})`
      : '长任务 0';
    const stallTone = snap.overall.longTaskMaxMs >= 150 ? 'alert' : (stallCount > 0 ? 'warn' : 'ok');
    setMeter('live-res-stall-chip', 'live-res-stall-fill', 'live-res-stall-val', {
      text: stallText,
      pct: Math.min(100, stallCount * 20),
      tone: stallTone,
      title: `主线程阻塞 >50ms 次数：全程 ${stallCount} 次（峰 ${snap.overall.longTaskMaxMs}ms），后台 ${bgStallCount} 次（峰 ${snap.background.longTaskMaxMs}ms）`,
    });

    const exportBtn = el('live-res-export');
    if (exportBtn) exportBtn.disabled = !hasData;

    const detailsEl = el('live-res-details');
    if (detailsEl) {
      detailsEl.hidden = !resourceDetailsOpen;
      if (resourceDetailsOpen) {
        const bg = snap.background;
        const ov = snap.overall;
        const memNote = snap.totalMemory
          ? `最近一次手动总内存测量（${formatClock(snap.totalMemory.measuredAtMs)}）：<strong>${formatMB(snap.totalMemory.bytes)}</strong>`
          : '可点击「测总内存」按需检测含 WASM/MSE 的页面总内存（不会在游戏时自动触发 GC）。';
        detailsEl.innerHTML = `
          <div class="live-res-detail-grid">
            <div class="live-res-detail-card">
              <div class="live-res-detail-title">后台期间（游戏内 · ${formatSec(snap.bgSeconds)}）</div>
              <dl class="live-res-kv">
                <div><dt>模型推理</dt><dd>均 ${bg.inferenceAvgMs}ms · P95 ${bg.inferenceP95Ms}ms · 峰 ${bg.inferenceMaxMs}ms (${bg.dutyPct}%单核 · 跳${bg.droppedWindows})</dd></div>
                <div><dt>代理编码</dt><dd>均 ${formatBitrate(bg.encodeAvgBitrateBps)} · 峰 ${formatBitrate(bg.encodeMaxBitrateBps)} · 最大间隔 ${bg.encodeMaxGapMs}ms</dd></div>
                <div><dt>主线程卡顿</dt><dd>${bg.longTaskCount} 次（最大 ${bg.longTaskMaxMs}ms）· 后台已自动停绘波形</dd></div>
                <div><dt>内存峰值</dt><dd>缓冲 ${formatMB(bg.peakProxyBytes)}${bg.peakJsHeapBytes ? ` · JS堆 ${formatMB(bg.peakJsHeapBytes)}` : ''}</dd></div>
              </dl>
            </div>
            <div class="live-res-detail-card">
              <div class="live-res-detail-title">全程统计（共 ${formatSec(snap.totalSeconds)} · 前台 ${formatSec(snap.fgSeconds)}）</div>
              <dl class="live-res-kv">
                <div><dt>模型推理</dt><dd>均 ${ov.inferenceAvgMs}ms · P95 ${ov.inferenceP95Ms}ms · 峰 ${ov.inferenceMaxMs}ms (${ov.dutyPct}%单核 · 跳${ov.droppedWindows})</dd></div>
                <div><dt>代理编码</dt><dd>均 ${formatBitrate(ov.encodeAvgBitrateBps)} · 峰 ${formatBitrate(ov.encodeMaxBitrateBps)} · 过载 ${snap.overloadCount} 次</dd></div>
                <div><dt>关联对齐</dt><dd>${snap.conformCount} 次${snap.conformCount ? `（最近 ${snap.lastConformMs}ms · 最大 ${snap.maxConformMs}ms）` : ''}</dd></div>
                <div><dt>采样记录</dt><dd>${snap.sampleCount} 条（每 2s 随推理事件记账，无后台轮询）</dd></div>
              </dl>
            </div>
          </div>
          <div class="live-res-detail-foot">
            <p class="muted live-res-detail-note">${memNote} 浏览器沙箱无法读取 GPU 3D/编码器占用，对比不同模式 GPU 开销时请配合系统任务管理器查看。</p>
            <ul class="live-res-events"></ul>
          </div>
        `;
        const eventsUl = detailsEl.querySelector('.live-res-events');
        if (eventsUl) {
          if (!snap.recentEvents.length) {
            const li = document.createElement('li');
            li.className = 'muted';
            li.textContent = '暂无关键事件';
            eventsUl.append(li);
          } else {
            eventsUl.replaceChildren(...snap.recentEvents.slice().reverse().map((evt) => {
              const li = document.createElement('li');
              li.textContent = formatEventLine(evt);
              return li;
            }));
          }
        }
      }
    }
  }

  function renderMetrics() {
    const snap = session.snapshot();
    const statusPill = el('live-pill-status');
    statusPill.textContent = snap.active
      ? (snap.gateActive ? '已暂停' : dvrMode ? `回看 ${formatLag(dvrLagSec)}` : `LIVE · ${formatSec(snap.durationSec)}`)
      : '未开始';
    statusPill.dataset.tone = snap.active ? (snap.gateActive ? 'warn' : 'live') : '';

    const memPill = el('live-pill-mem');
    memPill.textContent = `缓存 ${formatMB(proxyState.bufferedBytes)} / ${formatMB(proxyState.maxBytes)}`;
    memPill.dataset.tone = proxyState.bufferedBytes > proxyState.maxBytes * 0.8 ? 'warn' : '';
  }

  function renderWatcher() {
    const dirPill = el('live-pill-dir');
    dirPill.textContent = watcherState.watching ? `目录：${watcherState.directoryName}` : '未选录像目录';
    dirPill.dataset.tone = watcherState.watching ? 'ok' : '';
    el('live-btn-poll-now').disabled = !watcherState.watching;
    const detail = el('live-watcher-detail');
    if (!watcherState.watching) {
      detail.textContent = '未选择录像目录；模拟模式下可点击上方「关联此录像」。';
    } else if (!watcherState.tracked.length) {
      detail.textContent = `监听「${watcherState.directoryName}」中，等待新录像保存…`;
    } else {
      detail.textContent = watcherState.tracked.map((t) => `${t.name} [${t.state}]`).join(' · ');
    }
  }

  let renderedMasters = null;
  let renderedEvents = null;
  let cardsRefreshPending = false;

  function refreshAfterRelease() {
    if (container.querySelector('.live-list :active')) {
      requestAnimationFrame(refreshAfterRelease);
      return;
    }
    cardsRefreshPending = false;
    renderPanels();
  }

  function renderPanels() {
    const snap = session.snapshot();
    renderMetrics();
    renderWatcher();

    // A new row can move a pressed button even if its DOM node survives. Keep
    // both lists in place through native click dispatch, then show the latest snapshot.
    if (cardsRefreshPending) return;
    if (container.querySelector('.live-list :active')) {
      cardsRefreshPending = true;
      requestAnimationFrame(refreshAfterRelease);
      return;
    }

    renderConformed(snap.conformed);
    renderLiveEvents(snap);
  }

  function renderConformed(masters) {
    if (renderedMasters?.length === masters.length && masters.every((item, i) => item === renderedMasters[i])) return;
    renderedMasters = masters;
    const conformedList = el('live-conformed-list');
    el('live-conformed-count').textContent = String(masters.length);
    if (!masters.length) {
      conformedList.innerHTML = '<p class="muted">暂无关联录像。新录像保存后会自动对齐并出现在这里。</p>';
    } else {
      conformedList.replaceChildren(...masters.map((item) => {
        const card = document.createElement('div');
        card.className = 'live-card';
        const badge = item.alignment.confidence === 'exact'
          ? `精确对齐 (${item.alignment.offsetMs >= 0 ? '+' : ''}${item.alignment.offsetMs}ms)`
          : '粗略对齐';
        const body = document.createElement('div');
        body.className = 'live-card-body';
        const name = document.createElement('strong');
        name.textContent = item.name;
        const summary = document.createElement('small');
        summary.textContent = `${formatSec(item.duration)} · ${badge} · 标记 ${item.liveDecisions.length} 条`;
        body.append(name, summary);
        const actions = document.createElement('div');
        actions.className = 'live-card-actions';
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.type = 'button';
        btn.textContent = '去剪辑';
        btn.onclick = () => { void onOpenMasterReview(item); };
        actions.append(btn);
        card.append(body, actions);
        return card;
      }));
    }
  }

  function renderLiveEvents(snap) {
    const eventsList = el('live-events-list');
    const items = [
      ...snap.decisions.map((d) => ({
        id: d.id,
        title: d.kind === 'retain' ? `打点 · ${formatClock(d.wallStartMs)}` : `已排除 · ${formatClock(d.wallStartMs)}`,
        sub: `${((d.wallEndMs - d.wallStartMs) / 1000).toFixed(1)}s`,
        excluded: d.kind === 'exclude',
        thumbnail: d.thumbnail,
        isDecision: true,
        wallStartMs: d.wallStartMs,
        wallEndMs: d.wallEndMs,
      })),
      ...snap.candidates.map((c) => {
        const win = snap.scoreWindows.find((w) => w.wallEndMs >= c.wallStartMs && w.wallStartMs <= c.wallEndMs && w.thumbnail);
        return {
          id: c.id,
          title: `枪声 · ${formatClock(c.wallStartMs)}`,
          sub: `${((c.wallEndMs - c.wallStartMs) / 1000).toFixed(1)}s`,
          excluded: c.excluded,
          thumbnail: win?.thumbnail || null,
          isDecision: false,
          wallStartMs: c.wallStartMs,
          wallEndMs: c.wallEndMs,
        };
      }),
    ].sort((a, b) => b.wallStartMs - a.wallStartMs);

    el('live-events-count').textContent = String(items.length);
    const visible = items.slice(0, 30);
    if (renderedEvents?.length === visible.length && visible.every((item, i) => {
      const previous = renderedEvents[i];
      return previous.id === item.id && previous.excluded === item.excluded &&
        previous.thumbnail === item.thumbnail && previous.wallStartMs === item.wallStartMs &&
        previous.wallEndMs === item.wallEndMs;
    })) return;
    renderedEvents = visible;
    if (!visible.length) {
      eventsList.innerHTML = '<p class="muted">暂无片段，等待识别枪声或手动打点。</p>';
    } else {
      eventsList.replaceChildren(...visible.map((item) => {
        const card = document.createElement('div');
        card.className = 'live-card';
        card.dataset.excluded = String(!!item.excluded);
        const jumpToEvent = () => {
          const latest = session.snapshot().latestEpochMs || Date.now();
          const lag = Math.max(0, (latest - item.wallStartMs) / 1000);
          dvrPaused = false;
          seekDvrByLag(lag, { autoPlay: true });
        };
        if (item.thumbnail) {
          const img = document.createElement('img');
          img.src = item.thumbnail;
          img.alt = item.title;
          img.onclick = jumpToEvent;
          card.append(img);
        }
        const body = document.createElement('div');
        body.className = 'live-card-body';
        body.title = '点击跳转到该时刻回看';
        body.innerHTML = `<strong>${item.title}</strong><small>${item.sub}</small>`;
        body.onclick = jumpToEvent;
        const actions = document.createElement('div');
        actions.className = 'live-card-actions';
        const btn = document.createElement('button');
        btn.className = 'quiet';
        btn.type = 'button';
        btn.textContent = item.isDecision ? '撤销' : (item.excluded ? '已排除' : '排除');
        btn.disabled = !item.isDecision && item.excluded;
        btn.onclick = (event) => {
          event.stopPropagation();
          if (item.isDecision) session.removeDecision(item.id);
          else session.excludeRange({ wallStartMs: item.wallStartMs, wallEndMs: item.wallEndMs });
        };
        actions.append(btn);
        card.append(body, actions);
        return card;
      }));
    }
  }

  // Wire UI interactions
  el('live-btn-sim').onclick = () => el('live-sim-file').click();
  el('live-sim-file').onchange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { await startSimulatedFromFile(file); }
    catch (error) { setNotice(error.message || String(error), 'warn'); }
  };
  el('live-btn-display').onclick = async () => {
    try { await startDisplayCapture(); }
    catch (error) { setNotice(error.message || String(error), 'warn'); }
  };
  el('live-btn-device').onclick = async () => {
    try { await startDeviceCapture(); }
    catch (error) { setNotice(error.message || String(error), 'warn'); }
  };
  el('live-btn-stop').onclick = () => { void stopCapture(); };

  el('live-dvr-playpause').onclick = () => {
    const snap = session.snapshot();
    if (!snap.active) return;
    if (!dvrMode) {
      // Pausing live immediately enters timeshifted DVR at current live edge!
      dvrPaused = true;
      seekDvrByLag(0.2, { autoPlay: false });
    } else if (dvrPaused) {
      dvrPaused = false;
      seekDvrByLag(dvrLagSec, { autoPlay: true });
    } else {
      dvrPaused = true;
      dvrAnchorWallMs = (snap.latestEpochMs || Date.now()) - dvrLagSec * 1000;
      replayVideo.pause();
      syncDvrGate();
      syncDvrControlsUI();
    }
  };
  el('live-dvr-mute').onclick = () => {
    dvrMuted = !dvrMuted;
    replayVideo.muted = dvrMuted;
    syncDvrGate();
    syncDvrControlsUI();
  };
  el('live-badge-btn').onclick = () => {
    if (dvrMode) returnToLive();
  };
  el('live-btn-mark').onclick = () => {
    const snap = session.snapshot();
    if (!snap.active) return;
    const latestMs = snap.latestEpochMs || Date.now();
    const targetMs = dvrMode ? Math.max(snap.startEpochMs, latestMs - dvrLagSec * 1000) : latestMs;
    const videoForSnap = dvrMode && proxyState.mode === 'smooth' ? replayVideo : liveVideo;
    session.addMark({
      wallStartMs: Math.max(snap.startEpochMs, targetMs - 5000),
      wallEndMs: targetMs + 5000,
      thumbnail: proxyBuffer.captureSnapshot(videoForSnap),
    });
    setNotice(`已在 ${formatClock(targetMs)} 打点。`, 'ok');
  };

  el('live-window-sec').onchange = () => {
    const sec = Number(el('live-window-sec').value);
    session.setWindowSeconds(sec);
    proxyBuffer.setWindowSeconds(sec);
  };
  el('live-proxy-mode').onchange = () => {
    const nextMode = el('live-proxy-mode').value;
    proxyBuffer.setMode(nextMode);
    resourceMonitor.setContext({ proxyMode: nextMode });
    if (dvrMode) seekDvrByLag(dvrLagSec, { autoPlay: !dvrPaused });
    renderResourceBar(true);
  };
  el('live-res-toggle').onclick = () => {
    resourceDetailsOpen = !resourceDetailsOpen;
    el('live-res-toggle').setAttribute('aria-expanded', String(resourceDetailsOpen));
    el('live-res-toggle').textContent = resourceDetailsOpen ? '收起明细' : '后台明细';
    renderResourceBar(true);
  };
  el('live-res-measure-mem').onclick = async () => {
    const btn = el('live-res-measure-mem');
    btn.disabled = true;
    btn.textContent = '测量中…';
    try {
      const result = await resourceMonitor.measureTotalMemory();
      if (result.supported) {
        setNotice(`当前标签页总内存（含 WASM / 回看缓冲）：${formatMB(result.bytes)}。`, 'ok');
      } else {
        setNotice(result.reason || '当前浏览器不支持总内存测量。', 'warn');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '测总内存';
      renderResourceBar(true);
    }
  };
  el('live-res-export').onclick = () => {
    const report = resourceMonitor.exportReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apex-live-resources-${formatFileStamp()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`已导出 ${report.samples.length} 条采样与 ${report.events.length} 条事件（含后台游戏期间记录）。`, 'ok');
  };
  el('live-threshold').onchange = () => {
    session.setThreshold(Number(el('live-threshold').value));
  };
  el('live-sim-audible').onchange = () => {
    if (simGainNode && audioCtx) {
      simGainNode.gain.setValueAtTime(el('live-sim-audible').checked ? 0.5 : 0, audioCtx.currentTime);
    }
  };
  el('live-btn-sim-conform').onclick = async () => {
    if (!simSourceFile) return;
    const injectedOffsetMs = Number(el('live-sim-offset').value) || 0;
    const trueStartEpochMs = simStartWallMs - simStartMediaSec * 1000;
    const simulatedCoarseStartMs = trueStartEpochMs - injectedOffsetMs;
    await conformFile(simSourceFile, { coarseStartOverrideMs: simulatedCoarseStartMs });
  };
  el('live-btn-watch-dir').onclick = async () => {
    if (typeof window.showDirectoryPicker !== 'function') {
      setNotice('当前浏览器不支持目录选择，请使用桌面 Chrome 或 Edge。', 'warn');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ id: 'apex-live-watch-dir', mode: 'read' });
      await watcher.start(dir);
      setNotice(`已监听目录「${dir.name}」，等待新录像保存。`, 'ok');
    } catch (error) {
      if (error.name !== 'AbortError') setNotice(`目录选择失败：${error.message || error}`, 'warn');
    }
  };
  el('live-btn-poll-now').onclick = () => { void watcher.pollNow(); };

  setNotice(liveNotice, liveTone);
  renderPanels();
  renderResourceBar(true);

  return {
    session,
    watcher,
    proxyBuffer,
    resourceMonitor,
    notifyExternalPlayback(isPlayingUnmuted) {
      if (!session.snapshot().active) return;
      session.setPlaybackGate(isPlayingUnmuted, '复核播放中，已暂停监听');
      proxyBuffer.setPaused(isPlayingUnmuted);
      if (workletNode) workletNode.port.postMessage({ type: 'pause', value: isPlayingUnmuted });
    },
    registerExportedFilename(name) {
      watcher.registerExportedFilename(name);
    },
    stop: stopCapture,
  };
}

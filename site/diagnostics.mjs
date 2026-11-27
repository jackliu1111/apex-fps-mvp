/**
 * Local-only, privacy-safe environment & runtime diagnostics collector.
 *
 * Collects browser/OS/GPU/audio/WebCodecs/WASM capabilities, anonymized workspace
 * metrics, pure-audio Live Monitor & auto-intake status summaries, and recent
 * sanitized error logs for one-click clipboard copy. Never reads or includes file
 * names, folder names, local paths, or media bytes.
 */

const DEFAULT_MAX_LOG_ENTRIES = 30;
const MAX_MESSAGE_LENGTH = 400;
const CODEC_PROBE_TIMEOUT_MS = 1200;

// Minimal valid WebAssembly module exercising a v128 / SIMD opcode (i32x4.splat).
const WASM_SIMD_PROBE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
  0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
]);

const VIDEO_DECODE_PROBES = [
  { key: 'h264_1080p', codec: 'avc1.64002a', codedWidth: 1920, codedHeight: 1080 },
  { key: 'hevc_1080p', codec: 'hvc1.1.6.L120.90', codedWidth: 1920, codedHeight: 1080 },
  { key: 'hevc_10bit_4k', codec: 'hvc1.2.4.L153.B0', codedWidth: 3840, codedHeight: 2160 },
  { key: 'vp9_1080p', codec: 'vp09.00.41.08', codedWidth: 1920, codedHeight: 1080 },
  { key: 'av1_1080p', codec: 'av01.0.08M.08', codedWidth: 1920, codedHeight: 1080 },
];

const VIDEO_ENCODE_PROBES = [
  { key: 'h264_1080p60', codec: 'avc1.64002a', width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60 },
  { key: 'h264_720p30', codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 },
  { key: 'vp8_1080p30', codec: 'vp8', width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 },
  { key: 'vp9_720p30', codec: 'vp09.00.31.08', width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 },
];

const AUDIO_ENCODE_PROBES = [
  { key: 'aac', codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 },
  { key: 'opus', codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
];

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function bytesToMB(bytes) {
  return Number.isFinite(bytes) && bytes >= 0 ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null;
}

function withTimeout(promise, ms, fallbackValue = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), ms);
      if (typeof timer?.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Strip local filesystem paths, file:// and blob: URLs, and bound length so
 * diagnostics can be shared publicly without leaking personal paths or filenames.
 */
export function sanitizeDiagnosticText(input, maxLength = MAX_MESSAGE_LENGTH) {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : (input?.message || String(input));
  text = text
    // file:// URLs
    .replace(/\bfile:\/\/[^\s"'`<>)\]]+/gi, '<file-url>')
    // blob: URLs
    .replace(/\bblob:[^\s"'`<>)\]]+/gi, '<blob-url>')
    // Windows drive paths (e.g. C:\Users\Alice\Videos\match.mp4 or D:/Clips/foo.mkv)
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>|*?]+/g, '<win-path>')
    // Windows UNC paths (\\server\share\...)
    .replace(/\\\\[^\s"'`<>|*?]+\\[^\s"'`<>|*?]+/g, '<unc-path>')
    // Common POSIX home/volume/temp paths
    .replace(/(?:^|[\s"'`(])(\/(?:Users|home|Volumes|mnt|media|private|tmp|var|opt)\/[^\s"'`<>)\]]+)/g, (match, pathPart) => match.replace(pathPart, '<posix-path>'))
    // Strip embedded video/audio filenames with common extensions if standalone
    .replace(/[^\s"'`<>\\/:]+\.(?:mp4|mkv|mov|webm|avi|flv|ts|m4v|wav|mp3|aac|flac)\b/gi, '<media-file>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

export function createDiagnosticLog({ maxEntries = DEFAULT_MAX_LOG_ENTRIES } = {}) {
  const entries = [];
  const detachCallbacks = [];

  function record(source, errorOrMessage, extra = null, nowMs = Date.now()) {
    const rawMessage = errorOrMessage instanceof Error
      ? `${errorOrMessage.name ? `${errorOrMessage.name}: ` : ''}${errorOrMessage.message || String(errorOrMessage)}`
      : String(errorOrMessage ?? '');
    const message = sanitizeDiagnosticText(rawMessage);
    if (!message) return null;
    const entry = {
      ts: new Date(nowMs).toISOString(),
      source: String(source || 'app'),
      message,
    };
    if (extra && typeof extra === 'object') {
      const cleanExtra = {};
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === 'number' || typeof v === 'boolean') cleanExtra[k] = v;
        else if (typeof v === 'string') cleanExtra[k] = sanitizeDiagnosticText(v, 120);
      }
      if (Object.keys(cleanExtra).length) entry.detail = cleanExtra;
    }
    entries.push(entry);
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
    return entry;
  }

  function attachGlobalListeners(target = globalThis) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    const onError = (event) => {
      record('window.error', event?.error || event?.message || 'Unknown script error', {
        lineno: Number.isFinite(event?.lineno) ? event.lineno : undefined,
        colno: Number.isFinite(event?.colno) ? event.colno : undefined,
      });
    };
    const onRejection = (event) => {
      record('unhandledrejection', event?.reason || 'Unhandled promise rejection');
    };
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    const detach = () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    };
    detachCallbacks.push(detach);
    return detach;
  }

  return {
    record,
    attachGlobalListeners,
    entries() { return entries.map((item) => ({ ...item, ...(item.detail ? { detail: { ...item.detail } } : {}) })); },
    clear() { entries.length = 0; },
    dispose() {
      while (detachCallbacks.length) {
        try { detachCallbacks.pop()(); } catch {}
      }
    },
  };
}

export function probeWasmSimd(wasm = globalThis.WebAssembly) {
  if (!wasm || typeof wasm.validate !== 'function') return false;
  try { return !!wasm.validate(WASM_SIMD_PROBE_BYTES); }
  catch { return false; }
}

export function probeGpuInfo(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  let gl = null;
  try {
    const canvas = doc.createElement('canvas');
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { webgl: false, vendor: null, renderer: null };
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR);
    const renderer = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return {
      webgl: true,
      vendor: typeof vendor === 'string' ? vendor : null,
      renderer: typeof renderer === 'string' ? renderer : null,
    };
  } catch {
    return { webgl: false, vendor: null, renderer: null };
  } finally {
    try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
  }
}

export async function probeAudioOutput(env = globalThis) {
  const Ctor = env?.AudioContext || env?.webkitAudioContext;
  if (typeof Ctor !== 'function') return { supported: false };
  let ctx = null;
  try {
    ctx = new Ctor();
    const info = {
      supported: true,
      sampleRate: Number.isFinite(ctx.sampleRate) ? ctx.sampleRate : null,
      maxChannelCount: Number.isFinite(ctx.destination?.maxChannelCount) ? ctx.destination.maxChannelCount : null,
      channelCount: Number.isFinite(ctx.destination?.channelCount) ? ctx.destination.channelCount : null,
      baseLatencyMs: Number.isFinite(ctx.baseLatency) ? round1(ctx.baseLatency * 1000) : null,
      outputLatencyMs: Number.isFinite(ctx.outputLatency) ? round1(ctx.outputLatency * 1000) : null,
      state: ctx.state || null,
    };
    return info;
  } catch (error) {
    return { supported: false, error: sanitizeDiagnosticText(error, 120) };
  } finally {
    if (ctx && typeof ctx.close === 'function') {
      try { await withTimeout(ctx.close(), 300); } catch {}
    }
  }
}

async function probeCodecWithHardware(api, config) {
  if (!api || typeof api.isConfigSupported !== 'function') {
    return { supported: false, hardwareSupported: false };
  }
  try {
    const [defaultRes, hwRes] = await Promise.all([
      withTimeout(api.isConfigSupported(config), CODEC_PROBE_TIMEOUT_MS, null),
      withTimeout(api.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' }), CODEC_PROBE_TIMEOUT_MS, null),
    ]);
    return {
      supported: Boolean(defaultRes?.supported),
      hardwareSupported: Boolean(hwRes?.supported),
    };
  } catch {
    return { supported: false, hardwareSupported: false };
  }
}

export async function probeWebCodecs(env = globalThis) {
  const videoDecode = {};
  const videoEncode = {};
  const audioEncode = {};

  await Promise.all([
    ...VIDEO_DECODE_PROBES.map(async ({ key, ...config }) => {
      videoDecode[key] = await probeCodecWithHardware(env?.VideoDecoder, config);
    }),
    ...VIDEO_ENCODE_PROBES.map(async ({ key, ...config }) => {
      videoEncode[key] = await probeCodecWithHardware(env?.VideoEncoder, config);
    }),
    ...AUDIO_ENCODE_PROBES.map(async ({ key, ...config }) => {
      if (!env?.AudioEncoder || typeof env.AudioEncoder.isConfigSupported !== 'function') {
        audioEncode[key] = { supported: false };
        return;
      }
      try {
        const res = await withTimeout(env.AudioEncoder.isConfigSupported(config), CODEC_PROBE_TIMEOUT_MS, null);
        audioEncode[key] = { supported: Boolean(res?.supported) };
      } catch {
        audioEncode[key] = { supported: false };
      }
    }),
  ]);

  return { videoDecode, videoEncode, audioEncode };
}

function summarizeWorkspace(state) {
  if (!state) return null;
  const sources = Array.isArray(state.sources) ? state.sources.map((src) => ({
    status: src.status || null,
    durationSec: round1(src.duration),
    processedUntilSec: round1(src.processedUntil),
    width: Number.isFinite(src.width) ? src.width : null,
    height: Number.isFinite(src.height) ? src.height : null,
    videoCodec: src.videoCodec || null,
    audioTrackCount: Number.isFinite(src.audioTrackCount) ? src.audioTrackCount : null,
    audioCodecs: Array.isArray(src.audioCodecs) ? src.audioCodecs.slice(0, 6) : [],
    model: src.model || null,
    candidateCount: Number.isFinite(src.candidateCount) ? src.candidateCount : null,
    selectedCount: Number.isFinite(src.selectedCount) ? src.selectedCount : null,
    timingsMs: src.timings ? {
      decode: round1(src.timings.decodeMs),
      read: round1(src.timings.readMs),
      initialize: round1(src.timings.initializeMs),
      frontend: round1(src.timings.frontendMs),
      inference: round1(src.timings.inferenceMs),
      firstReviewable: round1(src.timings.firstReviewableMs),
    } : null,
    error: src.error ? sanitizeDiagnosticText(src.error, 200) : null,
  })) : [];

  const batches = Array.isArray(state.batches) ? state.batches.map((b) => ({
    status: b.status || null,
    format: b.format || null,
    clipCount: Number.isFinite(b.clipCount) ? b.clipCount : null,
    savedCount: Number.isFinite(b.savedCount) ? b.savedCount : null,
    error: b.error ? sanitizeDiagnosticText(b.error, 200) : null,
  })) : [];

  return {
    sourceCount: sources.length,
    sources,
    batchCount: batches.length,
    batches,
    hasOutputDirectory: Boolean(state.hasOutputDirectory),
    player: state.player ? {
      status: state.player.status || null,
      playing: Boolean(state.player.playing),
      muted: Boolean(state.player.muted),
    } : null,
  };
}

function summarizeLiveMonitor(live) {
  if (!live) return null;
  return {
    status: live.status || 'off',
    active: Boolean(live.active),
    sourceKind: live.sourceKind || 'system',
    gateActive: Boolean(live.gateActive),
    silenceWarning: Boolean(live.silenceWarning),
    modelStatus: live.modelStatus || null,
    inferenceCount: Number.isFinite(live.inferenceCount) ? live.inferenceCount : 0,
    historyDurationSec: round1(live.historyDurationSec),
    disconnectReason: live.disconnectReason ? sanitizeDiagnosticText(live.disconnectReason, 160) : null,
    error: live.error ? sanitizeDiagnosticText(live.error, 200) : null,
  };
}

function summarizeAutoIntake(intake) {
  if (!intake) return null;
  return {
    status: intake.status || 'unset',
    watching: Boolean(intake.watching),
    needsRestore: Boolean(intake.needsRestore),
    autoAnalyzeUncovered: Boolean(intake.autoAnalyzeUncovered),
    processingCount: Number.isFinite(intake.processingCount) ? intake.processingCount : 0,
    intakeCount: Number.isFinite(intake.intakeCount) ? intake.intakeCount : 0,
    lastIntakeKind: intake.lastIntake?.kind || intake.lastIntakeKind || null,
    error: intake.error ? sanitizeDiagnosticText(intake.error, 200) : null,
  };
}

/**
 * Collect a complete, sanitized diagnostic snapshot.
 */
export async function collectDiagnostics({
  env = globalThis,
  getState = () => ({}),
  log = null,
  nowMs = Date.now(),
} = {}) {
  const nav = env?.navigator || {};
  const loc = env?.location || {};
  const doc = env?.document || null;
  const scr = env?.screen || {};
  const perf = env?.performance || {};
  const state = (() => {
    try { return getState() || {}; }
    catch { return {}; }
  })();

  const host = String(loc.hostname || '');
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

  const [audio, codecs, storageEstimate] = await Promise.all([
    probeAudioOutput(env),
    probeWebCodecs(env),
    nav?.storage && typeof nav.storage.estimate === 'function'
      ? withTimeout(nav.storage.estimate().catch(() => null), 500, null)
      : Promise.resolve(null),
  ]);

  const gpu = probeGpuInfo(doc);
  const wasmSimd = probeWasmSimd(env?.WebAssembly);

  const mem = perf?.memory;
  const memory = {
    jsHeapUsedMB: mem ? bytesToMB(mem.usedJSHeapSize) : null,
    jsHeapTotalMB: mem ? bytesToMB(mem.totalJSHeapSize) : null,
    jsHeapLimitMB: mem ? bytesToMB(mem.jsHeapSizeLimit) : null,
    storageUsageMB: storageEstimate ? bytesToMB(storageEstimate.usage) : null,
    storageQuotaMB: storageEstimate ? bytesToMB(storageEstimate.quota) : null,
  };

  const uaData = nav.userAgentData ? {
    platform: nav.userAgentData.platform || null,
    mobile: Boolean(nav.userAgentData.mobile),
    brands: Array.isArray(nav.userAgentData.brands)
      ? nav.userAgentData.brands.map((b) => `${b.brand}/${b.version}`)
      : [],
  } : null;

  return {
    schemaVersion: 1,
    collectedAt: new Date(nowMs).toISOString(),
    privacyNote: 'Local diagnostics only; file names, folder names, local paths, and media data are excluded.',
    app: {
      page: state.page || 'analysis',
      language: state.language || null,
      protocol: loc.protocol || null,
      isLocalhost,
    },
    environment: {
      userAgent: nav.userAgent || '',
      userAgentData: uaData,
      platform: nav.platform || '',
      language: nav.language || '',
      hardwareConcurrency: Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null,
      deviceMemoryGB: Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null,
      screen: {
        width: Number.isFinite(scr.width) ? scr.width : null,
        height: Number.isFinite(scr.height) ? scr.height : null,
        devicePixelRatio: Number.isFinite(env?.devicePixelRatio) ? round1(env.devicePixelRatio) : null,
      },
      viewport: {
        width: Number.isFinite(env?.innerWidth) ? env.innerWidth : null,
        height: Number.isFinite(env?.innerHeight) ? env.innerHeight : null,
      },
      visibilityState: doc?.visibilityState || null,
    },
    securityAndCapabilities: {
      isSecureContext: Boolean(env?.isSecureContext),
      crossOriginIsolated: Boolean(env?.crossOriginIsolated),
      sharedArrayBuffer: typeof env?.SharedArrayBuffer !== 'undefined',
      webAssembly: typeof env?.WebAssembly !== 'undefined',
      wasmSimd,
      webGpu: Boolean(nav.gpu),
      webCodecs: {
        videoDecoder: typeof env?.VideoDecoder === 'function',
        videoEncoder: typeof env?.VideoEncoder === 'function',
        audioDecoder: typeof env?.AudioDecoder === 'function',
        audioEncoder: typeof env?.AudioEncoder === 'function',
      },
      fileSystemAccess: {
        showDirectoryPicker: typeof env?.showDirectoryPicker === 'function',
        showOpenFilePicker: typeof env?.showOpenFilePicker === 'function',
        opfs: typeof nav?.storage?.getDirectory === 'function',
      },
      mediaCapture: {
        getDisplayMedia: typeof nav?.mediaDevices?.getDisplayMedia === 'function',
        getUserMedia: typeof nav?.mediaDevices?.getUserMedia === 'function',
        audioWorklet: typeof env?.AudioWorkletNode === 'function',
      },
      clipboardWriteText: typeof nav?.clipboard?.writeText === 'function',
      totalMemoryApi: typeof perf?.measureUserAgentSpecificMemory === 'function',
    },
    gpu,
    audio,
    codecs,
    memory,
    workspace: summarizeWorkspace(state.workspace),
    liveMonitor: summarizeLiveMonitor(state.liveMonitor),
    autoIntake: summarizeAutoIntake(state.autoIntake),
    recentErrors: log && typeof log.entries === 'function' ? log.entries() : [],
  };
}

/**
 * Copy text to clipboard using Clipboard API with execCommand fallback.
 */
export async function copyTextToClipboard(text, env = globalThis) {
  const nav = env?.navigator;
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Fall through to execCommand fallback.
    }
  }
  const doc = env?.document;
  if (doc && doc.body && typeof doc.createElement === 'function' && typeof doc.execCommand === 'function') {
    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    doc.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      const copied = Boolean(doc.execCommand('copy'));
      if (copied) return { ok: true, method: 'execCommand' };
    } catch {
      // Fall through to failure.
    } finally {
      textarea.remove();
    }
  }
  return { ok: false, method: 'failed' };
}

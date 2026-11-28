import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDiagnosticText,
  createDiagnosticLog,
  collectDiagnostics,
  copyTextToClipboard,
  probeWasmSimd,
} from '../../../site/diagnostics.mjs';

test('sanitizeDiagnosticText strips Windows/POSIX paths, URLs, and media filenames', () => {
  const raw = [
    'Failed to read C:\\Users\\Gamer\\Videos\\Apex\\2026-11-20.mp4',
    'and D:/Recordings/obs_match.mkv',
    'from \\\\NAS\\clips\\highlight.webm',
    'at /Users/jack/Movies/secret.mov',
    'file:///C:/Users/Gamer/Desktop/test.mp4',
    'blob:http://127.0.0.1:8792/1234-5678',
    'clip=ranked_clutch.mp4',
  ].join(' ');

  const clean = sanitizeDiagnosticText(raw);
  assert.doesNotMatch(clean, /Gamer|jack|Apex|obs_match|highlight|secret|ranked_clutch/i);
  assert.match(clean, /<win-path>/);
  assert.match(clean, /<unc-path>/);
  assert.match(clean, /<posix-path>/);
  assert.match(clean, /<file-url>/);
  assert.match(clean, /<blob-url>/);
  assert.match(clean, /<media-file>/);

  const longText = 'x'.repeat(500);
  const truncated = sanitizeDiagnosticText(longText, 80);
  assert.equal(truncated.length, 80);
  assert.ok(truncated.endsWith('…'));
});

test('createDiagnosticLog bounds entries, sanitizes details, and hooks global listeners', () => {
  const log = createDiagnosticLog({ maxEntries: 2 });
  log.record('analysis', new Error('Cannot decode C:\\Users\\Bob\\clip.mp4'), { file: 'D:\\secret\\match.mkv', retry: 1 }, 1000);
  log.record('export', 'Write failed on /Users/bob/Videos/out.mp4', null, 2000);
  log.record('ui.error', 'Third error pushes out first', null, 3000);

  const entries = log.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].source, 'export');
  assert.doesNotMatch(entries[0].message, /bob|out\.mp4/i);
  assert.equal(entries[1].source, 'ui.error');

  const listeners = new Map();
  const fakeWindow = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const detach = log.attachGlobalListeners(fakeWindow);
  listeners.get('error')({ error: new Error('Boom at C:\\Temp\\a.mp4'), lineno: 42, colno: 7 });
  listeners.get('unhandledrejection')({ reason: new Error('Rejected /Users/me/b.mkv') });

  const afterGlobal = log.entries();
  assert.equal(afterGlobal.length, 2);
  assert.equal(afterGlobal[0].source, 'window.error');
  assert.equal(afterGlobal[0].detail.lineno, 42);
  assert.doesNotMatch(afterGlobal[0].message, /Temp|a\.mp4/i);
  assert.equal(afterGlobal[1].source, 'unhandledrejection');
  assert.doesNotMatch(afterGlobal[1].message, /\/Users\/me|b\.mkv/i);

  detach();
  assert.equal(listeners.size, 0);
});

test('collectDiagnostics gathers Windows browser/GPU/audio/codec/workspace telemetry without leaking names', async () => {
  let lostContextCalled = false;
  let audioClosed = false;

  const fakeGl = {
    VENDOR: 1,
    RENDERER: 2,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 101, UNMASKED_RENDERER_WEBGL: 102 };
      }
      if (name === 'WEBGL_lose_context') {
        return { loseContext() { lostContextCalled = true; } };
      }
      return null;
    },
    getParameter(code) {
      if (code === 101) return 'Google Inc. (NVIDIA)';
      if (code === 102) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)';
      return null;
    },
  };

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.baseLatency = 0.01;
      this.outputLatency = 0.025;
      this.state = 'running';
      this.destination = { maxChannelCount: 8, channelCount: 2 };
    }
    async close() { audioClosed = true; }
  }

  const fakeEnv = {
    isSecureContext: true,
    crossOriginIsolated: true,
    SharedArrayBuffer: globalThis.SharedArrayBuffer,
    WebAssembly: globalThis.WebAssembly,
    devicePixelRatio: 1.25,
    innerWidth: 2560,
    innerHeight: 1440,
    screen: { width: 2560, height: 1440 },
    location: { protocol: 'https:', hostname: 'fpslocalcut.top' },
    document: {
      visibilityState: 'visible',
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return { getContext: () => fakeGl };
      },
    },
    performance: {
      memory: {
        usedJSHeapSize: 64 * 1024 * 1024,
        totalJSHeapSize: 128 * 1024 * 1024,
        jsHeapSizeLimit: 4096 * 1024 * 1024,
      },
      measureUserAgentSpecificMemory: async () => ({ bytes: 120 * 1024 * 1024 }),
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Edg/131.0.0.0',
      userAgentData: {
        platform: 'Windows',
        mobile: false,
        brands: [{ brand: 'Microsoft Edge', version: '131' }],
      },
      platform: 'Win32',
      language: 'zh-CN',
      hardwareConcurrency: 16,
      deviceMemory: 8,
      gpu: {},
      clipboard: { writeText: async () => {} },
      mediaDevices: { getDisplayMedia: async () => {}, getUserMedia: async () => {} },
      storage: {
        getDirectory: async () => ({}),
        estimate: async () => ({ usage: 50 * 1024 * 1024, quota: 2048 * 1024 * 1024 }),
      },
    },
    showDirectoryPicker: async () => ({}),
    showOpenFilePicker: async () => ([]),
    AudioWorkletNode: function AudioWorkletNode() {},
    AudioContext: FakeAudioContext,
    VideoDecoder: {
      async isConfigSupported(cfg) {
        if (cfg.codec.startsWith('hvc1.2.4') && cfg.hardwareAcceleration === 'prefer-hardware') {
          return { supported: false };
        }
        return { supported: true };
      },
    },
    VideoEncoder: {
      async isConfigSupported(cfg) {
        return { supported: cfg.codec.startsWith('avc1') || cfg.codec === 'vp8' };
      },
    },
    AudioEncoder: {
      async isConfigSupported(cfg) {
        return { supported: cfg.codec === 'mp4a.40.2' || cfg.codec === 'opus' };
      },
    },
  };

  const log = createDiagnosticLog();
  log.record('export', 'Disk full writing D:\\ApexClips\\secret_match.mp4', null, 1700000000000);

  const report = await collectDiagnostics({
    env: fakeEnv,
    log,
    nowMs: 1700000005000,
    getState: () => ({
      page: 'review',
      language: 'zh',
      workspace: {
        hasOutputDirectory: true,
        player: {
          status: 'paused',
          playing: false,
          muted: false,
          metrics: { framesDisplayed: 120, seeks: 2, lastSeekMs: 245.67, maxFrameLagMs: 14.23 },
        },
        sources: [{
          status: 'complete',
          duration: 1800.44,
          sizeBytes: 3 * 1024 * 1024 * 1024,
          processedUntil: 1800.44,
          width: 2560,
          height: 1440,
          videoCodec: 'avc1.640032',
          audioTrackCount: 2,
          audioCodecs: ['aac', 'opus'],
          model: 'efficientsed',
          candidateCount: 14,
          selectedCount: 5,
          timings: { decodeMs: 1200.4, sourceDecodeWaitMs: 980.12, audioWaitMs: 1100.56, inferenceMs: 3400.7, totalMs: 5200.34, firstReviewableMs: 850.2 },
          error: null,
        }],
        batches: [{
          status: 'completed',
          format: 'mp4',
          clipCount: 5,
          savedCount: 5,
          error: null,
        }],
      },
      liveMonitor: {
        status: 'listening',
        active: true,
        sourceKind: 'system',
        audioLabel: 'System Audio Secret Label',
        gateActive: false,
        silenceWarning: false,
        modelStatus: 'ready',
        inferenceCount: 42,
        historyDurationSec: 300.46,
        disconnectReason: null,
        error: null,
      },
      autoIntake: {
        status: 'watching',
        name: 'OBS_Private_Folder',
        watching: true,
        needsRestore: false,
        autoAnalyzeUncovered: true,
        processingCount: 1,
        intakeCount: 3,
        lastIntake: {
          kind: 'conformed-exact',
          name: 'secret_match.mp4',
        },
        error: 'Skipped C:\\Users\\Gamer\\Videos\\partial.mkv',
      },
    }),
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal('mode' in report.app, false, 'legacy dual-mode switcher field must be removed');
  assert.equal(report.app.page, 'review');
  assert.equal(report.app.isLocalhost, false);
  assert.equal(report.environment.userAgentData.platform, 'Windows');
  assert.equal(report.environment.screen.devicePixelRatio, 1.3);
  assert.equal(report.securityAndCapabilities.crossOriginIsolated, true);
  assert.equal(report.securityAndCapabilities.wasmSimd, probeWasmSimd());
  assert.equal(report.gpu.renderer, 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)');
  assert.equal(lostContextCalled, true, 'WebGL probe context must be released');
  assert.equal(report.audio.sampleRate, 48000);
  assert.equal(report.audio.maxChannelCount, 8);
  assert.equal(audioClosed, true, 'AudioContext probe must be closed');
  assert.equal(report.codecs.videoDecode.hevc_10bit_4k.supported, true);
  assert.equal(report.codecs.videoDecode.hevc_10bit_4k.hardwareSupported, false);
  assert.equal(report.codecs.videoEncode.h264_1080p60.supported, true);
  assert.equal(report.codecs.videoEncode.vp9_720p30.supported, false);
  assert.equal(report.codecs.audioEncode.aac.supported, true);
  assert.equal('mediaRecorder' in report.securityAndCapabilities.mediaCapture, false, 'obsolete MediaRecorder capability must be removed');
  assert.equal('mediaRecorder' in report.codecs, false, 'obsolete MediaRecorder mime probe must be removed');
  assert.equal(report.memory.jsHeapUsedMB, 64);
  assert.equal(report.memory.storageUsageMB, 50);
  assert.equal(report.workspace.sourceCount, 1);
  assert.equal(report.workspace.sources[0].width, 2560);
  assert.equal(report.workspace.sources[0].sizeMB, 3072);
  assert.equal(report.workspace.sources[0].timingsMs.sourceDecodeWait, 980.1);
  assert.equal(report.workspace.sources[0].timingsMs.total, 5200.3);
  assert.deepEqual(report.workspace.player.metrics, {
    framesDisplayed: 120,
    seeks: 2,
    lastSeekMs: 245.7,
    maxFrameLagMs: 14.2,
  });
  assert.equal('liveCompanion' in report, false, 'legacy liveCompanion diagnostics section must be removed');
  assert.deepEqual(report.liveMonitor, {
    status: 'listening',
    active: true,
    sourceKind: 'system',
    gateActive: false,
    silenceWarning: false,
    modelStatus: 'ready',
    inferenceCount: 42,
    historyDurationSec: 300.5,
    disconnectReason: null,
    error: null,
  });
  assert.deepEqual(report.autoIntake, {
    status: 'watching',
    watching: true,
    needsRestore: false,
    autoAnalyzeUncovered: true,
    processingCount: 1,
    intakeCount: 3,
    lastIntakeKind: 'conformed-exact',
    error: 'Skipped <win-path>',
  });

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /ApexClips|secret_match\.mp4|OBS_Private_Folder|System Audio Secret Label|partial\.mkv/);
});

test('collectDiagnostics handles missing or throwing browser APIs gracefully', async () => {
  const minimalEnv = {
    isSecureContext: false,
    crossOriginIsolated: false,
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    navigator: { userAgent: 'MinimalBrowser/1.0' },
    VideoDecoder: { isConfigSupported: () => Promise.reject(new Error('not allowed')) },
  };
  const report = await collectDiagnostics({ env: minimalEnv });
  assert.equal(report.app.isLocalhost, true);
  assert.equal(report.securityAndCapabilities.isSecureContext, false);
  assert.equal(report.codecs.videoDecode.h264_1080p.supported, false);
  assert.equal(report.audio.supported, false);
  assert.equal(report.gpu, null);
});

test('copyTextToClipboard uses Clipboard API first and falls back to execCommand', async () => {
  let written = null;
  const res1 = await copyTextToClipboard('{"ok":1}', {
    navigator: { clipboard: { writeText: async (txt) => { written = txt; } } },
  });
  assert.deepEqual(res1, { ok: true, method: 'clipboard' });
  assert.equal(written, '{"ok":1}');

  let removed = false;
  let execCopied = false;
  const fakeTextarea = {
    value: '',
    style: {},
    setAttribute() {},
    focus() {},
    select() {},
    remove() { removed = true; },
  };
  const res2 = await copyTextToClipboard('{"ok":2}', {
    navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    document: {
      body: { appendChild() {} },
      createElement: () => fakeTextarea,
      execCommand: (cmd) => { execCopied = cmd === 'copy'; return true; },
    },
  });
  assert.deepEqual(res2, { ok: true, method: 'execCommand' });
  assert.equal(fakeTextarea.value, '{"ok":2}');
  assert.equal(execCopied, true);
  assert.equal(removed, true);

  const res3 = await copyTextToClipboard('{"ok":3}', {});
  assert.deepEqual(res3, { ok: false, method: 'failed' });
});

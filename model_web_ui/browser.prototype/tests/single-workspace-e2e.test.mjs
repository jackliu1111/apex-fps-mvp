import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createWorkspaceEngineBridge } from '../../../site/workspace-engine-bridge.mjs';
import { createLibraryIntakeControls } from '../../../site/library-intake-controls.mjs';
import { translations } from '../../../site/i18n.js';
import { createBrowserAnalysis } from '../../../site/browser-analysis.mjs';
import { createReviewWorkspace } from '../../../site/review-workspace.mjs';
import { createExportQueue } from '../../../site/export-queue.mjs';
import { createWorkspaceUxController, reconcileSplitSelection, dispatchReviewPrimaryAction } from '../../../site/split-workspace-controller.mjs';
import { projectRecordingLibrary } from '../../../site/recording-library-projection.mjs';
import { createBrowserConverter } from '../../../site/browser-export.mjs';
import { ENVELOPE_STEP_SECONDS } from '../../../site/audio-aligner.mjs';
import { LIVE_MONITOR_STATES, AUDIO_SOURCE_KINDS } from '../../../site/live-monitor-engine.mjs';
import { INTAKE_EVENT_KINDS } from '../../../site/auto-intake-service.mjs';

function mp4Box(type, payloadOrLength = 8) {
  const payload = typeof payloadOrLength === 'number' ? new Uint8Array(payloadOrLength) : payloadOrLength;
  const buf = new Uint8Array(8 + payload.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 8 + payload.length, false);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(payload, 8);
  return buf;
}

function makeFinalizedMp4(name, { lastModified = 50_000, extraSeed = 1 } = {}) {
  const payload = new Uint8Array(64);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + extraSeed) & 0xff;
  return new File(
    [mp4Box('ftyp', 16), mp4Box('mdat', payload), mp4Box('moov', 32)],
    name,
    { type: 'video/mp4', lastModified },
  );
}

function buildPatternPcm(durationSec, sampleRate = 16000, seed = 1) {
  const totalSamples = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(totalSamples);
  const stepSamples = Math.round(ENVELOPE_STEP_SECONDS * sampleRate);
  const bucketCount = Math.floor(totalSamples / stepSamples);
  const buckets = new Float32Array(bucketCount * 2);
  for (let b = 0; b < bucketCount; b++) {
    const t = b * ENVELOPE_STEP_SECONDS;
    // Distinct high-variance combat burst pattern for deterministic NCC exact alignment
    let amp = 0.04;
    if (t >= 3 && t < 3.4) amp = 0.85;
    else if (t >= 5.2 && t < 5.7) amp = 0.65;
    else if (t >= 8.0 && t < 8.5) amp = 0.92;
    else if (t >= 11.4 && t < 11.9) amp = 0.78;
    else if (t >= 15.0 && t < 15.6) amp = 0.88;
    else amp = 0.04 + 0.08 * Math.abs(Math.sin((b + seed * 13) * 0.31));
    const start = b * stepSamples;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < stepSamples; i++) {
      const val = amp * Math.sin(2 * Math.PI * (440 + (b % 7) * 90) * ((start + i) / sampleRate));
      samples[start + i] = val;
      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      sumSq += val * val;
    }
    buckets[b * 2] = peak;
    buckets[b * 2 + 1] = Math.sqrt(sumSq / stepSamples);
  }
  return { samples, buckets, sampleRate };
}

function createFakeAudioHardware({
  devices = [
    { kind: 'audioinput', deviceId: 'virt-1', label: 'VB-Cable Virtual Output', groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'USB Headset Mic', groupId: 'g2' },
  ],
} = {}) {
  const displayCalls = [];
  const userCalls = [];
  const workletNodes = [];
  const workers = [];
  const activeStreams = [];

  function makeTrack(kind, label, deviceId = null) {
    const listeners = new Map();
    return {
      kind,
      label,
      readyState: 'live',
      stoppedCount: 0,
      getSettings() { return deviceId ? { deviceId } : {}; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      emit(type) { for (const fn of [...(listeners.get(type) || [])]) fn({}); },
      stop() { this.stoppedCount++; this.readyState = 'ended'; },
    };
  }

  function makeStream({ videoTracks = [], audioTracks = [] }) {
    const tracks = [...videoTracks, ...audioTracks];
    const stream = {
      videoTracks,
      audioTracks,
      removedTracks: [],
      getTracks() { return [...tracks]; },
      getVideoTracks() { return tracks.filter((t) => t.kind === 'video'); },
      getAudioTracks() { return tracks.filter((t) => t.kind === 'audio'); },
      removeTrack(track) {
        const idx = tracks.indexOf(track);
        if (idx >= 0) { tracks.splice(idx, 1); this.removedTracks.push(track); }
      },
    };
    activeStreams.push(stream);
    return stream;
  }

  const mediaDevices = {
    async getDisplayMedia(constraints) {
      displayCalls.push(constraints);
      return makeStream({
        videoTracks: [makeTrack('video', 'Apex Display')],
        audioTracks: [makeTrack('audio', 'System Audio')],
      });
    },
    async getUserMedia(constraints) {
      userCalls.push(constraints);
      const devId = constraints?.audio?.deviceId?.exact || devices[0]?.deviceId || 'default';
      const label = devices.find((d) => d.deviceId === devId)?.label || 'Virtual Device';
      return makeStream({
        audioTracks: [makeTrack('audio', label, devId)],
      });
    },
    async enumerateDevices() {
      return devices;
    },
  };

  class FakeAudioContext {
    constructor() {
      this.destination = { kind: 'destination' };
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }

  class FakeAudioWorkletNode {
    constructor(_ctx, _name, opts) {
      this.opts = opts;
      this.pausedMessages = [];
      this.port = {
        onmessage: null,
        postMessage: (msg) => {
          if (msg?.type === 'pause') this.pausedMessages.push(msg.value);
        },
      };
      workletNodes.push(this);
    }
    connect() {}
    disconnect() {}
    emitEnvelope(buckets, silentSeconds = 0) {
      this.port.onmessage?.({ data: { type: 'envelope', buckets, silentSeconds } });
    }
    emitWindow(waveform) {
      this.port.onmessage?.({ data: { type: 'window', waveform } });
    }
  }

  const classes = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun', 'Glass shatter'];
  const manifest = {
    model: 'EfficientSED',
    modelFile: 'fmn10-tf256.onnx',
    classes,
    sampleRate: 16000,
    windowSeconds: 10,
    strideSeconds: 5,
    frameSeconds: 0.04,
    scoreType: 'frame',
    output: [1, 250, classes.length],
  };

  class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      workers.push(this);
    }
    postMessage(msg) {
      const values = new Float32Array(250 * classes.length);
      for (let f = 60; f <= 85; f++) values[f * classes.length + 1] = 0.91;
      queueMicrotask(() => {
        this.onmessage?.({
          data: { type: 'result', id: msg.id, values, dims: [1, 250, classes.length], timings: { inferenceMs: 4 } },
        });
      });
    }
    terminate() {}
  }

  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => manifest });

  return {
    mediaDevices,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    Worker: FakeWorker,
    fetch: fetchImpl,
    manifest,
    classes,
    displayCalls,
    userCalls,
    workletNodes,
    workers,
    activeStreams,
  };
}

function createFakeDirectory(name, filesMap, { permission = 'granted' } = {}) {
  const permissionQueries = [];
  const writtenFiles = new Map();
  return {
    name,
    permissionQueries,
    writtenFiles,
    async queryPermission(opts) {
      permissionQueries.push(opts);
      return permission;
    },
    async requestPermission(opts) {
      permissionQueries.push({ ...opts, requested: true });
      return permission;
    },
    async *entries() {
      for (const [fileName, file] of filesMap.entries()) {
        yield [fileName, { kind: 'file', async getFile() { return file; } }];
      }
    },
  };
}

function createSingleWorkspaceHarness({ durationByName = {}, pcmByName = {}, nowRef = { value: 1_700_000_000_000 } } = {}) {
  const audioHw = createFakeAudioHardware();
  let offlineInferCalls = 0;

  class FakeAudioBufferSink {
    constructor(track) { this.track = track; }
    async *buffers(from, to) {
      const spec = pcmByName[this.track.fileName];
      if (!spec) return;
      const { sampleRate, samples } = spec;
      const startSample = Math.max(0, Math.floor(from * sampleRate));
      const endSample = Math.min(samples.length, Math.ceil(to * sampleRate));
      if (endSample <= startSample) return;
      const slice = samples.subarray(startSample, endSample);
      yield {
        timestamp: startSample / sampleRate,
        buffer: {
          sampleRate,
          numberOfChannels: 1,
          length: slice.length,
          duration: slice.length / sampleRate,
          getChannelData: () => slice,
        },
      };
    }
  }

  const MB = {
    ALL_FORMATS: [],
    BlobSource: class { constructor(file) { this.file = file; } },
    AudioBufferSink: FakeAudioBufferSink,
    Input: class {
      constructor({ source }) { this.file = source.file; }
      async getPrimaryVideoTrack() {
        const dur = durationByName[this.file?.name] ?? 24;
        return { displayWidth: 1920, displayHeight: 1080, getFirstTimestamp: async () => 0, computeDuration: async () => dur };
      }
      async getAudioTracks() {
        const dur = durationByName[this.file?.name] ?? 24;
        return [{ id: 1, fileName: this.file?.name, codec: 'opus', canDecode: async () => true, getFirstTimestamp: async () => 0, computeDuration: async () => dur }];
      }
      async getPrimaryAudioTrack() { return (await this.getAudioTracks())[0]; }
      dispose() {}
    },
  };

  const openAudioStream = (_mb, _track, _origin, audioLen, sampleRate, check, _metrics, onDecoded) => {
    let idx = 0;
    return {
      async next() {
        check();
        onDecoded({
          timestamp: idx * 5,
          buffer: {
            duration: Math.min(5, Math.max(0, audioLen - idx * 5)),
            numberOfChannels: 1,
            getChannelData: () => new Float32Array([0.4]),
          },
        });
        idx++;
        return new Float32Array(sampleRate * 10);
      },
      async close() {},
    };
  };

  const bindings = new Map();
  const identified = new WeakMap();
  const pendingImports = new Map();
  let currentView = { sources: [], batches: [] };
  let activeSourceId = null;
  let activeRecordId = null;
  let loadedSourceId = null;
  let loadedFile = null;

  const uxController = createWorkspaceUxController({ storage: null });
  const workspace = createReviewWorkspace({
    onChange(next) {
      currentView = next;
      reconcile();
    },
  });

  const identify = async (file) => ({
    id: `source:${file.name}`,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    fingerprint: `${file.name}:${file.size}:${file.lastModified}`,
    fingerprintVersion: 'v1',
  });

  const queue = createBrowserAnalysis({
    MB,
    openAudioStream,
    fetch: audioHw.fetch,
    infer: async () => {
      offlineInferCalls++;
      const values = new Float32Array(250 * audioHw.classes.length);
      for (let f = 100; f <= 120; f++) values[f * audioHw.classes.length + 1] = 0.93;
      return { values, dims: [1, 250, audioHw.classes.length], timings: { inferenceMs: 5 } };
    },
    onWaveform(record, wf) { if (record.sourceId) workspace.updateWaveform(record.sourceId, wf); },
    async onPrepared(record) {
      const id = identified.get(record.file) || await identify(record.file);
      record.sourceId = workspace.addSource({ ...id, duration: record.duration });
      bindings.set(record.sourceId, record);
      uxController.promoteRecordingNew(`runtime:${record.id}`, record.sourceId, { activeSourceId });
    },
    onCandidates(record, cands) { if (record.sourceId) workspace.publishCandidates(record.sourceId, cands); },
    onChange(record) {
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
      reconcile();
    },
  });

  const notices = [];
  const pickerCalls = [];
  let pickerResult = null;
  let bridge = null;

  const exportQueue = createExportQueue({
    convert: async ({ batch, clip, index, source }) => {
      const outName = `${source.file.name.replace(/\.[^.]+$/, '')}-clip-${index + 1}.mp4`;
      bridge.registerExportedFilename(outName);
      source.directoryHandle.writtenFiles.set(outName, { start: clip.start, end: clip.end });
      return {
        name: outName,
        bytes: 1_200_000,
        start: clip.start,
        end: clip.end,
        requestedDuration: clip.end - clip.start,
        measuredDuration: clip.end - clip.start,
        saved: true,
      };
    },
    onChange({ id, status, outputs, error, progress, clipResults, destination }) {
      workspace.updateBatch(id, { status, outputs, error, progress, clipResults, destination });
    },
    onOutput(_batchId, output) {
      if (output?.name) bridge.registerExportedFilename(output.name);
    },
  });

  bridge = createWorkspaceEngineBridge({
    MB,
    queue,
    uxController,
    identified,
    identify,
    now: () => nowRef.value,
    isSecureContext: () => true,
    showDirectoryPicker: async (opts) => {
      pickerCalls.push(opts);
      if (!pickerResult) throw new DOMException('Aborted', 'AbortError');
      return pickerResult;
    },
    getActiveSourceId: () => activeSourceId,
    isLibraryEmpty: () => currentView.sources.length === 0 && queue.records.length === 0,
    liveMonitorOptions: {
      mediaDevices: audioHw.mediaDevices,
      AudioContext: audioHw.AudioContext,
      AudioWorkletNode: audioHw.AudioWorkletNode,
      Worker: audioHw.Worker,
      fetch: audioHw.fetch,
      now: () => nowRef.value,
    },
    autoIntakeOptions: {
      pollIntervalMs: 60_000,
      stablePollsRequired: 2,
    },
    onNotice: (message, tone) => notices.push({ message, tone }),
  });

  function snapshotLibrary() {
    const effectiveNewIds = new Set(uxController.getNewRecordingIds());
    for (const record of queue.records) {
      if (!record || record.sourceId) continue;
      const pendingId = record.file ? identified.get(record.file) : null;
      if (pendingId && effectiveNewIds.has(pendingId.id)) effectiveNewIds.add(`runtime:${record.id}`);
    }
    const bridgeState = bridge.getState();
    return projectRecordingLibrary({
      sources: currentView.sources,
      records: queue.records,
      batches: currentView.batches,
      activeSourceId,
      newIds: effectiveNewIds,
      liveMonitor: bridgeState.liveMonitor,
      watchDirectory: bridgeState.watchDirectory,
      sortOrder: 'newest-first',
    });
  }

  function reconcile() {
    const snap = snapshotLibrary();
    const rec = reconcileSplitSelection({
      items: snap.items,
      activeSourceId,
      activeRecordId,
      loadedSourceId,
      loadedFile,
      getFileForId: (id) => bindings.get(id)?.file || null,
    });
    activeSourceId = rec.activeSourceId;
    activeRecordId = rec.activeRecordId;
    if (rec.changed && activeSourceId) uxController.clearRecordingNew(activeSourceId);
    if (rec.shouldReloadPlayer) {
      loadedSourceId = activeSourceId;
      loadedFile = bindings.get(activeSourceId)?.file || null;
    }
    uxController.pruneNewIds([
      ...snap.items.map((item) => item.id),
      ...pendingImports.keys(),
      ...bridge.getPendingIntakeIds(),
    ]);
    return snapshotLibrary();
  }

  function openRecording(id) {
    activeSourceId = id;
    uxController.onRecordingOpened(id);
    loadedSourceId = id;
    loadedFile = bindings.get(id)?.file || null;
    return reconcile();
  }

  return {
    audioHw,
    bridge,
    workspace,
    queue,
    exportQueue,
    uxController,
    bindings,
    identified,
    notices,
    pickerCalls,
    setPickerResult(dir) { pickerResult = dir; },
    get activeSourceId() { return activeSourceId; },
    get offlineInferCalls() { return offlineInferCalls; },
    snapshotLibrary,
    openRecording,
    async dispose() {
      await bridge.dispose();
      await exportQueue.dispose();
      await queue.dispose();
    },
  };
}

test('Path A E2E: live monitor -> watch folder auto-intake exact conform with New badge (no focus/review switch) -> review -> isolated export increments saved count & suppresses self-ingestion', async (t) => {
  const nowRef = { value: 1_700_000_000_000 };
  const durationSec = 24;
  const pattern = buildPatternPcm(durationSec, 16000, 1);

  const harness = createSingleWorkspaceHarness({
    durationByName: {
      'existing-match.mp4': 20,
      '2026-11-26_15-20_Olympus_Win.mp4': durationSec,
    },
    pcmByName: {
      '2026-11-26_15-20_Olympus_Win.mp4': pattern,
    },
    nowRef,
  });
  t.after(() => harness.dispose());

  // 1. Pre-existing recording is already open in the right review pane
  const existingFile = makeFinalizedMp4('existing-match.mp4', { lastModified: nowRef.value - 600_000, extraSeed: 2 });
  await harness.queue.importFiles([existingFile], { autoAnalyze: false });
  assert.equal(harness.activeSourceId, 'source:existing-match.mp4');

  // 2. Choose read-only watch folder via bridge
  const watchFiles = new Map();
  const watchDir = createFakeDirectory('/Users/player/Videos/OBS Captures/', watchFiles);
  harness.setPickerResult(watchDir);
  await harness.bridge.chooseWatchDirectory();
  assert.equal(harness.pickerCalls.length, 1);
  assert.equal(harness.pickerCalls[0].mode, 'read', 'Watch folder picker must request read-only mode');
  assert.equal(harness.bridge.watchDirState.status, 'watching');
  assert.equal(harness.bridge.watchDirState.name, 'OBS Captures', 'Watch folder display name must be basename only');

  // 3. Start pure-audio live monitoring & accumulate real live history
  await harness.bridge.toggleLiveMonitor();
  assert.equal(harness.bridge.getState().liveMonitor.status, LIVE_MONITOR_STATES.LISTENING);
  const worklet = harness.audioHw.workletNodes[0];
  assert.ok(worklet);

  // Feed 24s of envelope buckets and 2 inference windows into live monitor
  const liveStartMs = nowRef.value;
  nowRef.value = liveStartMs + durationSec * 1000;
  worklet.emitEnvelope(pattern.buckets, 0);
  worklet.emitWindow(new Float32Array(16000 * 10));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(harness.bridge.getState().liveMonitor.inferenceCount >= 1);

  // 4. External recorder saves matching recording in watch folder (lastModified = end of recording + 300ms write delay)
  const newRecording = makeFinalizedMp4('2026-11-26_15-20_Olympus_Win.mp4', {
    lastModified: liveStartMs + durationSec * 1000 + 300,
    extraSeed: 3,
  });
  watchFiles.set(newRecording.name, newRecording);
  // Discover + two stable polls finalize intake
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();

  // 5. Verify exact conform without offline scan, New badge set, and active review NOT interrupted
  assert.equal(harness.offlineInferCalls, 0, 'Exact conform must skip offline scan');
  assert.equal(harness.activeSourceId, 'source:existing-match.mp4', 'Auto-intake must NOT switch away from active review');

  const snapAfterIntake = harness.snapshotLibrary();
  assert.equal(snapAfterIntake.items.length, 2);
  assert.equal(snapAfterIntake.items[0].id, 'source:2026-11-26_15-20_Olympus_Win.mp4');
  assert.equal(snapAfterIntake.items[0].status, 'ready', 'Exact conform projects to ready');
  assert.equal(snapAfterIntake.items[0].isNew, true, 'Newly auto-ingested recording must have New badge');
  assert.ok(snapAfterIntake.items[0].candidateCount >= 1, 'Conformed recording must carry live gunshot candidates');
  assert.equal(harness.bridge.autoIntake.getState().lastIntake?.kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);

  // 6. User clicks newly arrived recording in sidebar -> opens for review and clears New badge
  const snapAfterOpen = harness.openRecording('source:2026-11-26_15-20_Olympus_Win.mp4');
  assert.equal(harness.activeSourceId, 'source:2026-11-26_15-20_Olympus_Win.mp4');
  assert.equal(snapAfterOpen.items[0].isNew, false, 'Opening recording must clear New badge');

  // Make a manual trim decision and submit export to an isolated readwrite output directory
  const openedSource = harness.workspace.getSource('source:2026-11-26_15-20_Olympus_Win.mp4');
  const firstClip = openedSource.clips.find((c) => c.selected && !c.provisional);
  assert.ok(firstClip);
  harness.workspace.trim(openedSource.id, firstClip.id, { start: Math.max(0, firstClip.start), end: Math.min(durationSec, firstClip.start + 4) });

  const exportDir = createFakeDirectory('Apex Exports', new Map(), { permission: 'granted' });
  const batch = harness.workspace.submitBatch(openedSource.id, {
    audio: { trackIndex: 0, policy: 'source-primary' },
    output: { format: 'mp4', videoCodec: 'avc', audioCodec: 'aac' },
  });
  const record = harness.bindings.get(openedSource.id);
  harness.exportQueue.enqueue(batch, { file: record.file, origin: record.origin || 0, directoryHandle: exportDir });
  await harness.exportQueue.whenIdle();

  // 7. Verify exported count incremented in sidebar & exported filename is suppressed if placed in watch folder
  const snapAfterExport = harness.snapshotLibrary();
  assert.equal(snapAfterExport.items[0].exportedCount, 1, 'Saved export count must increment in library sidebar');
  const [exportedName] = [...exportDir.writtenFiles.keys()];
  assert.ok(exportedName);

  // Even if user exported into the same folder as watchDir, self-export suppression prevents re-ingestion!
  watchFiles.set(exportedName, makeFinalizedMp4(exportedName, { lastModified: nowRef.value + 5000, extraSeed: 99 }));
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();
  assert.equal(harness.snapshotLibrary().items.length, 2, 'Self-exported clip must be suppressed from re-intake');
});

test('Path B E2E: uncovered recording finalizes in watch dir -> auto-intake as unanalyzed without offline scan -> select & right-header Start Analysis -> ready -> review & export', async (t) => {
  const nowRef = { value: 1_700_000_000_000 };
  const harness = createSingleWorkspaceHarness({
    durationByName: { 'uncovered-warmup.mp4': 20 },
    nowRef,
  });
  t.after(() => harness.dispose());

  // Library starts empty; live monitor is OFF; watch directory is active.
  const watchFiles = new Map();
  const watchDir = createFakeDirectory('Apex Captures', watchFiles);
  harness.setPickerResult(watchDir);
  await harness.bridge.chooseWatchDirectory();
  assert.equal(harness.snapshotLibrary().items.length, 0);

  // Uncovered recording finalizes in watch folder
  const uncovered = makeFinalizedMp4('uncovered-warmup.mp4', { lastModified: nowRef.value + 25_000, extraSeed: 11 });
  watchFiles.set(uncovered.name, uncovered);
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();
  await harness.queue.whenIdle();

  // Enters library as 'unanalyzed' WITHOUT triggering background offline inference!
  assert.equal(harness.offlineInferCalls, 0, 'Uncovered auto-intake must NOT run background offline analysis');
  assert.equal(harness.bridge.autoIntake.getState().lastIntake?.kind, INTAKE_EVENT_KINDS.UNANALYZED);

  // Because library was empty, split workspace selects the newly arrived recording without New badge
  const snapInitial = harness.snapshotLibrary();
  assert.equal(snapInitial.items.length, 1);
  assert.equal(snapInitial.items[0].id, 'source:uncovered-warmup.mp4');
  assert.equal(snapInitial.items[0].status, 'unanalyzed');
  assert.equal(snapInitial.items[0].isNew, false, 'Auto-selected first item from empty library should not keep New badge');
  assert.equal(harness.activeSourceId, 'source:uncovered-warmup.mp4');

  // Trigger right-header primary action ("开始分析") via bridge.dispatchPrimaryAction
  const record = harness.bindings.get('source:uncovered-warmup.mp4');
  const dispatch = await harness.bridge.dispatchPrimaryAction({
    item: snapInitial.items[0],
    record,
  });
  assert.deepEqual(dispatch, { dispatched: true, kind: 'analyze' });
  await harness.queue.whenIdle();

  assert.ok(harness.offlineInferCalls >= 1, 'Manual Start Analysis must run offline inference');
  const snapReady = harness.snapshotLibrary();
  assert.equal(snapReady.items[0].status, 'ready');
  assert.ok(snapReady.items[0].candidateCount >= 1);

  // Review & submit export to isolated readwrite folder
  const exportDir = createFakeDirectory('Exports', new Map());
  const batch = harness.workspace.submitBatch('source:uncovered-warmup.mp4', {
    audio: { trackIndex: 0, policy: 'source-primary' },
    output: { format: 'mp4', videoCodec: 'avc', audioCodec: 'aac' },
  });
  harness.exportQueue.enqueue(batch, { file: record.file, origin: record.origin || 0, directoryHandle: exportDir });
  await harness.exportQueue.whenIdle();

  assert.equal(harness.snapshotLibrary().items[0].exportedCount, 1);
});

test('Coarse-aligned conform -> right-header Re-analyze Offline replaces coarse alignment with full offline analysis while preserving manual review decisions', async (t) => {
  const nowRef = { value: 1_700_000_000_000 };
  const durationSec = 24;
  const livePattern = buildPatternPcm(durationSec, 16000, 1);
  // Flat constant-amplitude uncorrelated audio -> forces coarse alignment fallback!
  const flatSamples = new Float32Array(durationSec * 16000);
  for (let i = 0; i < flatSamples.length; i++) flatSamples[i] = 0.05 * Math.sin(i * 0.05);

  const harness = createSingleWorkspaceHarness({
    durationByName: { 'coarse-match.mp4': durationSec },
    pcmByName: { 'coarse-match.mp4': { samples: flatSamples, sampleRate: 16000 } },
    nowRef,
  });
  t.after(() => harness.dispose());

  const watchFiles = new Map();
  const watchDir = createFakeDirectory('OBS Folder', watchFiles);
  harness.setPickerResult(watchDir);
  await harness.bridge.chooseWatchDirectory();

  await harness.bridge.toggleLiveMonitor();
  const worklet = harness.audioHw.workletNodes[0];
  const liveStartMs = nowRef.value;
  nowRef.value = liveStartMs + durationSec * 1000;
  worklet.emitEnvelope(livePattern.buckets, 0);
  worklet.emitWindow(new Float32Array(16000 * 10));
  await new Promise((r) => setTimeout(r, 20));

  const coarseFile = makeFinalizedMp4('coarse-match.mp4', {
    lastModified: liveStartMs + durationSec * 1000 + 250,
    extraSeed: 22,
  });
  watchFiles.set(coarseFile.name, coarseFile);
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();
  await harness.bridge.pollWatchDirectory();

  assert.equal(harness.offlineInferCalls, 0);
  assert.equal(harness.bridge.autoIntake.getState().lastIntake?.kind, INTAKE_EVENT_KINDS.CONFORMED_COARSE);
  const snapCoarse = harness.snapshotLibrary();
  assert.equal(snapCoarse.items[0].status, 'conformed-coarse');

  // Add a manual review decision BEFORE triggering offline re-analysis
  const manualClipId = harness.workspace.addManual('source:coarse-match.mp4', { start: 1, end: 4 });

  // Trigger right-header primary action ("重新离线分析") even while live monitor is still running!
  const record = harness.bindings.get('source:coarse-match.mp4');
  const dispatch = await harness.bridge.dispatchPrimaryAction({
    item: snapCoarse.items[0],
    record,
  });
  assert.deepEqual(dispatch, { dispatched: true, kind: 'reanalyze' });
  await harness.queue.whenIdle();

  assert.ok(harness.offlineInferCalls >= 1, 'Re-analyze must run full offline analysis');
  assert.equal(record.alignment, null, 'Coarse alignment metadata must be cleared after full offline re-analysis');
  const snapAfter = harness.snapshotLibrary();
  assert.equal(snapAfter.items[0].status, 'ready', 'Status must upgrade from conformed-coarse to ready');
  assert.equal(
    harness.workspace.getSource('source:coarse-match.mp4').clips.some((clip) => clip.id === manualClipId),
    true,
    'Manual review decisions must be preserved across offline re-analysis (ADR 0004)',
  );
});

test('Live audio analysis subordination (ADR 0012): requires watch folder, survives folder switch, cascades stop on directory stop/restore-needed, auto-offline preference persists, and loopback/silence/disconnect alerts work', async (t) => {
  const nowRef = { value: 1_700_000_000_000 };
  const harness = createSingleWorkspaceHarness({ nowRef });
  t.after(() => harness.dispose());

  // 0. Without a watch folder, Live Audio Analysis is disallowed (subordinate to Watch Folder)
  assert.equal(harness.bridge.getState().liveMonitor.canToggle, false);
  assert.equal(harness.bridge.getState().liveMonitor.requiresWatchDir, true);
  assert.equal(harness.bridge.watchDirState.autoAnalyzeUncovered, false);
  await assert.rejects(() => harness.bridge.toggleLiveMonitor(), /Watch Folder|录像监听目录/);

  // Enable persistent Auto Offline Analysis preference on bridge
  assert.equal(harness.bridge.setAutoAnalyzeUncovered(true), true);
  assert.equal(harness.bridge.watchDirState.autoAnalyzeUncovered, true);
  assert.equal(harness.bridge.setAutoAnalyzeUncovered(false), false);

  // Choose watch folder -> unlocks Live Audio Analysis
  const watchDirA = createFakeDirectory('/Users/player/Videos/OBS A/', new Map());
  harness.setPickerResult(watchDirA);
  await harness.bridge.chooseWatchDirectory();
  assert.equal(harness.bridge.getState().liveMonitor.canToggle, true);
  assert.equal(harness.bridge.getState().liveMonitor.requiresWatchDir, false);

  // 1. Start system-audio Live Audio Analysis
  await harness.bridge.toggleLiveMonitor();
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening');
  assert.equal(harness.bridge.getState().liveMonitor.sourceKind, AUDIO_SOURCE_KINDS.SYSTEM);
  assert.equal('setAllowGateBypass' in harness.bridge, false);
  assert.equal('setAudioSourcePreference' in harness.bridge, false);

  // Unmuted playback -> auto-pauses live inference (paused-loopback); mute/pause -> resumes (listening)
  harness.bridge.notifyPlayerState({ playing: true, muted: false, volume: 0.7 });
  assert.equal(harness.bridge.getState().liveMonitor.status, 'paused-loopback');
  assert.equal(harness.bridge.getState().liveMonitor.gateActive, true);

  harness.bridge.notifyPlayerState({ playing: true, muted: true, volume: 0.7 });
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening');
  assert.equal(harness.bridge.getState().liveMonitor.gateActive, false);

  harness.bridge.notifyPlayerState({ playing: true, muted: false, volume: 0.4 });
  assert.equal(harness.bridge.getState().liveMonitor.status, 'paused-loopback');
  harness.bridge.notifyPlayerState({ playing: false, muted: false, volume: 0.4 });
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening');

  // 2. Silence warning triggers alert flag & notice
  const worklet0 = harness.audioHw.workletNodes[0];
  worklet0.emitEnvelope(new Float32Array([0, 0, 0, 0]), 12);
  assert.equal(harness.bridge.getState().liveMonitor.silenceWarning, true);
  assert.ok(harness.notices.some((n) => /audio|声音/i.test(n.message)));

  // 3. Switching watch directory while Live Audio Analysis is active MUST NOT stop live analysis
  const watchDirB = createFakeDirectory('/Users/player/Videos/OBS B/', new Map());
  harness.setPickerResult(watchDirB);
  await harness.bridge.chooseWatchDirectory();
  assert.equal(harness.bridge.watchDirState.name, 'OBS B');
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening', 'Switching watch folder must not interrupt active Live Audio Analysis');

  // 4. Stopping watch directory cascades stop to Live Audio Analysis and locks toggle again
  harness.bridge.stopWatchingDirectory();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.bridge.watchDirState.status, 'unset');
  assert.equal(harness.bridge.getState().liveMonitor.status, 'off', 'Stopping watch directory must cascade-stop Live Audio Analysis');
  assert.equal(harness.bridge.getState().liveMonitor.canToggle, false);

  // 5. Re-choose directory, start live analysis, then audio track ends -> transitions to disconnected + error notice
  harness.setPickerResult(watchDirA);
  await harness.bridge.chooseWatchDirectory();
  await harness.bridge.toggleLiveMonitor();
  const currentStream = harness.audioHw.activeStreams[harness.audioHw.activeStreams.length - 1];
  currentStream.audioTracks[0].emit('ended');
  assert.equal(harness.bridge.getState().liveMonitor.status, 'disconnected');
  assert.ok(harness.bridge.getState().liveMonitor.disconnectReason);

  // 6. Projection supports 'error' live monitor status cleanly (no silent fallback to 'off')
  const errorProj = projectRecordingLibrary({
    items: [],
    liveMonitor: { status: 'error' },
    watchDirectory: { status: 'error', name: 'Broken Dir' },
  });
  assert.equal(errorProj.liveMonitor.status, 'error');
  assert.equal(errorProj.liveMonitor.active, false);
  assert.equal(errorProj.watchDirectory.status, 'error');

  // 7. #62 watch-directory restore slots: setWatchDirectoryRestoreNeeded cascades stop & locks live toggle until restored
  await harness.bridge.toggleLiveMonitor();
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening');
  const persistedFiles = new Map();
  let restoredPerm = 'prompt';
  const persistedHandle = {
    name: '/Users/player/Videos/Saved OBS/',
    async queryPermission() { return restoredPerm; },
    async requestPermission() { restoredPerm = 'granted'; return 'granted'; },
    async *entries() { for (const [k, f] of persistedFiles) yield [k, { kind: 'file', async getFile() { return f; } }]; },
  };
  harness.bridge.setWatchDirectoryRestoreNeeded(persistedHandle);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.bridge.watchDirState.status, 'needs-permission');
  assert.equal(harness.bridge.watchDirState.name, 'Saved OBS');
  assert.equal(harness.bridge.watchDirState.needsRestore, true);
  assert.equal(harness.bridge.getWatchDirectoryHandle(), persistedHandle);
  assert.equal(harness.bridge.getState().liveMonitor.status, 'off');
  assert.equal(harness.bridge.getState().liveMonitor.canToggle, false);

  // Clicking restore restores handle directly without opening showDirectoryPicker & re-enables live toggle
  const pickersBefore = harness.pickerCalls.length;
  await harness.bridge.activateWatchDirectory();
  assert.equal(harness.pickerCalls.length, pickersBefore, 'One-click restore must request permission on saved handle without re-opening picker');
  assert.equal(harness.bridge.watchDirState.status, 'watching');
  assert.equal(harness.bridge.watchDirState.needsRestore, false);
  assert.equal(harness.bridge.getState().liveMonitor.canToggle, true);
});

test('createBrowserConverter invokes onOutputFileCreated before writable stream opens to eliminate self-ingestion race', async () => {
  const events = [];
  const createdNames = [];
  const fakeDir = {
    name: 'SharedFolder',
    async getFileHandle(name, opts) {
      if (!opts?.create) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      events.push(`create:${name}`);
      return {
        async createWritable() {
          events.push(`writable:${name}`);
          throw new DOMException('Aborted for test', 'AbortError');
        },
      };
    },
    async removeEntry() {},
  };
  const fakeMB = {
    ALL_FORMATS: [],
    BlobSource: class {},
    Input: class {
      async getPrimaryVideoTrack() { return { displayWidth: 1920, displayHeight: 1080 }; }
      async getAudioTracks() { return [{ id: 0 }]; }
      async getPrimaryAudioTrack() { return { id: 0 }; }
      dispose() {}
    },
  };
  const convert = createBrowserConverter({
    MB: fakeMB,
    makeId: () => 'fixedid',
    onOutputFileCreated: (name) => {
      createdNames.push(name);
      events.push(`registered:${name}`);
    },
  });

  await assert.rejects(() => convert({
    batch: { audio: { trackIndex: 0 }, output: { format: 'mp4', videoCodec: 'avc', audioCodec: 'aac' } },
    clip: { start: 0, end: 5 },
    source: { file: new File([new Uint8Array(8)], 'match.mp4'), origin: 0, directoryHandle: fakeDir },
    index: 0,
  }));

  assert.deepEqual(createdNames, ['match-01-fixedid.mp4']);
  assert.deepEqual(events, [
    'create:match-01-fixedid.mp4',
    'registered:match-01-fixedid.mp4',
    'writable:match-01-fixedid.mp4',
  ]);
});

function createSidebarIntakeFakeDom() {
  const byId = new Map();
  const docListeners = new Map();

  function makeNode(tag, id = null) {
    const node = {
      tagName: tag.toUpperCase(),
      id,
      textContent: '',
      title: '',
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      dataset: {},
      attributes: {},
      children: [],
      parentNode: null,
      onclick: null,
      onchange: null,
      setAttribute(name, val) { this.attributes[name] = String(val); },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      append(...nodes) {
        for (const n of nodes) {
          if (!n) continue;
          n.parentNode = this;
          this.children.push(n);
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
      contains(target) {
        if (target === this) return true;
        return this.children.some((c) => c.contains?.(target));
      },
      click() {
        if (!this.disabled && typeof this.onclick === 'function') this.onclick({ target: this, stopPropagation() {} });
      },
    };
    if (id) byId.set(id, node);
    return node;
  }

  const topbar = makeNode('div', 'library-topbar');
  const sessionNotice = makeNode('div', 'session-notice');
  const root = makeNode('div', 'sidebar-intake-controls');
  const watchWrap = makeNode('div', 'sidebar-watch-dir');
  const watchBtn = makeNode('button', 'sidebar-watch-btn');
  const watchLabel = makeNode('span', 'sidebar-watch-label');
  const watchValue = makeNode('span', 'sidebar-watch-value');
  const watchAutoPill = makeNode('span', 'sidebar-watch-auto-pill');
  watchAutoPill.hidden = true;
  const livePill = makeNode('span', 'sidebar-live-pill');
  livePill.hidden = true;
  const liveAlert = makeNode('span', 'sidebar-live-alert');
  liveAlert.hidden = true;
  const watchRestoreCta = makeNode('button', 'sidebar-watch-restore-cta');
  watchRestoreCta.hidden = true;
  const settingsBtn = makeNode('button', 'sidebar-intake-settings-btn');
  const popover = makeNode('div', 'sidebar-intake-popover');
  popover.hidden = true;
  const popWatchStatus = makeNode('span', 'sidebar-popover-watch-status');
  const popWatchName = makeNode('span', 'sidebar-popover-watch-name');
  const popWatchChoose = makeNode('button', 'sidebar-popover-watch-choose');
  const popWatchRestore = makeNode('button', 'sidebar-popover-watch-restore');
  popWatchRestore.hidden = true;
  const popWatchStop = makeNode('button', 'sidebar-popover-watch-stop');
  popWatchStop.hidden = true;
  const autoAnalyze = makeNode('input', 'sidebar-auto-analyze');
  const liveSection = makeNode('div', 'sidebar-live-section');
  const popLiveStatus = makeNode('span', 'sidebar-popover-live-status');
  const popNotice = makeNode('p', 'sidebar-popover-notice');
  popNotice.hidden = true;
  const liveToggle = makeNode('button', 'sidebar-live-toggle');
  const liveHint = makeNode('p', 'sidebar-live-hint');
  const readyNotify = makeNode('input', 'sidebar-ready-notify');
  const readyNotifyHint = makeNode('small', 'sidebar-ready-notify-hint');
  readyNotifyHint.hidden = true;

  liveSection.append(popLiveStatus, popNotice, liveToggle, liveHint);
  popover.append(popWatchStatus, popWatchName, popWatchChoose, popWatchRestore, popWatchStop, autoAnalyze, liveSection, readyNotify, readyNotifyHint);
  watchBtn.append(watchLabel, watchValue, watchAutoPill, livePill, liveAlert);
  watchWrap.append(watchBtn, watchRestoreCta, settingsBtn, popover);
  root.append(watchWrap);
  topbar.append(root);

  const doc = {
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return makeNode(tag); },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    emit(type, event) { for (const fn of [...(docListeners.get(type) || [])]) fn(event); },
  };
  return { doc, byId };
}

test('Sidebar intake controls wire single-row watch bar, unified Auto-Intake Settings popover, Auto Offline Analysis toggle, subordinate Live Audio Analysis, Stop Watching cascade, and silence/disconnect alerts (ADR 0012)', async (t) => {
  const nowRef = { value: 1_700_000_000_000 };
  const harness = createSingleWorkspaceHarness({ nowRef });
  const { doc, byId } = createSidebarIntakeFakeDom();
  const translate = (key, params = {}) => {
    let text = translations.zh[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };

  const controls = createLibraryIntakeControls({
    doc,
    translate,
    onToggleLive: () => harness.bridge.toggleLiveMonitor(),
    onToggleAutoAnalyze: (enabled) => harness.bridge.setAutoAnalyzeUncovered(enabled),
    onChooseWatchDir: () => harness.bridge.chooseWatchDirectory(),
    onRestoreWatchDir: () => harness.bridge.restoreWatchDirectory(),
    onStopWatchDir: () => harness.bridge.stopWatchingDirectory(),
  });
  const unsub = harness.bridge.subscribe((state) => controls.render(state));
  t.after(async () => {
    unsub();
    controls.dispose();
    await harness.dispose();
  });

  controls.render(harness.bridge.getState());
  assert.equal(byId.get('library-topbar').dataset.watchStatus, 'unset');
  assert.equal(byId.get('sidebar-watch-auto-pill').hidden, true);
  assert.equal(byId.get('session-notice').textContent, translations.zh.session_notice);
  assert.equal(byId.get('sidebar-watch-dir').dataset.watchStatus, 'unset');
  assert.equal(byId.get('sidebar-watch-dir').dataset.liveStatus, 'off');
  assert.equal(byId.get('sidebar-watch-value').textContent, '未选择');
  assert.equal(byId.get('sidebar-watch-label').hidden, false);
  assert.equal(byId.get('sidebar-live-toggle').disabled, true, 'Live Audio Analysis must be disabled before watch folder is active');
  assert.equal(byId.get('sidebar-popover-watch-stop').hidden, true);
  assert.equal(byId.get('sidebar-auto-analyze').checked, false);

  // Choose watch folder by clicking main bar while unset -> displays basename only, flips Scheme A hierarchy & unlocks Live Audio Analysis
  const watchDir = createFakeDirectory('/Users/alice/Movies/Apex OBS/', new Map());
  harness.setPickerResult(watchDir);
  byId.get('sidebar-watch-btn').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(byId.get('library-topbar').dataset.watchStatus, 'watching');
  assert.equal(byId.get('sidebar-watch-auto-pill').hidden, false);
  assert.equal(byId.get('sidebar-watch-auto-pill').textContent, '自动');
  assert.equal(byId.get('session-notice').textContent, translations.zh.session_notice_watching);
  assert.equal(byId.get('sidebar-watch-dir').dataset.watchStatus, 'watching');
  assert.equal(byId.get('sidebar-watch-value').textContent, 'Apex OBS');
  assert.equal(byId.get('sidebar-watch-value').textContent.includes('/'), false);
  assert.equal(byId.get('sidebar-watch-label').hidden, true);
  assert.equal(byId.get('sidebar-live-toggle').disabled, false);
  assert.equal(byId.get('sidebar-popover-watch-stop').hidden, false);

  // Clicking settings gear (or active folder bar) opens unified Auto-Intake Settings popover
  byId.get('sidebar-intake-settings-btn').click();
  assert.equal(byId.get('sidebar-intake-popover').hidden, false);

  // Toggle persistent Auto Offline Analysis checkbox inside popover
  const autoBox = byId.get('sidebar-auto-analyze');
  autoBox.checked = true;
  autoBox.onchange();
  assert.equal(harness.bridge.watchDirState.autoAnalyzeUncovered, true);

  // Start Live Audio Analysis inside unified popover -> compact live pill replaces auto pill on bar
  byId.get('sidebar-live-toggle').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(byId.get('sidebar-watch-dir').dataset.liveStatus, 'listening');
  assert.equal(byId.get('sidebar-watch-auto-pill').hidden, true);
  assert.equal(byId.get('sidebar-live-pill').hidden, false);
  assert.equal(byId.get('sidebar-live-pill').textContent, '实时中');
  assert.equal(byId.get('sidebar-popover-live-status').textContent, '分析中');
  assert.equal(byId.get('sidebar-live-toggle').getAttribute('aria-pressed'), 'true');

  // Silence warning shows alert indicator on bar and notice inside popover
  const worklet = harness.audioHw.workletNodes[harness.audioHw.workletNodes.length - 1];
  worklet.emitEnvelope(new Float32Array([0, 0, 0, 0]), 12);
  assert.equal(byId.get('sidebar-watch-dir').dataset.silenceWarning, 'true');
  assert.equal(byId.get('sidebar-live-alert').hidden, false);
  assert.equal(byId.get('sidebar-popover-notice').hidden, false);

  // Stop Watching inside popover stops watch folder AND cascades stop to Live Audio Analysis & restores manual primary hierarchy
  byId.get('sidebar-popover-watch-stop').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(byId.get('library-topbar').dataset.watchStatus, 'unset');
  assert.equal(byId.get('sidebar-watch-auto-pill').hidden, true);
  assert.equal(byId.get('session-notice').textContent, translations.zh.session_notice);
  assert.equal(byId.get('sidebar-watch-dir').dataset.watchStatus, 'unset');
  assert.equal(byId.get('sidebar-watch-dir').dataset.liveStatus, 'off');
  assert.equal(byId.get('sidebar-live-pill').hidden, true);
  assert.equal(byId.get('sidebar-live-toggle').disabled, true);

  // Escape closes popover
  doc.emit('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(byId.get('sidebar-intake-popover').hidden, true);
});

test('index.html, i18n, and single-workspace engine modules enforce ADR 0011/0012 sidebar intake controls, CONTEXT.md terminology, and zero legacy live-companion coupling', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const siteDir = path.resolve(testDir, '../../../site');
  const html = readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  const bridgeSrc = readFileSync(path.join(siteDir, 'workspace-engine-bridge.mjs'), 'utf8');
  const intakeSrc = readFileSync(path.join(siteDir, 'library-intake-controls.mjs'), 'utf8');

  // Header no longer carries session pills; unified single-row intake controls live inside #analysis-page .queue-panel
  const headerBlock = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0] || '';
  assert.equal(/id="global-session-controls"/.test(headerBlock), false, 'App header must not mount #global-session-controls (ADR 0011)');

  const sidebarBlock = html.match(/<div id="analysis-page">[\s\S]*?<div id="review-page"/)?.[0] || '';
  assert.match(sidebarBlock, /id="sidebar-intake-controls"/);
  assert.match(sidebarBlock, /id="sidebar-watch-dir"/);
  assert.match(sidebarBlock, /id="sidebar-watch-btn"/);
  assert.match(sidebarBlock, /id="sidebar-intake-settings-btn"/);
  assert.match(sidebarBlock, /id="sidebar-intake-popover"/);
  assert.match(sidebarBlock, /id="sidebar-auto-analyze"/);
  assert.match(sidebarBlock, /id="sidebar-live-toggle"/);
  assert.match(sidebarBlock, /id="sidebar-popover-watch-stop"/);
  assert.match(sidebarBlock, /data-i18n="library_live_label"/);
  assert.match(sidebarBlock, /data-i18n="library_watch_label"/);
  assert.match(sidebarBlock, /data-i18n="auto_offline_analyze_label"/);
  assert.equal(/id="sidebar-live-monitor"|id="sidebar-device-select"|id="sidebar-gate-bypass"/.test(sidebarBlock), false, 'Obsolete sibling live bar & virtual device UI must be removed (ADR 0012)');

  // Zero dependency on legacy live-companion-ui.mjs or live-proxy-buffer.mjs in new single-workspace engine modules
  for (const src of [bridgeSrc, intakeSrc]) {
    assert.equal(/live-companion-ui|live-proxy-buffer/.test(src), false, 'Single-workspace modules must not import legacy live companion or proxy buffer');
  }

  // Zero forbidden domain terms across all i18n translations (including retired 对局监听 per ADR 0012)
  for (const [lang, dict] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(
        /分析队列|analysis queue|录像库页|复核页|实时伴随模式|实时伴随代理|内置录屏器|已确认高光|击杀片段|对局监听/i.test(value),
        false,
        `${lang}.${key} contains forbidden domain term: ${value}`,
      );
    }
  }
});

test('Sidebar intake controls drive real engineBridge watch-dir & live-monitor services and survive Exports view transitions', async (t) => {
  const nowRef = { value: 1_700_000_000_000 };
  const harness = createSingleWorkspaceHarness({ nowRef });
  const { doc, byId } = createSidebarIntakeFakeDom();
  const translate = (key, params = {}) => {
    let text = translations.zh[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };

  const controls = createLibraryIntakeControls({
    doc,
    translate,
    onToggleLive: () => harness.bridge.toggleLiveMonitor(),
    onToggleAutoAnalyze: (enabled) => harness.bridge.setAutoAnalyzeUncovered(enabled),
    onChooseWatchDir: () => harness.bridge.chooseWatchDirectory(),
    onRestoreWatchDir: () => harness.bridge.restoreWatchDirectory(),
    onStopWatchDir: () => harness.bridge.stopWatchingDirectory(),
  });
  const unsub = harness.bridge.subscribe((state) => controls.render(state));
  t.after(async () => {
    unsub();
    controls.dispose();
    await harness.dispose();
  });

  const watchDir = createFakeDirectory('/Volumes/NVMe/Apex Recordings/', new Map());
  harness.setPickerResult(watchDir);

  // Choose Watch Folder via sidebar intake control
  byId.get('sidebar-watch-btn').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.bridge.watchDirState.status, 'watching');
  assert.equal(harness.bridge.watchDirState.name, 'Apex Recordings');
  assert.equal(byId.get('sidebar-watch-value').textContent, 'Apex Recordings');

  // Start Live Audio Analysis via unified Auto-Intake Settings popover
  byId.get('sidebar-intake-settings-btn').click();
  byId.get('sidebar-live-toggle').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening');
  assert.equal(byId.get('sidebar-live-pill').textContent, '实时中');
  assert.equal(byId.get('sidebar-popover-live-status').textContent, '分析中');

  // Switching to Exports hides sidebar controls without stopping live analysis, and returning restores visibility
  controls.render(harness.bridge.getState(), { hidden: true });
  assert.equal(byId.get('sidebar-intake-controls').hidden, true);
  assert.equal(harness.bridge.getState().liveMonitor.status, 'listening');
  controls.render(harness.bridge.getState(), { hidden: false });
  assert.equal(byId.get('sidebar-intake-controls').hidden, false);

  // Stop Live Audio Analysis via popover toggle
  byId.get('sidebar-live-toggle').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(harness.bridge.getState().liveMonitor.status, 'off');
  assert.equal(byId.get('sidebar-popover-live-status').textContent, '未开启');
  assert.equal(byId.get('sidebar-live-pill').hidden, true);
});

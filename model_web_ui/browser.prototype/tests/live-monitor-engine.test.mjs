import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, getModelSpec, serializeSpec } from '../../../site/model-registry.mjs';
import { createLiveAudioHistory, DEFAULT_MAX_HISTORY_SECONDS } from '../../../site/live-audio-history.mjs';
import { alignRecordingToLiveSession, ENVELOPE_STEP_SECONDS } from '../../../site/audio-aligner.mjs';
import { createLiveMonitorEngine, LIVE_MONITOR_STATES, AUDIO_SOURCE_KINDS } from '../../../site/live-monitor-engine.mjs';

function createFakeTrack({ kind, label = '', deviceId = null, emitEndedOnStop = false } = {}) {
  const listeners = new Map();
  const track = {
    kind,
    label,
    readyState: 'live',
    stoppedCount: 0,
    endedListenerAddedAtOrder: null,
    stoppedAtOrder: null,
    getSettings() {
      return deviceId ? { deviceId } : {};
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
    emit(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ target: track });
    },
    stop() {
      this.stoppedCount++;
      this.readyState = 'ended';
      if (emitEndedOnStop) this.emit('ended');
    },
  };
  return track;
}

function createFakeStream({ videoTracks = [], audioTracks = [] } = {}) {
  const tracks = [...videoTracks, ...audioTracks];
  const removedTracks = [];
  return {
    removedTracks,
    getTracks() { return [...tracks]; },
    getVideoTracks() { return tracks.filter((t) => t.kind === 'video'); },
    getAudioTracks() { return tracks.filter((t) => t.kind === 'audio'); },
    removeTrack(track) {
      const idx = tracks.indexOf(track);
      if (idx >= 0) {
        tracks.splice(idx, 1);
        removedTracks.push(track);
      }
    },
  };
}

function createFakeHarness({
  displayStreamFactory,
  userStreamFactory,
  devices = [],
  manifestClasses = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun', 'Glass shatter'],
  nowRef = { value: 1_700_000_000_000 },
} = {}) {
  const displayCalls = [];
  const userCalls = [];
  const audioContexts = [];
  const workletNodes = [];
  const workers = [];
  const fetchCalls = [];

  const mediaDevices = {
    async getDisplayMedia(constraints) {
      displayCalls.push(constraints);
      if (!displayStreamFactory) throw new Error('getDisplayMedia not configured');
      return displayStreamFactory(constraints);
    },
    async getUserMedia(constraints) {
      userCalls.push(constraints);
      if (!userStreamFactory) throw new Error('getUserMedia not configured');
      return userStreamFactory(constraints);
    },
    async enumerateDevices() {
      return devices;
    },
  };

  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.closed = false;
      this.resumed = false;
      this.addedModules = [];
      this.connections = [];
      this.gains = [];
      this.destination = { kind: 'destination' };
      this.audioWorklet = {
        addModule: async (url) => {
          this.addedModules.push(String(url));
        },
      };
      audioContexts.push(this);
    }
    async resume() {
      this.resumed = true;
      this.state = 'running';
    }
    createMediaStreamSource(stream) {
      const node = {
        kind: 'mediaStreamSource',
        stream,
        connectedTo: [],
        disconnected: false,
        connect(target) {
          this.connectedTo.push(target);
          return target;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      this.connections.push(node);
      return node;
    }
    createGain() {
      const gainNode = {
        kind: 'gain',
        gain: { value: 1 },
        connectedTo: [],
        disconnected: false,
        connect(target) {
          this.connectedTo.push(target);
          return target;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      this.gains.push(gainNode);
      return gainNode;
    }
    async close() {
      this.closed = true;
      this.state = 'closed';
    }
  }

  class FakeAudioWorkletNode {
    constructor(ctx, name, options) {
      this.ctx = ctx;
      this.name = name;
      this.options = options;
      this.connectedTo = [];
      this.disconnected = false;
      this.sentMessages = [];
      this.port = {
        onmessage: null,
        postMessage: (msg) => {
          this.sentMessages.push(msg);
        },
      };
      workletNodes.push(this);
    }
    connect(target) {
      this.connectedTo.push(target);
      return target;
    }
    disconnect() {
      this.disconnected = true;
    }
    emitFromWorklet(data) {
      this.port.onmessage?.({ data });
    }
  }

  class FakeWorker {
    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      this.posted = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      workers.push(this);
    }
    postMessage(msg, transfer) {
      this.posted.push({ msg, transfer });
    }
    emitMessage(data) {
      this.onmessage?.({ data });
    }
    emitError(message) {
      this.onerror?.({ message });
    }
    terminate() {
      this.terminated = true;
    }
  }

  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'EfficientSED',
          classes: manifestClasses,
          sampleRate: 16000,
          scoreType: 'frame',
          windowSeconds: 10,
          strideSeconds: 5,
          frameSeconds: 0.04,
          activation: 'sigmoid',
          inputName: 'mel',
          input: [1, 1, 128, 1000],
          output: [1, 250, manifestClasses.length],
          sha256: 'abc123',
          bytes: 1024,
          modelFile: 'fmn10-tf256.onnx',
        };
      },
    };
  };

  return {
    mediaDevices,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    Worker: FakeWorker,
    fetch: fetchImpl,
    now: () => nowRef.value,
    nowRef,
    displayCalls,
    userCalls,
    audioContexts,
    workletNodes,
    workers,
    fetchCalls,
  };
}

test('serializeSpec produces a plain structured-clonable model spec for the inference worker boundary', () => {
  const spec = getModelSpec(DEFAULT_MODEL);
  const serialized = serializeSpec(spec);

  assert.equal(serialized.id, 'efficientsed');
  assert.equal(serialized.sampleRate, 16000);
  assert.equal(serialized.windowSeconds, 10);
  assert.equal(serialized.frameSeconds, 0.04);
  assert.equal(serialized.framesPerWindow, 250);
  assert.equal(serialized.inputName, 'mel');
  assert.deepEqual(serialized.inputShape, [1, 1, 128, 1000]);
  assert.deepEqual(serialized.gunshotClasses, ['Gunshot, gunfire', 'Machine gun']);
  assert.notEqual(serialized.inputShape, spec.inputShape);
  assert.deepEqual(structuredClone(serialized), serialized);
});

test('live audio history maintains a 60-min default rolling window, trims expired data, omits decisions, and plugs directly into audio-aligner', async () => {
  assert.equal(DEFAULT_MAX_HISTORY_SECONDS, 3600);

  // Use a compact 20s rolling cap to verify exact trimming math and ring wraparound.
  const history = createLiveAudioHistory({ maxHistorySeconds: 20 });
  const t0 = 1_700_000_000_000;
  history.begin(t0);

  // Push 25s of distinctive 20ms interleaved [peak, rms] energy envelope (1250 buckets).
  const totalBuckets = Math.round(25 / ENVELOPE_STEP_SECONDS);
  const batch = new Float32Array(totalBuckets * 2);
  for (let i = 0; i < totalBuckets; i++) {
    const tSec = i * ENVELOPE_STEP_SECONDS;
    const burst = (Math.abs(tSec - 8) < 0.4 || Math.abs(tSec - 14) < 0.3 || Math.abs(tSec - 21) < 0.35) ? 0.85 : 0.05;
    const rms = burst * 0.7 + ((i % 7) * 0.01);
    batch[i * 2] = Math.min(1, burst);
    batch[i * 2 + 1] = Math.min(1, rms);
  }
  history.pushEnvelope(batch, t0);

  // Add an old window (0..4s -> should be trimmed because cutoff is t0 + 5s) and a live window (10..20s -> kept).
  history.pushScoreWindow({
    wallStartMs: t0,
    wallEndMs: t0 + 4_000,
    scores: [0.9, 0.2],
    groupScores: [0.9, 0.1, 0, 0],
  });
  const frameGroupScores = new Float32Array(250 * 4);
  frameGroupScores[100 * 4 + 0] = 0.88; // gunshot at +4s into window
  frameGroupScores[100 * 4 + 1] = 0.52; // speech
  history.pushScoreWindow({
    wallStartMs: t0 + 10_000,
    wallEndMs: t0 + 20_000,
    scores: [0.88, 0.15],
    groupScores: [0.88, 0.52, 0.05, 0.2],
    frameGroupScores,
    frameSeconds: 0.04,
  });

  const exported = history.exportForAlignment();
  assert.equal(exported.startEpochMs, t0 + 5_000);
  assert.equal(exported.latestEpochMs, t0 + 25_000);
  assert.equal(exported.envStepSeconds, 0.02);
  assert.equal(exported.envPeaks.length, 1000); // exactly 20s retained
  assert.equal(exported.envRms.length, 1000);
  assert.equal(exported.scoreWindows.length, 1);
  assert.equal(exported.scoreWindows[0].wallStartMs, t0 + 10_000);
  assert.equal('decisions' in exported, false);
  assert.equal('thumbnail' in exported.scoreWindows[0], false);

  // Mutating history afterwards must not mutate the previously exported snapshot.
  history.pushEnvelope(new Float32Array([0.99, 0.99]), t0 + 25_020);
  assert.equal(exported.startEpochMs, t0 + 5_000);
  assert.equal(exported.envPeaks.length, 1000);

  // Verify direct compatibility with alignRecordingToLiveSession (exact NCC alignment, zero liveDecisions).
  const recordingStartMs = t0 + 7_000; // starts 2s after exported.startEpochMs
  const recordingDuration = 16;
  const aligned = await alignRecordingToLiveSession({
    file: { name: 'match.mkv', lastModified: recordingStartMs + recordingDuration * 1000 },
    duration: recordingDuration,
    liveHistory: exported,
    coarseStartOverrideMs: recordingStartMs - 1100, // +1100ms write-close skew
    extractSlice: async ({ startSec, spanSec }) => {
      const i0 = Math.round(((recordingStartMs + startSec * 1000) - exported.startEpochMs) / 20);
      const len = Math.max(1, Math.floor(spanSec / 0.02));
      return exported.envRms.subarray(i0, Math.min(exported.envRms.length, i0 + len));
    },
  });

  assert.equal(aligned.confidence, 'exact');
  assert.ok(Math.abs(aligned.masterStartEpochMs - recordingStartMs) <= 30,
    `expected <=30ms alignment error, got ${Math.abs(aligned.masterStartEpochMs - recordingStartMs)}ms`);
  assert.equal(aligned.mapped.windowScores.length, 1);
  assert.ok(aligned.mapped.scoreTimeline?.groupScorePyramid);
  assert.deepEqual(aligned.mapped.liveDecisions, []);
});

test('system audio capture immediately stops and removes video tracks before binding ended listeners only on audio tracks, and wires 16kHz worklet to silent sink', async () => {
  const order = [];
  const videoTrack = createFakeTrack({ kind: 'video', label: 'Screen 1', emitEndedOnStop: true });
  const origVideoStop = videoTrack.stop.bind(videoTrack);
  videoTrack.stop = () => {
    order.push('video.stop');
    origVideoStop();
  };
  const audioTrack = createFakeTrack({ kind: 'audio', label: 'System Audio' });
  const origAudioAddListener = audioTrack.addEventListener.bind(audioTrack);
  audioTrack.addEventListener = (type, fn) => {
    order.push(`audio.on(${type})`);
    origAudioAddListener(type, fn);
  };
  const stream = createFakeStream({ videoTracks: [videoTrack], audioTracks: [audioTrack] });
  const origRemoveTrack = stream.removeTrack.bind(stream);
  stream.removeTrack = (track) => {
    order.push(`stream.remove(${track.kind})`);
    origRemoveTrack(track);
  };

  const harness = createFakeHarness({
    displayStreamFactory: () => stream,
  });
  const engine = createLiveMonitorEngine(harness);

  const observedStatuses = [];
  const unsubscribe = engine.subscribe((state) => observedStatuses.push(state.status));

  assert.equal(engine.getState().status, LIVE_MONITOR_STATES.IDLE);

  const started = await engine.start({ sourceKind: AUDIO_SOURCE_KINDS.SYSTEM });

  // Constraints disable browser voice processing so raw game audio is preserved.
  assert.deepEqual(harness.displayCalls[0], {
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  // Video track must be stopped AND removed BEFORE audio ended listener is attached, and video never gets an ended listener.
  assert.equal(videoTrack.stoppedCount, 1);
  assert.equal(videoTrack.listenerCount('ended'), 0);
  assert.equal(audioTrack.listenerCount('ended'), 1);
  assert.equal(stream.getVideoTracks().length, 0);
  assert.deepEqual(order, ['video.stop', 'stream.remove(video)', 'audio.on(ended)']);

  // Firing 'ended' on the already-stopped video track must never affect listening state.
  videoTrack.emit('ended');
  assert.equal(engine.getState().status, LIVE_MONITOR_STATES.LISTENING);

  // AudioWorklet must run at 16 kHz (EfficientSED) and connect through a zero-gain silent sink to destination.
  const ctx = harness.audioContexts[0];
  const worklet = harness.workletNodes[0];
  assert.equal(ctx.resumed, true);
  assert.ok(ctx.addedModules[0].endsWith('/live-audio-processor.js'));
  assert.equal(worklet.name, 'live-audio-processor');
  assert.equal(worklet.options.processorOptions.targetRate, 16000);
  assert.equal(worklet.options.processorOptions.windowSeconds, 10);
  assert.equal(worklet.options.processorOptions.hopSeconds, 2);
  assert.equal(ctx.gains.length, 1);
  assert.equal(ctx.gains[0].gain.value, 0);
  assert.equal(worklet.connectedTo[0], ctx.gains[0]);
  assert.equal(ctx.gains[0].connectedTo[0], ctx.destination);

  // State transitions & zero legacy proxy/filmstrip/manual-mark/decision state.
  assert.deepEqual(observedStatuses, ['starting', 'listening']);
  assert.equal(started.status, 'listening');
  assert.equal(started.active, true);
  assert.equal(started.sourceKind, 'system');
  assert.equal(started.audioLabel, 'System Audio');
  for (const forbidden of [
    'proxyWindowSeconds', 'proxyBuffer', 'proxyMode', 'filmstrip', 'replayUrl',
    'decisions', 'liveDecisions', 'candidates', 'conformed', 'marks',
  ]) {
    assert.equal(forbidden in started, false, `unexpected legacy field "${forbidden}" in engine state`);
  }

  unsubscribe();
  await engine.dispose();
});

test('system audio capture fails cleanly and stops video track when shared display stream has no audio track', async () => {
  const videoTrack = createFakeTrack({ kind: 'video', label: 'Screen Only' });
  const stream = createFakeStream({ videoTracks: [videoTrack], audioTracks: [] });
  const harness = createFakeHarness({
    displayStreamFactory: () => stream,
  });
  const engine = createLiveMonitorEngine(harness);

  await assert.rejects(
    () => engine.start({ sourceKind: 'system' }),
    /音频/,
  );

  assert.equal(videoTrack.stoppedCount, 1);
  assert.equal(harness.audioContexts.length, 0);
  assert.equal(engine.getState().status, 'error');
  assert.equal(engine.getState().active, false);
  assert.ok(engine.getState().error);
  await engine.dispose();
});

test('virtual audio device capture enumerates audioinput devices, captures with raw constraints, and switchAudioSource releases old stream while keeping rolling history', async () => {
  const cableTrack = createFakeTrack({ kind: 'audio', label: 'VB-Cable Output', deviceId: 'vb-1' });
  const blackholeTrack = createFakeTrack({ kind: 'audio', label: 'BlackHole 2ch', deviceId: 'bh-2' });
  const sysVideo = createFakeTrack({ kind: 'video', label: 'Display' });
  const sysAudio = createFakeTrack({ kind: 'audio', label: 'Desktop Audio' });

  const streamsByDevice = {
    'vb-1': createFakeStream({ audioTracks: [cableTrack] }),
    'bh-2': createFakeStream({ audioTracks: [blackholeTrack] }),
  };

  const harness = createFakeHarness({
    devices: [
      { kind: 'audioinput', deviceId: 'vb-1', label: 'VB-Cable Output', groupId: 'g1' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam', groupId: 'g2' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers', groupId: 'g3' },
      { kind: 'audioinput', deviceId: 'bh-2', label: 'BlackHole 2ch', groupId: 'g4' },
    ],
    userStreamFactory: (constraints) => {
      const id = constraints.audio?.deviceId?.exact || 'vb-1';
      return streamsByDevice[id];
    },
    displayStreamFactory: () => createFakeStream({ videoTracks: [sysVideo], audioTracks: [sysAudio] }),
  });

  const engine = createLiveMonitorEngine(harness);

  const devices = await engine.listAudioDevices();
  assert.deepEqual(devices, [
    { deviceId: 'vb-1', label: 'VB-Cable Output', groupId: 'g1' },
    { deviceId: 'bh-2', label: 'BlackHole 2ch', groupId: 'g4' },
  ]);

  const s1 = await engine.start({ sourceKind: 'device', deviceId: 'vb-1' });
  assert.deepEqual(harness.userCalls[0], {
    video: false,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      deviceId: { exact: 'vb-1' },
    },
  });
  assert.equal(s1.status, 'listening');
  assert.equal(s1.sourceKind, 'device');
  assert.equal(s1.deviceId, 'vb-1');
  assert.equal(s1.audioLabel, 'VB-Cable Output');

  // Switch to another virtual device after 1s.
  harness.nowRef.value += 1000;
  const s2 = await engine.switchAudioSource({ sourceKind: 'device', deviceId: 'bh-2' });
  assert.equal(cableTrack.stoppedCount, 1);
  assert.equal(harness.audioContexts[0].closed, true);
  assert.equal(s2.status, 'listening');
  assert.equal(s2.sourceKind, 'device');
  assert.equal(s2.deviceId, 'bh-2');
  assert.equal(s2.audioLabel, 'BlackHole 2ch');

  // Switch from device to system audio.
  harness.nowRef.value += 1000;
  const s3 = await engine.switchAudioSource({ sourceKind: 'system' });
  assert.equal(blackholeTrack.stoppedCount, 1);
  assert.equal(sysVideo.stoppedCount, 1);
  assert.equal(s3.status, 'listening');
  assert.equal(s3.sourceKind, 'system');
  assert.equal(s3.deviceId, null);
  assert.equal(s3.audioLabel, 'Desktop Audio');

  await engine.dispose();
});

test('worklet envelopes populate rolling alignment history, trigger silence warning at >=10s, clear on sound, and survive source switch', async () => {
  const track1 = createFakeTrack({ kind: 'audio', label: 'Device A', deviceId: 'dev-a' });
  const track2 = createFakeTrack({ kind: 'audio', label: 'Device B', deviceId: 'dev-b' });
  const harness = createFakeHarness({
    userStreamFactory: (c) => createFakeStream({
      audioTracks: [c.audio?.deviceId?.exact === 'dev-b' ? track2 : track1],
    }),
  });
  const engine = createLiveMonitorEngine(harness);
  const t0 = harness.nowRef.value;

  const warnings = [];
  engine.subscribe((s) => warnings.push(s.silenceWarning));

  await engine.start({ sourceKind: 'device', deviceId: 'dev-a' });
  const worklet1 = harness.workletNodes[0];

  // Emit 50 buckets (1.0s) of active audio.
  const activeBatch = new Float32Array(100);
  for (let i = 0; i < 50; i++) {
    activeBatch[i * 2] = 0.6;
    activeBatch[i * 2 + 1] = 0.35;
  }
  harness.nowRef.value = t0 + 1000;
  worklet1.emitFromWorklet({ type: 'envelope', buckets: activeBatch, silentSeconds: 0 });
  assert.equal(engine.getState().envelopeBucketCount, 50);
  assert.equal(engine.getState().silenceWarning, false);

  // Emit quiet batch reporting 9.9s silence -> still below threshold.
  worklet1.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0, 0, 0, 0]), silentSeconds: 9.9 });
  assert.equal(engine.getState().silenceWarning, false);

  // Hit 10.0s silence -> silenceWarning activates.
  worklet1.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0, 0]), silentSeconds: 10.0 });
  assert.equal(engine.getState().silenceWarning, true);
  assert.equal(engine.getState().silentSeconds, 10.0);

  // Audio returns -> silenceWarning clears.
  worklet1.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0.5, 0.25]), silentSeconds: 0 });
  assert.equal(engine.getState().silenceWarning, false);
  assert.ok(warnings.includes(true));

  // Switch audio source 1s after the last envelope; history retains earlier buckets + gap padding.
  const beforeSwitch = engine.getHistoryForAlignment();
  assert.equal(beforeSwitch.envPeaks.length, 54);
  assert.ok(Math.abs(beforeSwitch.envPeaks[0] - 0.6) < 1e-5);
  assert.ok(Math.abs(beforeSwitch.envRms[0] - 0.35) < 1e-5);

  harness.nowRef.value = beforeSwitch.latestEpochMs + 1000;
  await engine.switchAudioSource({ sourceKind: 'device', deviceId: 'dev-b' });
  const worklet2 = harness.workletNodes[1];
  worklet2.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0.8, 0.4]), silentSeconds: 0 });

  const afterSwitch = engine.getHistoryForAlignment();
  assert.equal(afterSwitch.startEpochMs, t0);
  assert.equal(afterSwitch.envPeaks.length, 54 + 50 + 1); // 54 pre + 50 gap (1s) + 1 post
  assert.ok(Math.abs(afterSwitch.envPeaks[0] - 0.6) < 1e-5);
  assert.equal(afterSwitch.envPeaks[60], 0); // silent gap
  assert.ok(Math.abs(afterSwitch.envPeaks[afterSwitch.envPeaks.length - 1] - 0.8) < 1e-5);

  await engine.dispose();
});

test('worker inference computes gunshot and 4-group score windows, coalesces busy windows to a single latest slot, and exports alignment-ready history', async () => {
  const audioTrack = createFakeTrack({ kind: 'audio', label: 'System Audio' });
  const videoTrack = createFakeTrack({ kind: 'video', label: 'Screen' });
  const harness = createFakeHarness({
    displayStreamFactory: () => createFakeStream({ videoTracks: [videoTrack], audioTracks: [audioTrack] }),
  });
  const engine = createLiveMonitorEngine(harness);
  const t0 = harness.nowRef.value;

  await engine.start({ sourceKind: 'system' });
  const worklet = harness.workletNodes[0];

  // Push 16s of envelope with combat bursts so alignRecordingToLiveSession can align accurately.
  const totalBuckets = 800; // 16s
  const envBatch = new Float32Array(totalBuckets * 2);
  for (let i = 0; i < totalBuckets; i++) {
    const tSec = i * 0.02;
    const burst = (Math.abs(tSec - 4) < 0.3 || Math.abs(tSec - 11) < 0.35) ? 0.9 : 0.04;
    envBatch[i * 2] = burst;
    envBatch[i * 2 + 1] = burst * 0.75 + (i % 5) * 0.01;
  }
  harness.nowRef.value = t0 + 10_000;
  worklet.emitFromWorklet({ type: 'envelope', buckets: envBatch.subarray(0, 1000), silentSeconds: 0 }); // 10s

  // Helper to build a valid [1, 250, 5] tensor (classes: Speech, Gunshot, Music, Machine gun, Glass shatter).
  const makeScoresTensor = ({ speech = 0, gunshot = 0, music = 0, machineGun = 0, impact = 0 }) => {
    const values = new Float32Array(250 * 5);
    values[50 * 5 + 0] = speech;
    values[50 * 5 + 1] = gunshot;
    values[50 * 5 + 2] = music;
    values[50 * 5 + 3] = machineGun;
    values[50 * 5 + 4] = impact;
    return values;
  };

  // Emit Window 1 -> dispatched to worker.
  const w1 = new Float32Array([1, 0, 0, 0]);
  worklet.emitFromWorklet({ type: 'window', waveform: w1, coveredSeconds: 10 });

  // Flush microtasks so manifest fetch completes and postMessage runs.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.workers.length, 1);
  const worker = harness.workers[0];
  assert.ok(worker.url.endsWith('/inference-worker.js'));
  assert.equal(worker.options.type, 'module');
  assert.equal(worker.posted.length, 1);
  assert.equal(worker.posted[0].msg.model, 'efficientsed');
  assert.equal(worker.posted[0].msg.spec.sampleRate, 16000);
  assert.equal(worker.posted[0].msg.waveform[0], 1);
  assert.equal(worker.posted[0].transfer[0], w1.buffer);

  // Worker status messages reflect in state.
  worker.emitMessage({ type: 'status', progress: 0.5, message: '正在下载模型…' });
  assert.equal(engine.getState().modelStatus, '正在下载模型…');
  assert.equal(engine.getState().modelLoadProgress, 0.5);

  // While Window 1 is in flight, emit Windows 2, 3, and 4 -> W2 and W3 are dropped, only W4 stays queued.
  harness.nowRef.value = t0 + 12_000;
  worklet.emitFromWorklet({ type: 'envelope', buckets: envBatch.subarray(1000, 1200), silentSeconds: 0 }); // +2s
  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([2, 0, 0, 0]), coveredSeconds: 10 });

  harness.nowRef.value = t0 + 14_000;
  worklet.emitFromWorklet({ type: 'envelope', buckets: envBatch.subarray(1200, 1400), silentSeconds: 0 }); // +2s
  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([3, 0, 0, 0]), coveredSeconds: 10 });

  harness.nowRef.value = t0 + 16_000;
  worklet.emitFromWorklet({ type: 'envelope', buckets: envBatch.subarray(1400, 1600), silentSeconds: 0 }); // +2s
  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([4, 0, 0, 0]), coveredSeconds: 10 });

  assert.equal(worker.posted.length, 1);
  assert.equal(engine.getState().droppedWindowCount, 2);

  // Complete Window 1 -> pushes score window AND immediately dispatches Window 4 (skipping W2 & W3).
  worker.emitMessage({
    id: worker.posted[0].msg.id,
    type: 'result',
    values: makeScoresTensor({ gunshot: 0.82, speech: 0.61, music: 0.12, impact: 0.44 }),
    dims: [1, 250, 5],
    timings: { frontendMs: 12, inferenceMs: 48, cold: true },
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(harness.fetchCalls.length, 1); // manifest cached
  assert.equal(worker.posted.length, 2);
  assert.equal(worker.posted[1].msg.waveform[0], 4); // W4 ran, not W2 or W3!
  assert.equal(engine.getState().inferenceCount, 1);
  assert.equal(engine.getState().lastInferenceMs, 48);
  assert.ok(Math.abs(engine.getState().latestScores.scores[0] - 0.82) < 1e-5);
  assert.ok(Math.abs(engine.getState().latestScores.groupScores[1] - 0.61) < 1e-5);

  // Complete Window 4.
  worker.emitMessage({
    id: worker.posted[1].msg.id,
    type: 'result',
    values: makeScoresTensor({ machineGun: 0.91, speech: 0.25 }),
    dims: [1, 250, 5],
    timings: { frontendMs: 10, inferenceMs: 35, cold: false },
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(engine.getState().inferenceCount, 2);
  assert.equal(engine.getState().scoreWindowCount, 2);
  assert.ok(Math.abs(engine.getState().latestScores.maxGunshotScore - 0.91) < 1e-5);

  // Verify alignment export directly feeds alignRecordingToLiveSession.
  const history = engine.getHistoryForAlignment();
  assert.equal(history.scoreWindows.length, 2);
  assert.equal(history.scoreWindows[0].wallStartMs, t0);
  assert.equal(history.scoreWindows[0].wallEndMs, t0 + 10_000);
  assert.equal(history.scoreWindows[1].wallStartMs, t0 + 6_000);
  assert.equal(history.scoreWindows[1].wallEndMs, t0 + 16_000);

  const aligned = await alignRecordingToLiveSession({
    file: { name: 'live-match.mp4', lastModified: t0 + 16_000 },
    duration: 16,
    liveHistory: history,
    coarseStartOverrideMs: t0 - 900,
    extractSlice: async ({ startSec, spanSec }) => {
      const i0 = Math.floor(startSec / 0.02);
      const len = Math.max(1, Math.floor(spanSec / 0.02));
      return history.envRms.subarray(i0, Math.min(history.envRms.length, i0 + len));
    },
  });
  assert.equal(aligned.confidence, 'exact');
  assert.equal(aligned.mapped.windowScores.length, 2);
  assert.ok(aligned.mapped.scoreTimeline?.groupScorePyramid);
  assert.deepEqual(aligned.mapped.liveDecisions, []);

  await engine.dispose();
});

test('loopback gate pauses and resumes worklet and inference on system audio, rejects bypass on system, allows bypass only on device, and re-enforces gate when switching back to system', async () => {
  const sysStream1 = createFakeStream({
    videoTracks: [createFakeTrack({ kind: 'video' })],
    audioTracks: [createFakeTrack({ kind: 'audio', label: 'System 1' })],
  });
  const sysStream2 = createFakeStream({
    videoTracks: [createFakeTrack({ kind: 'video' })],
    audioTracks: [createFakeTrack({ kind: 'audio', label: 'System 2' })],
  });
  let sysIdx = 0;
  const devStream = createFakeStream({
    audioTracks: [createFakeTrack({ kind: 'audio', label: 'VB-Cable', deviceId: 'vb-1' })],
  });

  const harness = createFakeHarness({
    displayStreamFactory: () => (sysIdx++ === 0 ? sysStream1 : sysStream2),
    userStreamFactory: () => devStream,
  });
  const engine = createLiveMonitorEngine(harness);
  const t0 = harness.nowRef.value;

  await engine.start({ sourceKind: 'system' });
  const wSys1 = harness.workletNodes[0];

  // Push 1s of audio before gating.
  wSys1.emitFromWorklet({ type: 'envelope', buckets: new Float32Array(100).fill(0.3), silentSeconds: 0 });
  assert.equal(engine.getState().envelopeBucketCount, 50);

  // Playback starts unmuted -> pauses worklet & inference.
  harness.nowRef.value = t0 + 1000;
  engine.setPlaybackGate(true, '复核播放中 · 已暂停监听');
  assert.equal(engine.getState().status, 'paused-loopback');
  assert.equal(engine.getState().active, true);
  assert.equal(engine.getState().gateActive, true);
  assert.equal(engine.getState().gateReason, '复核播放中 · 已暂停监听');
  assert.deepEqual(wSys1.sentMessages.at(-1), { type: 'pause', value: true });

  // Bypass MUST be rejected for system audio.
  assert.equal(engine.setAllowGateBypass(true), false);
  assert.equal(engine.getState().allowGateBypass, false);
  assert.equal(engine.getState().status, 'paused-loopback');

  // Late envelopes and windows arriving while gated must be ignored.
  wSys1.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0.9, 0.9]), silentSeconds: 0 });
  wSys1.emitFromWorklet({ type: 'window', waveform: new Float32Array([9, 9]), coveredSeconds: 10 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(engine.getState().envelopeBucketCount, 50);
  assert.equal(harness.workers.length, 0);

  // Playback stops or mutes 2s later -> resumes worklet and keeps wall-clock alignment.
  harness.nowRef.value = t0 + 3000;
  engine.setPlaybackGate(false);
  assert.equal(engine.getState().status, 'listening');
  assert.equal(engine.getState().gateActive, false);
  assert.equal(engine.getState().gateReason, null);
  assert.deepEqual(wSys1.sentMessages.at(-1), { type: 'pause', value: false });

  wSys1.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0.7, 0.5]), silentSeconds: 0 });
  assert.equal(engine.getState().envelopeBucketCount, 50 + 100 + 1); // 1s + 2s paused gap + 1 bucket

  // Switch to virtual audio device -> gated by default, but bypass IS allowed.
  await engine.switchAudioSource({ sourceKind: 'device', deviceId: 'vb-1' });
  const wDev = harness.workletNodes[1];
  engine.setPlaybackGate(true, '复核播放中');
  assert.equal(engine.getState().status, 'paused-loopback');
  assert.deepEqual(wDev.sentMessages.at(-1), { type: 'pause', value: true });

  assert.equal(engine.setAllowGateBypass(true), true);
  assert.equal(engine.getState().allowGateBypass, true);
  assert.equal(engine.getState().gateActive, false);
  assert.equal(engine.getState().status, 'listening');
  assert.deepEqual(wDev.sentMessages.at(-1), { type: 'pause', value: false });

  // Inference runs normally on device audio while bypassed.
  wDev.emitFromWorklet({ type: 'window', waveform: new Float32Array([1, 2, 3, 4]), coveredSeconds: 10 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(harness.workers.length, 1);
  assert.equal(harness.workers[0].posted.length, 1);

  // Disabling bypass while unmuted playback is STILL active immediately re-pauses.
  assert.equal(engine.setAllowGateBypass(false), true);
  assert.equal(engine.getState().status, 'paused-loopback');
  assert.equal(engine.getState().gateActive, true);
  assert.deepEqual(wDev.sentMessages.at(-1), { type: 'pause', value: true });

  // Re-enable bypass, then switch back to system audio -> bypass is cleared and gate is re-enforced!
  assert.equal(engine.setAllowGateBypass(true), true);
  assert.equal(engine.getState().status, 'listening');

  await engine.switchAudioSource({ sourceKind: 'system' });
  const wSys2 = harness.workletNodes[2];
  assert.equal(engine.getState().sourceKind, 'system');
  assert.equal(engine.getState().allowGateBypass, false);
  assert.equal(engine.getState().gateActive, true);
  assert.equal(engine.getState().status, 'paused-loopback');
  assert.deepEqual(wSys2.sentMessages.at(-1), { type: 'pause', value: true });

  await engine.dispose();
});

test('audio track disconnect notifies subscribers, tears down capture, and preserves rolling history for pending alignment', async () => {
  const audioTrack = createFakeTrack({ kind: 'audio', label: 'System Audio' });
  const videoTrack = createFakeTrack({ kind: 'video', label: 'Screen' });
  const harness = createFakeHarness({
    displayStreamFactory: () => createFakeStream({ videoTracks: [videoTrack], audioTracks: [audioTrack] }),
  });
  const engine = createLiveMonitorEngine(harness);

  const statuses = [];
  engine.subscribe((s) => statuses.push(s.status));

  await engine.start({ sourceKind: 'system' });
  const worklet = harness.workletNodes[0];
  worklet.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0.5, 0.3, 0.6, 0.4]), silentSeconds: 0 });
  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([1, 2]), coveredSeconds: 10 });
  await new Promise((r) => setTimeout(r, 0));

  // User clicks "Stop sharing" in browser banner -> audio track ends unexpectedly.
  audioTrack.emit('ended');
  await new Promise((r) => setTimeout(r, 0));

  const state = engine.getState();
  assert.equal(state.status, 'disconnected');
  assert.equal(state.active, false);
  assert.ok(state.disconnectReason);
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(harness.audioContexts[0].closed, true);
  assert.equal(harness.workletNodes[0].disconnected, true);
  assert.equal(harness.workers[0].terminated, true);

  // Rolling history survives disconnect so an already-recording match can still conform.
  const history = engine.getHistoryForAlignment();
  assert.equal(history.envPeaks.length, 2);

  await engine.dispose();
});

test('stop transitions cleanly to idle without triggering disconnect, preserves history, cancels in-flight start, and dispose clears everything', async () => {
  const audioTrack = createFakeTrack({ kind: 'audio', label: 'VB-Cable', deviceId: 'vb-1', emitEndedOnStop: true });
  const deferred = Promise.withResolvers();
  let callIndex = 0;

  const harness = createFakeHarness({
    userStreamFactory: () => {
      callIndex++;
      if (callIndex === 1) return createFakeStream({ audioTracks: [audioTrack] });
      return deferred.promise;
    },
  });
  const engine = createLiveMonitorEngine(harness);

  const observed = [];
  engine.subscribe((s) => observed.push(s.status));

  await engine.start({ sourceKind: 'device', deviceId: 'vb-1' });
  const worklet = harness.workletNodes[0];
  worklet.emitFromWorklet({ type: 'envelope', buckets: new Float32Array([0.7, 0.4]), silentSeconds: 12 });
  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([1, 2]), coveredSeconds: 10 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(engine.getState().silenceWarning, true);

  // Explicit stop detaches audio ended listener first so status goes directly to 'idle' (never 'disconnected').
  const stopped = await engine.stop();
  assert.equal(stopped.status, 'idle');
  assert.equal(stopped.active, false);
  assert.equal(stopped.silenceWarning, false);
  assert.equal(stopped.silentSeconds, 0);
  assert.equal(audioTrack.stoppedCount, 1);
  assert.equal(harness.audioContexts[0].closed, true);
  assert.equal(harness.workers[0].terminated, true);
  assert.equal(observed.includes('disconnected'), false);
  assert.equal(engine.getHistoryForAlignment().envPeaks.length, 1);

  // Start a second capture whose getUserMedia resolves AFTER stop() is called -> late track is stopped cleanly.
  const pendingStart = engine.start({ sourceKind: 'device', deviceId: 'vb-1' });
  assert.equal(engine.getState().status, 'starting');
  await engine.stop();
  assert.equal(engine.getState().status, 'idle');

  const lateTrack = createFakeTrack({ kind: 'audio', label: 'Late' });
  deferred.resolve(createFakeStream({ audioTracks: [lateTrack] }));
  await pendingStart;
  assert.equal(lateTrack.stoppedCount, 1);
  assert.equal(harness.audioContexts.length, 1); // no leaked AudioContext
  assert.equal(engine.getState().status, 'idle');

  // Dispose clears rolling history, unsubscribes listeners, is idempotent, and blocks future starts.
  const countBeforeDispose = observed.length;
  await engine.dispose();
  await engine.dispose();
  assert.equal(engine.getHistoryForAlignment().envPeaks.length, 0);
  assert.equal(engine.getHistoryForAlignment().scoreWindows.length, 0);
  assert.equal(observed.length, countBeforeDispose);
  await assert.rejects(() => engine.start({ sourceKind: 'system' }), /销毁/);
});

test('worker error and crash recover cleanly without stalling subsequent inference windows', async () => {
  const harness = createFakeHarness({
    userStreamFactory: () => createFakeStream({ audioTracks: [createFakeTrack({ kind: 'audio', label: 'Dev' })] }),
  });
  const engine = createLiveMonitorEngine(harness);

  await engine.start({ sourceKind: 'device' });
  const worklet = harness.workletNodes[0];

  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([1]), coveredSeconds: 10 });
  await new Promise((r) => setTimeout(r, 0));
  const worker1 = harness.workers[0];

  // Queue a second window while worker1 is busy, then fail worker1's request with an inference error.
  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([2]), coveredSeconds: 10 });
  worker1.emitMessage({ id: worker1.posted[0].msg.id, type: 'error', message: 'WASM OOM' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(engine.getState().error, 'WASM OOM');
  assert.equal(worker1.posted.length, 2); // pending window still drained cleanly!
  assert.equal(worker1.posted[1].msg.waveform[0], 2);

  // Now simulate catastrophic worker crash -> terminates dead worker and next window spawns a fresh one.
  worker1.emitError('Worker crashed');
  assert.equal(worker1.terminated, true);
  assert.equal(engine.getState().error, 'Worker crashed');

  worklet.emitFromWorklet({ type: 'window', waveform: new Float32Array([3]), coveredSeconds: 10 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(harness.workers.length, 2);
  assert.equal(harness.workers[1].posted[0].msg.waveform[0], 3);

  await engine.dispose();
});

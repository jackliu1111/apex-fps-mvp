import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisQueue } from '../../../site/analysis-queue.mjs';
import { createBrowserAnalysis } from '../../../site/browser-analysis.mjs';
import { createReviewWorkspace } from '../../../site/review-workspace.mjs';
import { probeRecordingFile } from '../../../site/recording-probe.mjs';
import {
  createAutoIntakeService,
  AUTO_INTAKE_STATES,
  INTAKE_EVENT_KINDS,
  ALIGNMENT_CONFIDENCE,
} from '../../../site/auto-intake-service.mjs';
import { createLiveAudioHistory } from '../../../site/live-audio-history.mjs';
import { createLiveMonitorEngine, AUDIO_SOURCE_KINDS } from '../../../site/live-monitor-engine.mjs';
import { ENVELOPE_STEP_SECONDS } from '../../../site/audio-aligner.mjs';

test('analysis-queue autoAnalyze:false prepares into unanalyzed without running offline scan, start/retry triggers analysis, and review-workspace accepts unanalyzed', async () => {
  const workspace = createReviewWorkspace();
  let analyzeCalls = 0;
  let prepareCalls = 0;
  const statuses = [];

  const queue = createAnalysisQueue({
    prepare: async () => {
      prepareCalls++;
      return { duration: 40 };
    },
    onPrepared: async (record) => {
      record.sourceId = workspace.addSource({
        id: `source:${record.file.name}`,
        name: record.file.name,
        size: 1024,
        lastModified: 1000,
        fingerprint: record.file.name,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    analyze: async (record, { publish }) => {
      analyzeCalls++;
      publish([{ key: 'offline-1', start: 5, end: 15, provisional: false }], {
        processedUntil: record.duration,
        frontier: Infinity,
      });
    },
    onCandidates: (record, candidates) => {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, candidates);
    },
    onChange: (record) => {
      statuses.push(record.status);
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });

  const [record] = await queue.importFiles([{ name: 'uncovered.mkv' }], { autoAnalyze: false });
  await queue.whenIdle();

  assert.equal(prepareCalls, 1);
  assert.equal(analyzeCalls, 0);
  assert.equal(record.status, 'unanalyzed');
  assert.equal(workspace.getSource(record.sourceId).analysis.status, 'unanalyzed');
  assert.equal(statuses.includes('queued'), false);
  assert.equal(statuses.includes('analyzing'), false);

  // Starting analysis from unanalyzed queues and completes without re-preparing media.
  const started = await queue.start(record.id);
  assert.equal(started, true);
  await queue.whenIdle();

  assert.equal(prepareCalls, 1);
  assert.equal(analyzeCalls, 1);
  assert.equal(record.status, 'complete');
  assert.equal(workspace.getSource(record.sourceId).analysis.status, 'completed');
  assert.equal(record.candidates.length, 1);

  // Calling start() on an already complete record returns false.
  assert.equal(await queue.start(record.id), false);

  // retry() also starts from unanalyzed directly.
  const [second] = await queue.importFiles([{ name: 'uncovered-2.mkv' }], { autoAnalyze: false });
  assert.equal(second.status, 'unanalyzed');
  assert.equal(await queue.retry(second.id), true);
  await queue.whenIdle();
  assert.equal(second.status, 'complete');
  assert.equal(analyzeCalls, 2);

  await queue.dispose();
});

test('re-analyzing a conformed complete record via retry clears stale coarse alignment and replaces candidates with full offline results', async () => {
  const classes = ['Speech', 'Gunshot, gunfire', 'Machine gun'];
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

  const track = {
    id: 1,
    codec: 'opus',
    canDecode: async () => true,
    getFirstTimestamp: async () => 0,
    computeDuration: async () => 10,
  };
  const video = {
    getFirstTimestamp: async () => 0,
    computeDuration: async () => 10,
  };
  const MB = {
    ALL_FORMATS: [],
    BlobSource: class {},
    Input: class {
      async getPrimaryVideoTrack() { return video; }
      async getAudioTracks() { return [track]; }
      async getPrimaryAudioTrack() { return track; }
      dispose() {}
    },
  };
  const openAudioStream = (_mb, _track, _origin, _len, sampleRate, check, _metrics, onDecoded) => ({
    async next() {
      check();
      onDecoded({
        timestamp: 0,
        buffer: { duration: 10, numberOfChannels: 1, getChannelData: () => new Float32Array([0.4]) },
      });
      return new Float32Array(sampleRate * 10);
    },
    async close() {},
  });

  const observedAlignments = [];
  const queue = createBrowserAnalysis({
    MB,
    openAudioStream,
    fetch: async () => ({ ok: true, status: 200, json: async () => manifest }),
    infer: async () => {
      const values = new Float32Array(250 * classes.length);
      // Put an offline gunshot burst at frames 150..160 (6.0s..6.4s)
      for (let f = 150; f <= 160; f++) values[f * classes.length + 1] = 0.9;
      return { values, dims: [1, 250, classes.length], timings: { inferenceMs: 5 } };
    },
    onChange(record) {
      observedAlignments.push({ status: record.status, alignment: record.alignment });
    },
  });

  const file = new File([new Uint8Array(64)], 'coarse-match.mkv', { lastModified: 10_000 });
  const record = await queue.importPrecomputed(file, {
    windowScores: [{ start: 1, end: 2, scores: [0.85, 0.1] }],
    alignment: { confidence: 'coarse', offsetMs: 0, correlation: 0.21, driftPpm: 0, anchorStartSec: 0 },
  });

  assert.equal(record.status, 'complete');
  assert.equal(record.alignment?.confidence, 'coarse');
  assert.equal(record.candidates.length, 1);
  assert.deepEqual([record.candidates[0].start, record.candidates[0].end], [0, 7]);

  observedAlignments.length = 0;
  assert.equal(await queue.retry(record.id), true);
  await queue.whenIdle();

  assert.equal(record.status, 'complete');
  assert.equal(record.alignment, null);
  assert.equal(record.windowScores, null);
  assert.ok(record.scores instanceof Float32Array);
  assert.equal(record.candidates.length, 1);
  assert.ok(record.candidates[0].start >= 0.9 && record.candidates[0].end <= 10);
  // Confirm alignment was cleared once offline analysis began running.
  const analyzingSnap = observedAlignments.find((item) => item.status === 'analyzing');
  assert.equal(analyzingSnap?.alignment, null);

  await queue.dispose();
});

function mp4Box(type, payloadLength = 8, { declaredSize = null, large = false } = {}) {
  const headerSize = large ? 16 : 8;
  const totalDeclared = declaredSize ?? (headerSize + payloadLength);
  const actualLength = headerSize + payloadLength;
  const buf = new Uint8Array(actualLength);
  const view = new DataView(buf.buffer);
  if (large) {
    view.setUint32(0, 1, false);
    for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
    view.setUint32(8, Math.floor(totalDeclared / 0x100000000), false);
    view.setUint32(12, totalDeclared >>> 0, false);
  } else {
    view.setUint32(0, totalDeclared, false);
    for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  }
  return buf;
}

test('probeRecordingFile treats unfinished MP4 recordings (missing moov, truncated moov, truncated mdat/largesize) as pendingFinalization without parsing', async () => {
  let inputOpened = 0;
  const fakeMB = {
    ALL_FORMATS: [],
    BlobSource: class {},
    Input: class {
      constructor() { inputOpened++; }
      async getPrimaryVideoTrack() {
        return {
          displayWidth: 1920,
          displayHeight: 1080,
          getFirstTimestamp: async () => 0,
          computeDuration: async () => 42.5,
        };
      }
      dispose() {}
    },
  };

  // 1) Classic MP4 still recording: ftyp + mdat (size=0 extending to EOF), no moov yet.
  const noMoov = new File([mp4Box('ftyp', 16), mp4Box('mdat', 64, { declaredSize: 0 })], 'shadowplay.mp4', { lastModified: 2000 });
  assert.deepEqual(await probeRecordingFile(noMoov, fakeMB), { pendingFinalization: true });
  assert.equal(inputOpened, 0);

  // 2) Truncated moov trailer: ftyp + mdat + moov declaring 512 bytes with only 24 present.
  const truncatedMoov = new File([
    mp4Box('ftyp', 16),
    mp4Box('mdat', 64),
    mp4Box('moov', 16, { declaredSize: 512 }),
  ], 'shadowplay.mp4', { lastModified: 2500 });
  assert.deepEqual(await probeRecordingFile(truncatedMoov, fakeMB), { pendingFinalization: true });
  assert.equal(inputOpened, 0);

  // 3) Truncated 64-bit largesize mdat after fast-start moov.
  const truncatedLargeMdat = new File([
    mp4Box('ftyp', 16),
    mp4Box('moov', 32),
    mp4Box('mdat', 16, { declaredSize: 10_000, large: true }),
  ], 'obs-faststart.mp4', { lastModified: 2600 });
  assert.deepEqual(await probeRecordingFile(truncatedLargeMdat, fakeMB), { pendingFinalization: true });
  assert.equal(inputOpened, 0);

  // 4) Finalized classic MP4 (ftyp + mdat + complete moov) probes normally.
  const finalizedClassic = new File([
    mp4Box('ftyp', 16),
    mp4Box('mdat', 64),
    mp4Box('moov', 48),
  ], 'shadowplay.mp4', { lastModified: 3000 });
  const classicMeta = await probeRecordingFile(finalizedClassic, fakeMB);
  assert.deepEqual(classicMeta, { duration: 42.5, origin: 0, width: 1920, height: 1080 });
  assert.equal(inputOpened, 1);

  // 5) Finalized fast-start MP4 (ftyp + moov + complete 64-bit mdat) probes normally.
  const finalizedFastStart = new File([
    mp4Box('ftyp', 16),
    mp4Box('moov', 32),
    mp4Box('mdat', 64, { large: true }),
  ], 'obs-faststart.mp4', { lastModified: 3200 });
  const fastMeta = await probeRecordingFile(finalizedFastStart, fakeMB);
  assert.deepEqual(fastMeta, { duration: 42.5, origin: 0, width: 1920, height: 1080 });
  assert.equal(inputOpened, 2);

  // 6) Unpatched MP4 mdat placeholder (declared size=8) followed by raw bitstream (invalid next box size=2) and no moov.
  const rawBitstream = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88, 0x80, 0x20, 0xff, 0x01, 0x02, 0x03]);
  const unpatchedPlaceholderMdat = new File([
    mp4Box('ftyp', 16),
    mp4Box('free', 0),
    mp4Box('mdat', 0, { declaredSize: 8 }),
    rawBitstream,
  ], 'quicktime-recording.mp4', { lastModified: 3300 });
  assert.deepEqual(await probeRecordingFile(unpatchedPlaceholderMdat, fakeMB), { pendingFinalization: true });
  assert.equal(inputOpened, 2);

  // 7) Finalized MP4 with empty 8-byte mdat followed by complete moov probes normally.
  const emptyMdatWithMoov = new File([
    mp4Box('ftyp', 16),
    mp4Box('mdat', 0, { declaredSize: 8 }),
    mp4Box('moov', 32),
  ], 'empty-mdat-finalized.mp4', { lastModified: 3400 });
  assert.deepEqual(await probeRecordingFile(emptyMdatWithMoov, fakeMB), { duration: 42.5, origin: 0, width: 1920, height: 1080 });
  assert.equal(inputOpened, 3);

  // 8) Non-ISO-BMFF garbage renamed .mp4 falls through to MB.Input (does not spin pendingFinalization forever).
  const corruptNotMp4 = new File([new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x41, 0x42, 0x43, 0x44, 0x00, 0x00])], 'not-mp4.mp4', { lastModified: 3500 });
  await probeRecordingFile(corruptNotMp4, fakeMB);
  assert.equal(inputOpened, 4);
});

const hex = (value) => Buffer.from(value.replaceAll(' ', ''), 'hex');
const voidSeekHead = Buffer.concat([hex('ec 0100000000000098'), Buffer.alloc(152)]);
const unknownEbmlSize = hex('01ffffffffffffff');

function makeObsMkvFile(name, { closed = false, lastModified = 2000 } = {}) {
  const app = Buffer.from('Lavf61.7.100');
  const infoBody = Buffer.concat([
    hex('2ad7b1 83 0f4240'),
    hex('4d80'), Buffer.of(0x80 + app.length), app,
    hex(closed ? '44898840d99e4000000000' : 'ec01000000000000020000'),
  ]);
  const body = Buffer.concat([
    closed ? hex('114d9b7480') : voidSeekHead,
    hex('1549a966'), Buffer.of(0x80 + infoBody.length), infoBody,
    hex('1f43b67581'), Buffer.alloc(closed ? 200 : 16),
  ]);
  const size = closed ? Buffer.of(0x40 + (body.length >> 8), body.length & 0xff) : unknownEbmlSize;
  return new File([hex('1a45dfa38018538067'), size, body], name, { lastModified });
}

function makeFakeDirectory(name, filesMap, { permission = 'granted' } = {}) {
  const permissionQueries = [];
  const permissionRequests = [];
  const handle = {
    name,
    permissionQueries,
    permissionRequests,
    async queryPermission(opts) {
      permissionQueries.push(opts);
      return permission;
    },
    async requestPermission(opts) {
      permissionRequests.push(opts);
      return permission;
    },
    async *entries() {
      for (const [fileName, file] of filesMap.entries()) {
        yield [fileName, {
          kind: 'file',
          async getFile() {
            return file;
          },
        }];
      }
    },
  };
  return handle;
}

function makeFakeMediaBoundary({ durationByName = {}, defaultDuration = 30, pcmByName = {} } = {}) {
  let analyzeCalls = 0;
  let probeInputOpens = 0;
  const classes = ['Speech', 'Gunshot, gunfire', 'Machine gun'];
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

  class FakeAudioBufferSink {
    constructor(track) {
      this.track = track;
    }
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
    BlobSource: class {
      constructor(file) { this.file = file; }
    },
    AudioBufferSink: FakeAudioBufferSink,
    Input: class {
      constructor({ source }) {
        probeInputOpens++;
        this.file = source.file;
      }
      async getPrimaryVideoTrack() {
        const dur = durationByName[this.file?.name] ?? defaultDuration;
        return {
          displayWidth: 1920,
          displayHeight: 1080,
          getFirstTimestamp: async () => 0,
          computeDuration: async () => dur,
        };
      }
      async getAudioTracks() {
        const dur = durationByName[this.file?.name] ?? defaultDuration;
        return [{
          id: 1,
          fileName: this.file?.name,
          codec: 'opus',
          canDecode: async () => true,
          getFirstTimestamp: async () => 0,
          computeDuration: async () => dur,
        }];
      }
      async getPrimaryAudioTrack() {
        return (await this.getAudioTracks())[0];
      }
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
            getChannelData: () => new Float32Array([0.35]),
          },
        });
        idx++;
        return new Float32Array(sampleRate * 10);
      },
      async close() {},
    };
  };

  const fetch = async () => ({ ok: true, status: 200, json: async () => manifest });
  const infer = async () => {
    analyzeCalls++;
    const values = new Float32Array(250 * classes.length);
    for (let f = 100; f <= 115; f++) values[f * classes.length + 1] = 0.88;
    return { values, dims: [1, 250, classes.length], timings: { inferenceMs: 4 } };
  };

  return {
    MB,
    openAudioStream,
    fetch,
    infer,
    get analyzeCalls() { return analyzeCalls; },
    get probeInputOpens() { return probeInputOpens; },
  };
}

test('auto-intake enforces read-only watch directory, ignores historical/temp/dot/self-exported files, and waits for OBS MKV and MP4 finalization', async (t) => {
  const media = makeFakeMediaBoundary({
    durationByName: { 'obs-match.mkv': 35, 'nvidia-match.mp4': 28 },
  });
  const workspace = createReviewWorkspace();
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
    async onPrepared(record) {
      record.sourceId = workspace.addSource({
        id: `source:${record.file.name}`,
        name: record.file.name,
        size: record.file.size,
        lastModified: record.file.lastModified,
        fingerprint: `${record.file.name}:${record.file.size}`,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    onWaveform(record, wf) {
      if (record.sourceId) workspace.updateWaveform(record.sourceId, wf);
    },
    onCandidates(record, cands) {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, cands);
    },
    onChange(record) {
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });

  const events = [];
  const snapshots = [];
  let clock = 10_000;

  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => clock,
    onIntake: (event) => events.push(event),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const unsubscribe = service.subscribe((snap) => snapshots.push(snap));
  assert.equal(service.getState().status, AUTO_INTAKE_STATES.IDLE);
  assert.equal(service.getState().watching, false);

  // Denied read permission rejects cleanly without ever requesting readwrite.
  const deniedDir = makeFakeDirectory('Locked Captures', new Map(), { permission: 'denied' });
  await assert.rejects(() => service.startWatching(deniedDir), /只读权限/);
  assert.deepEqual(deniedDir.permissionQueries, [{ mode: 'read' }]);
  assert.equal(deniedDir.permissionRequests.length, 0);

  // Start watching a read-only directory containing a pre-start historical file.
  const files = new Map([
    ['historical-old.mkv', makeObsMkvFile('historical-old.mkv', { closed: true, lastModified: 5_000 })],
  ]);
  const watchDir = makeFakeDirectory('OBS Captures', files, { permission: 'granted' });
  const startedState = await service.startWatching(watchDir);

  assert.deepEqual(watchDir.permissionQueries, [{ mode: 'read' }]);
  assert.equal(startedState.status, AUTO_INTAKE_STATES.WATCHING);
  assert.equal(startedState.watching, true);
  assert.equal(startedState.directoryName, 'OBS Captures');

  // Register a self-exported clip filename (even if output directory is the same folder).
  service.registerExportedFilename('match-clip-01.mp4');

  // Add ignored noise: temp suffixes, dotfile, self-exported clip, plus unfinished MKV & unfinished MP4.
  clock = 12_000;
  files.set('temp1.mp4.tmp', new File([mp4Box('ftyp', 16), mp4Box('moov', 24)], 'temp1.mp4.tmp', { lastModified: 11_000 }));
  files.set('temp2.mkv.part', makeObsMkvFile('temp2.mkv.part', { closed: true, lastModified: 11_000 }));
  files.set('temp3.mp4.crdownload', new File([mp4Box('ftyp', 16), mp4Box('moov', 24)], 'temp3.mp4.crdownload', { lastModified: 11_000 }));
  files.set('temp4.mkv.incomplete', makeObsMkvFile('temp4.mkv.incomplete', { closed: true, lastModified: 11_000 }));
  files.set('.hidden.mkv', makeObsMkvFile('.hidden.mkv', { closed: true, lastModified: 11_000 }));
  files.set('match-clip-01.mp4', new File([mp4Box('ftyp', 16), mp4Box('mdat', 32), mp4Box('moov', 32)], 'match-clip-01.mp4', { lastModified: 11_000 }));
  files.set('obs-match.mkv', makeObsMkvFile('obs-match.mkv', { closed: false, lastModified: 11_500 }));
  files.set('nvidia-match.mp4', new File([mp4Box('ftyp', 16), mp4Box('mdat', 64, { declaredSize: 0 })], 'nvidia-match.mp4', { lastModified: 11_500 }));

  // Poll many times while both recordings are still unfinished -> neither is ingested or ignored!
  for (let i = 0; i < 10; i++) await service.pollNow();
  assert.equal(events.length, 0);
  assert.equal(queue.records.length, 0);
  assert.equal(media.probeInputOpens, 0, 'unfinished MKV/MP4 must never open media parser');
  assert.deepEqual(
    service.getState().tracked.map((e) => e.name).sort(),
    ['nvidia-match.mp4', 'obs-match.mkv'],
  );

  // Finalize both recordings.
  clock = 15_000;
  files.set('obs-match.mkv', makeObsMkvFile('obs-match.mkv', { closed: true, lastModified: 14_500 }));
  files.set('nvidia-match.mp4', new File([mp4Box('ftyp', 16), mp4Box('mdat', 128), mp4Box('moov', 48)], 'nvidia-match.mp4', { lastModified: 14_500 }));

  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.name).sort(), ['nvidia-match.mp4', 'obs-match.mkv']);
  for (const ev of events) {
    assert.equal(ev.kind, INTAKE_EVENT_KINDS.UNANALYZED);
    assert.equal(ev.alignment, null);
    assert.equal(ev.record.status, 'unanalyzed');
    assert.equal(workspace.getSource(ev.record.sourceId).analysis.status, 'unanalyzed');
  }
  assert.equal(media.analyzeCalls, 0, 'uncovered recordings must never auto-run offline inference');
  assert.equal(service.getState().intakeCount, 2);

  service.stopWatching();
  assert.equal(service.getState().status, AUTO_INTAKE_STATES.IDLE);
  assert.equal(service.getState().watching, false);
  assert.ok(snapshots.length > 0);
  unsubscribe();
});

function buildSyntheticCombatPcm(durationSec, sampleRate = 8000, seed = 11) {
  const totalSamples = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(totalSamples);
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < totalSamples; i++) samples[i] = rand() * 0.03;
  const bursts = [3.5, 7.2, 11.4, 15.8, 21.1, 26.7, 33.4, 41.0, 48.2];
  for (const tSec of bursts) {
    const start = Math.floor(tSec * sampleRate);
    const len = Math.floor(0.35 * sampleRate);
    for (let k = 0; k < len && start + k < totalSamples; k++) {
      const env = Math.exp(-k / (0.09 * sampleRate));
      samples[start + k] = Math.max(-1, Math.min(1, samples[start + k] + rand() * 0.85 * env));
    }
  }
  return samples;
}

function pcmToInterleavedEnvelope(samples, sampleRate, stepSec = ENVELOPE_STEP_SECONDS) {
  const bucketSamples = Math.round(sampleRate * stepSec);
  const count = Math.floor(samples.length / bucketSamples);
  const out = new Float32Array(count * 2);
  for (let b = 0; b < count; b++) {
    let peak = 0;
    let sumSq = 0;
    const base = b * bucketSamples;
    for (let i = 0; i < bucketSamples; i++) {
      const v = samples[base + i];
      const av = Math.abs(v);
      if (av > peak) peak = av;
      sumSq += v * v;
    }
    out[b * 2] = peak;
    out[b * 2 + 1] = Math.sqrt(sumSq / bucketSamples);
  }
  return out;
}

test('auto-intake performs two-stage exact conform from live monitor audio history without offline scan or liveDecisions migration', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_000_000_000;
  const livePcm = buildSyntheticCombatPcm(55, sampleRate, 19);

  // Master recording truly started at liveStart + 5.0s and lasted 35.0s.
  // File mtime is written 1.3s early/late so coarse start is off by -1300ms -> NCC recovers +1300ms.
  const trueMasterStartSec = 5;
  const masterDurationSec = 35;
  const masterPcm = livePcm.subarray(
    trueMasterStartSec * sampleRate,
    (trueMasterStartSec + masterDurationSec) * sampleRate,
  );
  const trueMasterStartMs = liveStartMs + trueMasterStartSec * 1000;
  const injectedCoarseErrorMs = -1300;
  const masterLastModified = trueMasterStartMs + masterDurationSec * 1000 + injectedCoarseErrorMs;

  // Populate real #58 pure-audio live history.
  const history = createLiveAudioHistory();
  history.begin(liveStartMs);
  history.pushEnvelope(pcmToInterleavedEnvelope(livePcm, sampleRate), liveStartMs);

  // Push two 10s score windows with a gunshot fight around live +15s..+25s (master +10s..+20s).
  const frameGroupScores = new Float32Array(250 * 4);
  for (let f = 50; f <= 80; f++) frameGroupScores[f * 4 + 0] = 0.89;
  history.pushScoreWindow({
    wallStartMs: liveStartMs + 15_000,
    wallEndMs: liveStartMs + 25_000,
    scores: [0.89, 0.12],
    groupScores: [0.89, 0.2, 0.05, 0.1],
    frameGroupScores,
    frameSeconds: 0.04,
  });

  // Also test defensive guarantee: even if a legacy history payload includes `decisions`, never migrate them.
  const fakeLiveMonitor = {
    getState: () => ({ modelId: 'efficientsed', status: 'listening', active: true }),
    getHistoryForAlignment: () => ({
      ...history.exportForAlignment(),
      decisions: [
        { id: 'legacy-mark-1', kind: 'retain', wallStartMs: liveStartMs + 16_000, wallEndMs: liveStartMs + 22_000 },
      ],
    }),
  };

  const media = makeFakeMediaBoundary({
    durationByName: { 'ranked-match.mkv': masterDurationSec },
    pcmByName: { 'ranked-match.mkv': { sampleRate, samples: masterPcm } },
  });

  const workspace = createReviewWorkspace();
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
    async onPrepared(record) {
      record.sourceId = workspace.addSource({
        id: `source:${record.file.name}`,
        name: record.file.name,
        size: record.file.size,
        lastModified: record.file.lastModified,
        fingerprint: `${record.file.name}:${record.file.size}`,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    onWaveform(record, wf) {
      if (record.sourceId) workspace.updateWaveform(record.sourceId, wf);
    },
    onCandidates(record, cands) {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, cands);
    },
    onChange(record) {
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });

  const events = [];
  let clock = liveStartMs;
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    liveMonitor: fakeLiveMonitor,
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => clock,
    onIntake: (event) => events.push(event),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const files = new Map();
  await service.startWatching(makeFakeDirectory('Apex Captures', files));

  clock = masterLastModified + 500;
  const finalized = makeObsMkvFile('ranked-match.mkv', { closed: true, lastModified: masterLastModified });
  files.set('ranked-match.mkv', finalized);

  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  const [ev] = events;
  assert.equal(ev.kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);
  assert.equal(ev.name, 'ranked-match.mkv');
  assert.equal(ev.file, finalized);
  assert.equal(ev.alignment.confidence, ALIGNMENT_CONFIDENCE.EXACT);
  assert.ok(
    Math.abs(ev.alignment.offsetMs - (-injectedCoarseErrorMs)) <= 40,
    `expected offsetMs near +1300ms, got ${ev.alignment.offsetMs}ms`,
  );
  assert.ok(ev.alignment.correlation >= 0.65);
  assert.equal(typeof ev.alignment.driftPpm, 'number');
  assert.equal(typeof ev.alignment.anchorStartSec, 'number');
  assert.equal('liveDecisions' in ev, false);

  const record = ev.record;
  assert.equal(record.status, 'complete');
  assert.equal(record.alignment.confidence, 'exact');
  assert.ok(record.windowScores.length >= 1);
  assert.ok(record.scoreTimeline?.groupScorePyramid);
  assert.ok(record.waveform?.peaks?.length > 0);
  assert.ok(record.candidates.length >= 1);
  assert.equal('liveDecisions' in record, false);
  assert.equal(media.analyzeCalls, 0, 'exact conform must skip full offline scan');

  const sourceSnap = workspace.getSource(record.sourceId);
  assert.equal(sourceSnap.analysis.status, 'completed');
  assert.deepEqual(sourceSnap.decisions, [], 'must NOT migrate legacy liveDecisions or manual marks');
  assert.ok(sourceSnap.clips.length >= 1);
  assert.ok(sourceSnap.waveform);
});

test('auto-intake conforms uncorrelated overlapping recording as coarse and reanalyze() replaces coarse alignment with full offline analysis', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_000_100_000;
  const livePcm = buildSyntheticCombatPcm(45, sampleRate, 31);

  // Uncorrelated smooth hum PCM on master recording -> overlaps wall-clock, fails NCC -> coarse alignment.
  const masterDurationSec = 10;
  const uncorrelatedPcm = new Float32Array(masterDurationSec * sampleRate);
  for (let i = 0; i < uncorrelatedPcm.length; i++) {
    uncorrelatedPcm[i] = Math.sin(i * 0.05) * 0.15;
  }

  const history = createLiveAudioHistory();
  history.begin(liveStartMs);
  history.pushEnvelope(pcmToInterleavedEnvelope(livePcm, sampleRate), liveStartMs);
  history.pushScoreWindow({
    wallStartMs: liveStartMs + 10_000,
    wallEndMs: liveStartMs + 20_000,
    scores: [0.84, 0.1],
    groupScores: [0.84, 0.15, 0.02, 0.05],
  });

  const media = makeFakeMediaBoundary({
    durationByName: { 'voice-track-mismatch.mp4': masterDurationSec },
    pcmByName: { 'voice-track-mismatch.mp4': { sampleRate, samples: uncorrelatedPcm } },
  });

  const workspace = createReviewWorkspace();
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
    async onPrepared(record) {
      record.sourceId = workspace.addSource({
        id: `source:${record.file.name}`,
        name: record.file.name,
        size: record.file.size,
        lastModified: record.file.lastModified,
        fingerprint: `${record.file.name}:${record.file.size}`,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    onWaveform(record, wf) {
      if (record.sourceId) workspace.updateWaveform(record.sourceId, wf);
    },
    onCandidates(record, cands) {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, cands);
    },
    onChange(record) {
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });

  const events = [];
  let clock = liveStartMs;
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    getLiveHistory: () => history.exportForAlignment(),
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => clock,
    onIntake: (event) => events.push(event),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const files = new Map();
  await service.startWatching(makeFakeDirectory('NVIDIA Captures', files));

  const masterLastModified = liveStartMs + 20_000; // coarse start = liveStart + 10s
  clock = masterLastModified + 500;
  files.set('voice-track-mismatch.mp4', new File(
    [mp4Box('ftyp', 16), mp4Box('mdat', 64), mp4Box('moov', 48)],
    'voice-track-mismatch.mp4',
    { lastModified: masterLastModified },
  ));

  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.CONFORMED_COARSE);
  assert.equal(events[0].alignment.confidence, ALIGNMENT_CONFIDENCE.COARSE);
  const record = events[0].record;
  assert.equal(record.status, 'complete');
  assert.equal(record.alignment.confidence, 'coarse');
  assert.equal(media.analyzeCalls, 0);

  // Add a human review decision before triggering offline re-analysis.
  const manualId = workspace.addManual(record.sourceId, { start: 0.5, end: 2.5 });

  // Trigger full offline re-analysis through service.reanalyze().
  assert.equal(await service.reanalyze('missing-id'), false);
  assert.equal(await service.reanalyze(record.id), true);
  await queue.whenIdle();

  assert.equal(media.analyzeCalls, 1);
  assert.equal(record.status, 'complete');
  assert.equal(record.alignment, null, 'coarse alignment must be cleared after offline re-analysis');
  assert.equal(record.windowScores, null);
  assert.ok(record.scores instanceof Float32Array);

  const afterReview = workspace.getSource(record.sourceId);
  assert.equal(afterReview.analysis.status, 'completed');
  assert.ok(afterReview.decisions.some((d) => d.id === manualId), 'human decisions must survive reanalyze');
});

test('auto-intake ingests unmatched recording outside live history as unanalyzed without scanning, then startAnalysis() triggers offline analysis', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_000_500_000;
  const livePcm = buildSyntheticCombatPcm(30, sampleRate, 77);

  const history = createLiveAudioHistory();
  history.begin(liveStartMs);
  history.pushEnvelope(pcmToInterleavedEnvelope(livePcm, sampleRate), liveStartMs);
  history.pushScoreWindow({
    wallStartMs: liveStartMs + 5_000,
    wallEndMs: liveStartMs + 15_000,
    scores: [0.9, 0.2],
    groupScores: [0.9, 0.1, 0, 0],
  });

  const media = makeFakeMediaBoundary({
    durationByName: { 'earlier-session.mkv': 10 },
  });
  const workspace = createReviewWorkspace();
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
    async onPrepared(record) {
      record.sourceId = workspace.addSource({
        id: `source:${record.file.name}`,
        name: record.file.name,
        size: record.file.size,
        lastModified: record.file.lastModified,
        fingerprint: `${record.file.name}:${record.file.size}`,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    onWaveform(record, wf) {
      if (record.sourceId) workspace.updateWaveform(record.sourceId, wf);
    },
    onCandidates(record, cands) {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, cands);
    },
    onChange(record) {
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });

  const events = [];
  let clock = liveStartMs + 10_000;
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    getLiveHistory: () => history.exportForAlignment(),
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => clock,
    onIntake: (event) => events.push(event),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const files = new Map();
  await service.startWatching(makeFakeDirectory('Apex Captures', files));

  // New file copied into watch directory whose lastModified is 5 minutes BEFORE live monitoring started.
  const unmatchedLastModified = liveStartMs - 300_000;
  files.set('earlier-session.mkv', makeObsMkvFile('earlier-session.mkv', { closed: true, lastModified: unmatchedLastModified }));

  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.UNANALYZED);
  assert.equal(events[0].alignment, null);
  const record = events[0].record;
  assert.equal(record.status, 'unanalyzed');
  assert.equal(workspace.getSource(record.sourceId).analysis.status, 'unanalyzed');
  assert.equal(media.analyzeCalls, 0, 'unmatched recording must wait for manual user trigger');

  // User manually triggers offline analysis via startAnalysis().
  assert.equal(await service.startAnalysis(record.id), true);
  await queue.whenIdle();

  assert.equal(media.analyzeCalls, 1);
  assert.equal(record.status, 'complete');
  assert.equal(workspace.getSource(record.sourceId).analysis.status, 'completed');
  assert.ok(record.candidates.length >= 1);
  assert.equal(await service.startAnalysis(record.id), false);
});

test('auto-intake deduplicates already-ingested/completed files and upgrades already-prepared unanalyzed records in-place on live conform', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_000_900_000;
  const livePcm = buildSyntheticCombatPcm(50, sampleRate, 93);
  const masterDurationSec = 30;
  const masterPcm = livePcm.subarray(5 * sampleRate, (5 + masterDurationSec) * sampleRate);
  const masterLastModified = liveStartMs + (5 + masterDurationSec) * 1000;

  const history = createLiveAudioHistory();
  history.begin(liveStartMs);
  history.pushEnvelope(pcmToInterleavedEnvelope(livePcm, sampleRate), liveStartMs);
  history.pushScoreWindow({
    wallStartMs: liveStartMs + 12_000,
    wallEndMs: liveStartMs + 22_000,
    scores: [0.87, 0.11],
    groupScores: [0.87, 0.1, 0, 0],
  });

  const media = makeFakeMediaBoundary({
    durationByName: { 'pre-imported.mkv': masterDurationSec, 'already-in-library.mkv': 12 },
    pcmByName: { 'pre-imported.mkv': { sampleRate, samples: masterPcm } },
  });
  const workspace = createReviewWorkspace();
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
    async onPrepared(record) {
      const id = `source:${record.file.name}:${record.file.size}:${record.file.lastModified}`;
      record.sourceId = workspace.addSource({
        id,
        name: record.file.name,
        size: record.file.size,
        lastModified: record.file.lastModified,
        fingerprint: id,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    onWaveform(record, wf) {
      if (record.sourceId) workspace.updateWaveform(record.sourceId, wf);
    },
    onCandidates(record, cands) {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, cands);
    },
    onChange(record) {
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });

  const preImportedFile = makeObsMkvFile('pre-imported.mkv', { closed: true, lastModified: masterLastModified });
  const unmatchedExistingFile = makeObsMkvFile('already-in-library.mkv', { closed: true, lastModified: liveStartMs - 500_000 });

  // Manually pre-import both files into queue as unanalyzed before watcher sees them.
  const [preRecord] = await queue.importFiles([preImportedFile], { autoAnalyze: false });
  const [unmatchedRecord] = await queue.importFiles([unmatchedExistingFile], { autoAnalyze: false });
  assert.equal(queue.records.length, 2);
  assert.equal(preRecord.status, 'unanalyzed');
  assert.equal(unmatchedRecord.status, 'unanalyzed');

  const events = [];
  let clock = masterLastModified + 500;
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    getLiveHistory: () => history.exportForAlignment(),
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => clock,
    identify: async (file) => ({
      id: `source:${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    }),
    onIntake: (event) => events.push(event),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const files = new Map();
  await service.startWatching(makeFakeDirectory('Apex Captures', files));

  // Watcher now discovers both files.
  files.set('pre-imported.mkv', preImportedFile);
  files.set('already-in-library.mkv', unmatchedExistingFile);

  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  // No duplicates added to queue!
  assert.equal(queue.records.length, 2);
  // pre-imported.mkv was upgraded IN-PLACE via importPrecomputed(..., preRecord.id).
  assert.equal(preRecord.status, 'complete');
  assert.equal(preRecord.alignment?.confidence, 'exact');
  // already-in-library.mkv stayed unanalyzed and was NOT duplicated or re-emitted.
  assert.equal(unmatchedRecord.status, 'unanalyzed');
  assert.equal(events.length, 1);
  assert.equal(events[0].record, preRecord);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);

  // Restart watching with an empty baseline then re-add the already-completed file -> deduplicated!
  service.stopWatching();
  const files2 = new Map();
  await service.startWatching(makeFakeDirectory('Apex Captures', files2));
  files2.set('pre-imported.mkv', preImportedFile);
  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(queue.records.length, 2);
  assert.equal(events.length, 1, 'already-ingested completed recording must not trigger duplicate conform or event');

  // Dispose stops watching and blocks subsequent actions cleanly.
  service.dispose();
  assert.equal(await service.startAnalysis(unmatchedRecord.id), false);
  assert.equal(await service.reanalyze(preRecord.id), false);
  await assert.rejects(() => service.startWatching(makeFakeDirectory('Apex Captures', new Map())), /销毁/);
});

test('auto-intake consumes live history directly from real createLiveMonitorEngine (#58 -> #60 seam)', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_002_000_000;
  let clock = liveStartMs;
  const livePcm = buildSyntheticCombatPcm(30, sampleRate, 55);
  const envBatch = pcmToInterleavedEnvelope(livePcm, sampleRate);

  const classes = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun', 'Glass shatter'];
  const workletNodes = [];
  const workers = [];
  const audioTrack = {
    kind: 'audio',
    label: 'VB-Cable',
    getSettings: () => ({ deviceId: 'vb-1' }),
    addEventListener() {},
    removeEventListener() {},
    stop() {},
  };
  const fakeStream = {
    getTracks: () => [audioTrack],
    getVideoTracks: () => [],
    getAudioTracks: () => [audioTrack],
    removeTrack() {},
  };
  class FakeAudioContext {
    constructor() {
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      workletNodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  class FakeWorker {
    constructor() {
      this.posted = [];
      this.onmessage = null;
      this.onerror = null;
      workers.push(this);
    }
    postMessage(msg) { this.posted.push(msg); }
    terminate() {}
  }

  const liveMonitor = createLiveMonitorEngine({
    mediaDevices: { getDisplayMedia: async () => fakeStream },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    Worker: FakeWorker,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'EfficientSED',
        classes,
        sampleRate: 16000,
        scoreType: 'frame',
        windowSeconds: 10,
        strideSeconds: 5,
        frameSeconds: 0.04,
        inputName: 'mel',
        input: [1, 1, 128, 1000],
        output: [1, 250, classes.length],
        sha256: 'abc',
        bytes: 1024,
        modelFile: 'fmn10-tf256.onnx',
      }),
    }),
    now: () => clock,
  });

  const masterDurationSec = 20;
  const masterPcm = livePcm.subarray(4 * sampleRate, (4 + masterDurationSec) * sampleRate);
  const media = makeFakeMediaBoundary({
    durationByName: { 'live-seam.mp4': masterDurationSec },
    pcmByName: { 'live-seam.mp4': { sampleRate, samples: masterPcm } },
  });
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
  });

  const events = [];
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    liveMonitor,
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => clock,
    onIntake: (ev) => events.push(ev),
  });
  t.after(async () => {
    service.dispose();
    await liveMonitor.dispose();
    await queue.dispose();
  });

  await liveMonitor.start({ sourceKind: AUDIO_SOURCE_KINDS.SYSTEM });
  const worklet = workletNodes[0];

  // Feed 30s envelope & 1 gunshot inference window into real liveMonitor.
  clock = liveStartMs + 20_000;
  worklet.port.onmessage({ data: { type: 'envelope', buckets: envBatch, silentSeconds: 0 } });
  worklet.port.onmessage({ data: { type: 'window', waveform: new Float32Array(16000 * 10), coveredSeconds: 10 } });
  await new Promise((r) => setTimeout(r, 0));

  const values = new Float32Array(250 * classes.length);
  for (let f = 60; f <= 80; f++) values[f * classes.length + 1] = 0.91;
  workers[0].onmessage({
    data: { id: workers[0].posted[0].id, type: 'result', values, dims: [1, 250, classes.length], timings: { inferenceMs: 12 } },
  });
  await new Promise((r) => setTimeout(r, 0));

  const files = new Map();
  await service.startWatching(makeFakeDirectory('Captures', files));

  const trueMasterStartMs = liveStartMs + 4_000;
  const masterLastModified = trueMasterStartMs + masterDurationSec * 1000 - 950; // +950ms NCC offset
  clock = masterLastModified + 500;
  files.set('live-seam.mp4', new File(
    [mp4Box('ftyp', 16), mp4Box('mdat', 64), mp4Box('moov', 48)],
    'live-seam.mp4',
    { lastModified: masterLastModified },
  ));

  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);
  assert.equal(events[0].record.status, 'complete');
  assert.equal(events[0].alignment.confidence, ALIGNMENT_CONFIDENCE.EXACT);
  assert.ok(Math.abs(events[0].alignment.offsetMs - 950) <= 40);
  assert.ok(events[0].record.candidates.length >= 1);
  assert.equal(media.analyzeCalls, 0);
});

test('reanalyze resets progress and clears coarse alignment immediately while queued, supports sourceId lookup, and clears stale candidates when offline finds none', async (t) => {
  const classes = ['Speech', 'Gunshot, gunfire', 'Machine gun'];
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
  const media = makeFakeMediaBoundary({ durationByName: { 'coarse-zero.mkv': 10 } });
  const workspace = createReviewWorkspace();
  const observed = [];
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: async () => ({ ok: true, status: 200, json: async () => manifest }),
    // Full offline pass detects NO gunshots (all zeros), proving stale coarse false-positive candidates are replaced.
    infer: async () => ({ values: new Float32Array(250 * classes.length), dims: [1, 250, classes.length], timings: { inferenceMs: 3 } }),
    async onPrepared(record) {
      record.sourceId = workspace.addSource({
        id: `source:${record.file.name}`,
        name: record.file.name,
        size: record.file.size,
        lastModified: record.file.lastModified,
        fingerprint: `${record.file.name}:${record.file.size}`,
        fingerprintVersion: 'v1',
        duration: record.duration,
      });
    },
    onWaveform(record, wf) {
      if (record.sourceId) workspace.updateWaveform(record.sourceId, wf);
    },
    onCandidates(record, cands) {
      if (record.sourceId) workspace.publishCandidates(record.sourceId, cands);
    },
    onChange(record) {
      observed.push({ status: record.status, processedUntil: record.processedUntil, alignment: record.alignment });
      if (record.sourceId) {
        workspace.updateAnalysis(record.sourceId, {
          status: record.status === 'complete' ? 'completed' : record.status,
          processedUntil: Math.min(record.duration || 0, Math.max(0, record.processedUntil || 0)),
          error: record.error || null,
        });
      }
    },
  });
  const service = createAutoIntakeService({ MB: media.MB, queue });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const file = makeObsMkvFile('coarse-zero.mkv', { closed: true, lastModified: 20_000 });
  const record = await queue.importPrecomputed(file, {
    windowScores: [{ start: 2, end: 4, scores: [0.92, 0.1] }],
    alignment: { confidence: 'coarse', offsetMs: 0, correlation: 0.12, driftPpm: 0, anchorStartSec: 0 },
  });
  assert.equal(record.candidates.length, 1);
  assert.equal(record.processedUntil, 10);

  // Pause queue before triggering reanalyze by sourceId so we observe the queued state directly.
  queue.pause();
  observed.length = 0;
  assert.equal(await service.reanalyze(record.sourceId), true);
  assert.equal(record.status, 'queued');
  assert.equal(record.processedUntil, 0, 'queued reanalyze must report 0 progress rather than stale 100%');
  assert.equal(record.alignment, null, 'stale coarse alignment must clear immediately when reanalyze is queued');
  assert.equal(workspace.getSource(record.sourceId).analysis.processedUntil, 0);

  queue.resume();
  await queue.whenIdle();

  assert.equal(record.status, 'complete');
  assert.equal(record.alignment, null);
  assert.deepEqual(record.candidates, [], 'offline pass with zero gunshots must clear stale coarse candidates');
  assert.deepEqual(workspace.getSource(record.sourceId).candidates, []);
  assert.equal(workspace.getSource(record.sourceId).analysis.status, 'completed');
});

test('auto-intake aligns audio tracks with nonzero audioOrigin onto video timeline and records masterStartEpochMs', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_003_000_000;
  const livePcm = buildSyntheticCombatPcm(50, sampleRate, 123);

  // Video starts at liveStart + 5.0s (duration 30s), while audio track starts at media timestamp +0.6s
  // (so audio carries live audio from [5.6s, 35.0s]).
  const trueVideoStartSec = 5;
  const audioDelaySec = 0.6;
  const durationSec = 30;
  const audioPcm = livePcm.subarray(
    Math.round((trueVideoStartSec + audioDelaySec) * sampleRate),
    Math.round((trueVideoStartSec + durationSec) * sampleRate),
  );
  const trueVideoStartMs = liveStartMs + trueVideoStartSec * 1000;
  const injectedCoarseErrorMs = -800; // NCC should recover +800ms relative to video t=0
  const masterLastModified = trueVideoStartMs + durationSec * 1000 + injectedCoarseErrorMs;

  const history = createLiveAudioHistory();
  history.begin(liveStartMs);
  history.pushEnvelope(pcmToInterleavedEnvelope(livePcm, sampleRate), liveStartMs);
  history.pushScoreWindow({
    wallStartMs: liveStartMs + 14_000,
    wallEndMs: liveStartMs + 24_000,
    scores: [0.9, 0.1],
    groupScores: [0.9, 0.1, 0, 0],
  });

  class DelayedAudioBufferSink {
    async *buffers(from, to) {
      // Audio track only has samples for media timestamps >= audioDelaySec.
      const clippedFrom = Math.max(audioDelaySec, from);
      const clippedTo = Math.min(durationSec, to);
      if (clippedTo <= clippedFrom) return;
      const startSample = Math.floor((clippedFrom - audioDelaySec) * sampleRate);
      const endSample = Math.min(audioPcm.length, Math.ceil((clippedTo - audioDelaySec) * sampleRate));
      if (endSample <= startSample) return;
      const slice = audioPcm.subarray(startSample, endSample);
      yield {
        timestamp: audioDelaySec + startSample / sampleRate,
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

  const delayedMB = {
    ALL_FORMATS: [],
    BlobSource: class { constructor(file) { this.file = file; } },
    AudioBufferSink: DelayedAudioBufferSink,
    Input: class {
      async getPrimaryVideoTrack() {
        return { displayWidth: 1920, displayHeight: 1080, getFirstTimestamp: async () => 0, computeDuration: async () => durationSec };
      }
      async getAudioTracks() {
        return [{ id: 1, codec: 'aac', canDecode: async () => true, getFirstTimestamp: async () => audioDelaySec, computeDuration: async () => durationSec }];
      }
      async getPrimaryAudioTrack() { return (await this.getAudioTracks())[0]; }
      dispose() {}
    },
  };

  const queue = createBrowserAnalysis({ MB: delayedMB });
  const events = [];
  const service = createAutoIntakeService({
    MB: delayedMB,
    queue,
    getLiveHistory: () => history.exportForAlignment(),
    pollIntervalMs: 60_000,
    stablePollsRequired: 1,
    now: () => masterLastModified + 500,
    onIntake: (ev) => events.push(ev),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  const files = new Map();
  await service.startWatching(makeFakeDirectory('OBS Captures', files));
  files.set('offset-audio.mkv', makeObsMkvFile('offset-audio.mkv', { closed: true, lastModified: masterLastModified }));
  for (let i = 0; i < 3; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);
  assert.ok(
    Math.abs(events[0].alignment.offsetMs - (-injectedCoarseErrorMs)) <= 40,
    `expected video-timeline offsetMs near +800ms (not shifted by 600ms audioOrigin), got ${events[0].alignment.offsetMs}ms`,
  );
  assert.ok(Math.abs(events[0].alignment.masterStartEpochMs - trueVideoStartMs) <= 40);
  assert.equal(events[0].alignment.coarseStartEpochMs, masterLastModified - durationSec * 1000);
  assert.equal(events[0].record.audioOffset, 0);
});

test('auto-intake supports opt-in autoAnalyzeUncovered (ADR 0012): default false leaves uncovered unanalyzed, true auto-queues uncovered while live-covered recordings still conform directly', async (t) => {
  const nowRef = { value: 1_700_005_000_000 };
  const sampleRate = 8000;
  const durationSec = 20;
  const livePcm = buildSyntheticCombatPcm(30, sampleRate, 88);
  const envBatch = pcmToInterleavedEnvelope(livePcm, sampleRate);
  const envPeaks = new Float32Array(envBatch.length / 2);
  const envRms = new Float32Array(envBatch.length / 2);
  for (let i = 0; i < envPeaks.length; i++) {
    envPeaks[i] = envBatch[i * 2];
    envRms[i] = envBatch[i * 2 + 1];
  }
  const liveHistory = {
    startEpochMs: nowRef.value,
    latestEpochMs: nowRef.value + 30_000,
    envStepSeconds: 0.02,
    envPeaks,
    envRms,
    scoreWindows: [{ wallStartMs: nowRef.value + 4_000, wallEndMs: nowRef.value + 14_000, scores: [0.92, 0.1] }],
  };

  const masterPcm = livePcm.subarray(2 * sampleRate, (2 + durationSec) * sampleRate);
  const media = makeFakeMediaBoundary({
    durationByName: { 'uncovered-auto.mp4': durationSec, 'covered-conform.mp4': durationSec },
    pcmByName: { 'covered-conform.mp4': { sampleRate, samples: masterPcm } },
  });
  const queue = createBrowserAnalysis({
    MB: media.MB,
    openAudioStream: media.openAudioStream,
    fetch: media.fetch,
    infer: media.infer,
  });

  const events = [];
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    getLiveHistory: () => liveHistory,
    pollIntervalMs: 60_000,
    stablePollsRequired: 2,
    now: () => nowRef.value,
    onIntake: (ev) => events.push(ev),
  });
  t.after(async () => {
    service.dispose();
    await queue.dispose();
  });

  assert.equal(service.getState().autoAnalyzeUncovered, false, 'autoAnalyzeUncovered must default to false');
  assert.equal(service.setAutoAnalyzeUncovered(true), true);
  assert.equal(service.getState().autoAnalyzeUncovered, true);

  const files = new Map();
  await service.startWatching(makeFakeDirectory('Captures', files));

  // 1. Uncovered recording far outside live history -> auto-queued for offline analysis
  files.set('uncovered-auto.mp4', new File(
    [mp4Box('ftyp', 16), mp4Box('mdat', 64), mp4Box('moov', 32)],
    'uncovered-auto.mp4',
    { lastModified: nowRef.value - 3_600_000 },
  ));
  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.QUEUED_OFFLINE);
  assert.equal(events[0].record.status, 'complete');
  const analyzeAfterUncovered = media.analyzeCalls;
  assert.ok(analyzeAfterUncovered >= 1, 'Enabled autoAnalyzeUncovered must run offline analysis on uncovered recordings');

  // 2. Covered recording inside live history -> still conforms directly without running offline scan!
  const coveredLastMod = nowRef.value + 2_000 + durationSec * 1000;
  nowRef.value = coveredLastMod + 500;
  files.set('covered-conform.mp4', new File(
    [mp4Box('ftyp', 16), mp4Box('mdat', 80), mp4Box('moov', 32)],
    'covered-conform.mp4',
    { lastModified: coveredLastMod },
  ));
  for (let i = 0; i < 4; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 2);
  assert.equal(events[1].kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);
  assert.equal(media.analyzeCalls, analyzeAfterUncovered, 'Live-covered recording must still conform without offline scan');
});

test('auto-intake supports read-only permission request, conforms after liveMonitor.stop(), and suppresses late self-exports during async conform', async (t) => {
  const sampleRate = 8000;
  const liveStartMs = 1_700_004_000_000;
  let clock = liveStartMs;
  const livePcm = buildSyntheticCombatPcm(30, sampleRate, 67);
  const envBatch = pcmToInterleavedEnvelope(livePcm, sampleRate);
  const classes = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun', 'Glass shatter'];

  const workletNodes = [];
  const workers = [];
  const audioTrack = {
    kind: 'audio',
    label: 'Game Audio',
    getSettings: () => ({ deviceId: 'dev-1' }),
    addEventListener() {},
    removeEventListener() {},
    stop() {},
  };
  const fakeStream = {
    getTracks: () => [audioTrack],
    getVideoTracks: () => [],
    getAudioTracks: () => [audioTrack],
    removeTrack() {},
  };
  class FakeAudioContext {
    constructor() { this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  class FakeWorkletNode {
    constructor() { this.port = { onmessage: null, postMessage() {} }; workletNodes.push(this); }
    connect() {}
    disconnect() {}
  }
  class FakeWorker {
    constructor() { this.posted = []; this.onmessage = null; this.onerror = null; workers.push(this); }
    postMessage(msg) { this.posted.push(msg); }
    terminate() {}
  }

  const liveMonitor = createLiveMonitorEngine({
    mediaDevices: { getDisplayMedia: async () => fakeStream },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    Worker: FakeWorker,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'EfficientSED',
        classes,
        sampleRate: 16000,
        scoreType: 'frame',
        windowSeconds: 10,
        strideSeconds: 5,
        frameSeconds: 0.04,
        inputName: 'mel',
        input: [1, 1, 128, 1000],
        output: [1, 250, classes.length],
        sha256: 'abc',
        bytes: 1024,
        modelFile: 'fmn10-tf256.onnx',
      }),
    }),
    now: () => clock,
  });

  await liveMonitor.start({ sourceKind: AUDIO_SOURCE_KINDS.SYSTEM });
  clock = liveStartMs + 20_000;
  workletNodes[0].port.onmessage({ data: { type: 'envelope', buckets: envBatch, silentSeconds: 0 } });
  workletNodes[0].port.onmessage({ data: { type: 'window', waveform: new Float32Array(16000 * 10), coveredSeconds: 10 } });
  await new Promise((r) => setTimeout(r, 0));
  const values = new Float32Array(250 * classes.length);
  for (let f = 50; f <= 70; f++) values[f * classes.length + 1] = 0.88;
  workers[0].onmessage({
    data: { id: workers[0].posted[0].id, type: 'result', values, dims: [1, 250, classes.length], timings: { inferenceMs: 9 } },
  });
  await new Promise((r) => setTimeout(r, 0));

  // Player stops live monitoring BEFORE OBS finishes flushing the recording trailer.
  await liveMonitor.stop();
  assert.equal(liveMonitor.getState().active, false);

  const masterDurationSec = 20;
  const masterPcm = livePcm.subarray(3 * sampleRate, (3 + masterDurationSec) * sampleRate);
  const media = makeFakeMediaBoundary({
    durationByName: { 'post-stop.mkv': masterDurationSec, 'late-export.mp4': 10 },
    pcmByName: { 'post-stop.mkv': { sampleRate, samples: masterPcm } },
  });
  const queue = createBrowserAnalysis({ MB: media.MB });

  // Build a directory whose permission starts as 'prompt' and becomes 'granted' ONLY on read request.
  const files = new Map();
  const permissionQueries = [];
  const permissionRequests = [];
  let permState = 'prompt';
  const promptDir = {
    name: 'Restored Captures',
    async queryPermission(opts) { permissionQueries.push(opts); return permState; },
    async requestPermission(opts) {
      permissionRequests.push(opts);
      assert.deepEqual(opts, { mode: 'read' }, 'must never request readwrite permission on watch directory');
      permState = 'granted';
      return permState;
    },
    async *entries() {
      for (const [fileName, file] of files.entries()) {
        yield [fileName, { kind: 'file', async getFile() { return file; } }];
      }
    },
  };

  const gate = Promise.withResolvers();
  const reachedLateExport = Promise.withResolvers();
  const events = [];
  const service = createAutoIntakeService({
    MB: media.MB,
    queue,
    liveMonitor,
    pollIntervalMs: 60_000,
    stablePollsRequired: 1,
    now: () => clock,
    async beforeImport(file) {
      if (file.name === 'late-export.mp4') {
        reachedLateExport.resolve();
        await gate.promise;
      }
    },
    onIntake: (ev) => events.push(ev),
  });
  t.after(async () => {
    service.dispose();
    await liveMonitor.dispose();
    await queue.dispose();
  });

  // Without requestPermission, prompt directory rejects cleanly.
  await assert.rejects(() => service.startWatching(promptDir), /只读权限/);
  assert.equal(permissionRequests.length, 0);

  // With requestPermission: true, requests { mode: 'read' } and starts watching.
  const started = await service.startWatching(promptDir, { requestPermission: true });
  assert.equal(started.watching, true);
  assert.deepEqual(permissionRequests, [{ mode: 'read' }]);

  // Recording finalized AFTER liveMonitor.stop() still auto-conforms using retained rolling history.
  const masterLastModified = liveStartMs + (3 + masterDurationSec) * 1000;
  clock = masterLastModified + 500;
  files.set('post-stop.mkv', makeObsMkvFile('post-stop.mkv', { closed: true, lastModified: masterLastModified }));
  for (let i = 0; i < 3; i++) await service.pollNow();
  await queue.whenIdle();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, INTAKE_EVENT_KINDS.CONFORMED_EXACT);
  assert.equal(events[0].name, 'post-stop.mkv');

  // Late self-export registration while handleReady is mid-flight suppresses ingestion completely.
  files.set('late-export.mp4', new File(
    [mp4Box('ftyp', 16), mp4Box('mdat', 64), mp4Box('moov', 48)],
    'late-export.mp4',
    { lastModified: liveStartMs - 600_000 },
  ));
  await service.pollNow(); // discovered
  const polling = service.pollNow(); // stabilizing -> probing -> onReady -> blocks in beforeImport
  await reachedLateExport.promise;
  service.registerExportedFilename('late-export.mp4');
  gate.resolve();
  await polling;
  await queue.whenIdle();

  assert.equal(events.length, 1, 'late-registered self-export must not emit intake event');
  assert.equal(queue.records.length, 1, 'late-registered self-export must not be added to queue');
});

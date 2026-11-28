import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFromScores, chooseAudioTracks, createBrowserAnalysis, modelManifestUrl } from '../../../site/browser-analysis.mjs';
import { projectRecordingLibrary } from '../../../site/recording-library-projection.mjs';
import { createRecordingLibraryView } from '../../../site/recording-library-view.mjs';
import { translations } from '../../../site/i18n.js';
import { groupScoreColumns } from '../../../site/waveform-layers.mjs';
import { DEFAULT_MODEL, createModelRegistry, resolveModelAssets, validateModelManifest, validateInferenceOutput } from '../../../site/model-registry.mjs';

test('nearby padded gunfire ranges become one candidate and the final tail waits for EOF', () => {
  const record = { duration: 60, windowScores: [
    { start: 10, end: 20, scores: [0.8, 0] },
    { start: 25, end: 35, scores: [0.7, 0] },
    { start: 42, end: 47, scores: [0.9, 0] },
  ] };
  assert.deepEqual(candidatesFromScores(record, 0.2, 40).map(({ start, end, provisional }) => ({ start, end, provisional })), [
    { start: 5, end: 52, provisional: true },
  ]);
  assert.deepEqual(candidatesFromScores(record, 0.2, Infinity).map(({ start, end, provisional }) => ({ start, end, provisional })), [
    { start: 5, end: 52, provisional: false },
  ]);
});

test('touching ranges and five-second pauses merge transitively; a longer pause separates fights', () => {
  const record = { duration: 120, windowScores: [
    { start: 10, end: 20, scores: [0.8, 0] },
    { start: 30, end: 40, scores: [0.8, 0] },
    { start: 55, end: 65, scores: [0.8, 0] },
    { start: 81, end: 91, scores: [0.8, 0] },
  ] };
  assert.deepEqual(candidatesFromScores(record, 0.2, Infinity).map(({ start, end }) => [start, end]), [[5, 70], [76, 96]]);
});

test('a progressive candidate stays provisional until a following merge is impossible', () => {
  const record = { duration: 120, windowScores: [{ start: 10, end: 20, scores: [0.8, 0] }] };
  assert.equal(candidatesFromScores(record, 0.2, 35)[0].provisional, true);
  assert.equal(candidatesFromScores(record, 0.2, 36)[0].provisional, false);
});

test('automatic analysis uses the source primary track and preserves its output identity', async () => {
  const tracks = [{ id: 1, canDecode: async () => true }, { id: 2, canDecode: async () => true }];
  const choice = await chooseAudioTracks({ getPrimaryAudioTrack: async () => tracks[1] }, tracks);
  assert.equal(choice.selected, 1);
  assert.equal(choice.outputAudioTrackIndex, 1);
});

test('a decoder capability failure can use another track without changing source output sound', async () => {
  const tracks = [{ id: 1, codec: 'aac', canDecode: async () => { throw new Error('codec probe failed'); } }, { id: 2, codec: 'opus', canDecode: async () => true }];
  const choice = await chooseAudioTracks({ getPrimaryAudioTrack: async () => tracks[0] }, tracks);
  assert.equal(choice.selected, 1);
  assert.equal(choice.outputAudioTrackIndex, 0);
  assert.equal(choice.audioPolicy.fallback, true);
});

test('only efficientsed is built in and reads the manifest from its asset path', () => {
  assert.equal(DEFAULT_MODEL, 'efficientsed');
  assert.equal(modelManifestUrl('efficientsed'), '/assets/efficientsed/model.json');
  assert.throws(() => modelManifestUrl('efficientat'), /未知分析模型/);
  assert.throws(() => modelManifestUrl('beats'), /未知分析模型/);
  assert.throws(() => modelManifestUrl('other'), /未知分析模型/);
});

test('model registry resolves model weights and preprocessing assets and supports extension', () => {
  const registry = createModelRegistry();
  assert.deepEqual(registry.list(), ['efficientsed']);

  const sedAssets = resolveModelAssets(registry.get('efficientsed'), { modelFile: 'fmn10-tf256.onnx' }, 'http://127.0.0.1:8792/inference-worker.js');
  assert.equal(sedAssets.manifestUrl, 'http://127.0.0.1:8792/assets/efficientsed/model.json');
  assert.equal(sedAssets.onnxUrl, 'http://127.0.0.1:8792/assets/efficientsed/fmn10-tf256.onnx');
  assert.equal(sedAssets.frontendUrl, 'http://127.0.0.1:8792/assets/efficientsed/frontend.json');

  assert.throws(() => resolveModelAssets(registry.get('efficientsed'), { modelFile: '../escape.onnx' }, 'http://127.0.0.1:8792/inference-worker.js'), /模型文件路径无效/);

  registry.register('custom-sed', {
    manifestUrl: '/assets/custom/model.json',
    onnxUrl: '/assets/custom/model.onnx',
    frontendUrl: '/assets/custom/frontend.json',
    frontendType: 'efficientsed',
    sampleRate: 16000,
    scoreType: 'frame',
    inputName: 'mel',
    inputShape: [1, 1, 128, 1000],
  });
  assert.equal(modelManifestUrl('custom-sed', registry), '/assets/custom/model.json');
  assert.throws(() => registry.register('bad', { manifestUrl: '/x.json', scoreType: 'invalid' }), /模型注册配置无效/);
  assert.throws(() => registry.register('bad-window', { manifestUrl: '/x.json', onnxUrl: '/x.onnx', sampleRate: 32000, scoreType: 'window', inputName: 'mel', inputShape: [1, 1, 128, 1000] }), /模型注册配置无效/);
});

test('manifest validation verifies dimensions, classes order, and gunshot labels for EfficientSED', () => {
  const registry = createModelRegistry();
  const sedSpec = registry.get('efficientsed');

  const classes = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun'];
  const sedMeta = validateModelManifest(sedSpec, {
    model: 'EfficientSED',
    classes,
    sampleRate: 16000,
    scoreType: 'frame',
    frameSeconds: 0.04,
    inputName: 'mel',
    input: [1, 1, 128, 1000],
    output: [1, 250, 4],
  });
  assert.deepEqual(sedMeta.gunshotIndices, [1, 3]);

  // Mismatched output shape / transposed axes / class mismatch / duplicates / missing gunshot
  assert.throws(() => validateModelManifest(sedSpec, { classes, sampleRate: 16000, scoreType: 'frame', output: [1, 4, 250] }), /输出维度/);
  assert.throws(() => validateModelManifest(sedSpec, { classes, sampleRate: 16000, scoreType: 'frame', output: [1, 250, 5] }), /输出维度/);
  assert.throws(() => validateModelManifest(sedSpec, { classes, sampleRate: 32000, scoreType: 'frame', output: [1, 250, 4] }), /采样率/);
  assert.throws(() => validateModelManifest(sedSpec, { classes, sampleRate: 16000, scoreType: 'window', output: [1, 250, 4] }), /分数类型/);
  assert.throws(() => validateModelManifest(sedSpec, { classes: ['Speech', 'Speech', 'Gunshot, gunfire', 'Machine gun'], sampleRate: 16000, output: [1, 250, 4] }), /类别/);
  assert.throws(() => validateModelManifest(sedSpec, { classes: ['Speech', 'Gunshot, gunfire'], sampleRate: 16000, output: [1, 250, 2] }), /枪声类别/);

  // Inference output shape and value range checks
  const validSedValues = new Float32Array(250 * 4).fill(0.25);
  assert.doesNotThrow(() => validateInferenceOutput(sedSpec, { classes }, { values: validSedValues, dims: [1, 250, 4] }));
  assert.throws(() => validateInferenceOutput(sedSpec, { classes }, { values: validSedValues, dims: [1, 4, 250] }), /模型输出/);
  assert.throws(() => validateInferenceOutput(sedSpec, { classes }, { values: new Float32Array(250 * 3), dims: [1, 250, 3] }), /模型输出/);
  const badProb = validSedValues.slice();
  badProb[10] = 1.2;
  assert.throws(() => validateInferenceOutput(sedSpec, { classes }, { values: badProb, dims: [1, 250, 4] }), /模型输出/);
});

function createFakeMediaBoundary({ duration = 12, audioDuration = duration, videoOrigin = 0, audioOrigin = 0 } = {}) {
  const track = {
    id: 1,
    codec: 'opus',
    canDecode: async () => true,
    getFirstTimestamp: async () => audioOrigin,
    computeDuration: async () => audioOrigin + audioDuration,
  };
  const video = {
    getFirstTimestamp: async () => videoOrigin,
    computeDuration: async () => videoOrigin + duration,
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
  const openAudioStream = (_mb, _track, _origin, audioLen, sampleRate, check, metrics, onDecoded) => {
    metrics.decoderPasses = 1;
    let index = 0;
    const total = Math.ceil(Math.max(0, audioLen - 10) / 5) + 1;
    return {
      async next() {
        check();
        const peakBlock = {
          timestamp: audioOrigin + index * 5,
          buffer: {
            duration: Math.min(5, Math.max(0, audioLen - index * 5)),
            numberOfChannels: 1,
            getChannelData: () => new Float32Array([0.5]),
          },
        };
        onDecoded(peakBlock);
        index++;
        return new Float32Array(sampleRate * 10);
      },
      async close() {},
      get calls() { return index; },
      get expectedWindows() { return total; },
    };
  };
  return { MB, openAudioStream };
}

test('createBrowserAnalysis averages overlapping 40ms frames, clips last frame duration, avoids O(N^2) reallocation, and keeps single pass', async () => {
  const classes = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun'];
  const sedManifest = {
    model: 'EfficientSED',
    modelFile: 'fmn10-tf256.onnx',
    classes,
    sampleRate: 16000,
    windowSeconds: 10,
    strideSeconds: 5,
    frameSeconds: 0.04,
    scoreType: 'frame',
    output: [1, 250, 4],
  };
  const { MB, openAudioStream } = createFakeMediaBoundary({ duration: 20, audioDuration: 10.02 });
  const scoreBuffers = [];
  let windowIndex = 0;
  const queue = createBrowserAnalysis({
    MB,
    openAudioStream,
    fetch: async (url) => ({
      ok: url === '/assets/efficientsed/model.json',
      status: url === '/assets/efficientsed/model.json' ? 200 : 404,
      json: async () => sedManifest,
    }),
    infer: async () => {
      const values = new Float32Array(250 * 4);
      if (windowIndex === 0) {
        // Frame 130 (in overlap [125..249]) is 0.9 in window 0, 0.1 in window 1 -> avg 0.5
        values[130 * 4 + 1] = 0.9;
        // Frame 140 (in overlap [125..249]) is 0.4 in window 0, 0.2 in window 1 -> avg 0.3
        values[140 * 4 + 3] = 0.4;
      } else {
        values[(130 - 125) * 4 + 1] = 0.1;
        values[(140 - 125) * 4 + 3] = 0.2;
        // Frame 250 (tail, only 0.02s remaining audio) hits on window 1 offset 125
        for (let f = 123; f <= 125; f++) values[f * 4 + 1] = 0.8;
      }
      windowIndex++;
      return { values, dims: [1, 250, 4], timings: { frontendMs: 1, inferenceMs: 2 } };
    },
    onCandidates(record) {
      if (record.scores) scoreBuffers.push(record.scores.buffer);
    },
  });

  await queue.importFiles([{ name: 'match.mkv', size: 1024, lastModified: 1 }]);
  await queue.whenIdle();
  const record = queue.records[0];
  assert.equal(record.status, 'complete', record.error);
  assert.equal(record.model, 'efficientsed');
  assert.equal(record.timings.decoderPasses, 1);
  assert.equal(record.scoreFrames, 251);
  // Preallocated buffer was never reallocated across windows.
  assert.ok(scoreBuffers.length >= 2);
  assert.ok(scoreBuffers.every((buf) => buf === scoreBuffers[0]));

  // Overlapping frames averaged at 40ms resolution BEFORE thresholding:
  // Frame 130 avg is 0.5, frame 140 avg is 0.3.
  assert.ok(Math.abs(record.scores[130 * 2] - 0.5) < 1e-6);
  assert.ok(Math.abs(record.scores[140 * 2 + 1] - 0.3) < 1e-6);

  // Tail event ending at frame 250 clips to actual audioDuration 10.02 (not 251*0.04 = 10.04).
  // With threshold 0.35: frame 130 isolated (smoothed out by 3-frame median!), tail [9.92, 10.02] padded +-5s -> [4.92, 15.02].
  queue.recompute(record.id, 0.35);
  assert.deepEqual(record.candidates.map(({ start, end }) => [+start.toFixed(4), +end.toFixed(4)]), [[4.92, 15.02]]);
});

test('createBrowserAnalysis rejects 0.28s exact multiple without spurious 8th frame and reports actionable 404 hint', async () => {
  const { MB, openAudioStream } = createFakeMediaBoundary({ duration: 0.28 });
  const queue = createBrowserAnalysis({
    MB,
    openAudioStream,
    fetch: async () => ({ ok: false, status: 404 }),
    infer: async () => ({ values: new Float32Array(0), timings: {} }),
  });
  await queue.importFiles([{ name: 'short.mp4', size: 1, lastModified: 1 }]);
  await queue.whenIdle();
  assert.equal(queue.records[0].status, 'failed');
  assert.match(queue.records[0].error, /HTTP 404/);
  assert.match(queue.records[0].error, /--assets/);

  // Exact 0.28s audioDuration should have 7 frames (not 8) when candidatesFromScores evaluates.
  const exactScores = new Float32Array(7 * 2);
  exactScores[6 * 2] = 0.9;
  exactScores[5 * 2] = 0.9;
  const exact = candidatesFromScores({ duration: 10, audioDuration: 0.28, audioOffset: 0, scores: exactScores }, 0.5, Infinity);
  assert.deepEqual(exact.map(({ start, end }) => [+start.toFixed(4), +end.toFixed(4)]), [[0, 5.28]]);
});

test('createBrowserAnalysis reduces overlap-averaged frames into 4 session group scores without O(N^2) churn and isolates recompute', async () => {
  const classes = ['Speech', 'Whispering', 'Gunshot, gunfire', 'Machine gun', 'Music', 'Walk, footsteps', 'Breaking'];
  const manifests = {
    '/assets/efficientsed/model.json': { model: 'EfficientSED', modelFile: 'fmn10-tf256.onnx', classes, sampleRate: 16000, scoreType: 'frame', frameSeconds: 0.04, output: [1, 250, classes.length] },
  };
  const { MB, openAudioStream } = createFakeMediaBoundary({ duration: 20, audioDuration: 10.04, videoOrigin: 10, audioOrigin: 8.5 });
  const groupBuffers = [];
  const progressFrames = [];
  const waveformResets = [];
  let sedWindow = 0;
  const queue = createBrowserAnalysis({
    MB,
    openAudioStream,
    fetch: async (url) => ({ ok: Boolean(manifests[url]), status: manifests[url] ? 200 : 404, json: async () => manifests[url] }),
    infer: async () => {
      const values = new Float32Array(250 * classes.length);
      if (sedWindow === 0) {
        // Overlap frame 130: Speech=0.8, Whispering=0.2 in window 0; window 1 swaps them -> avg per class is 0.5 each -> group max = 0.5 (not 0.8).
        values[130 * classes.length + 0] = 0.8;
        values[130 * classes.length + 1] = 0.2;
        values[140 * classes.length + 4] = 0.75; // Music
        values[140 * classes.length + 5] = 0.65; // Walk, footsteps (now background)
        values[140 * classes.length + 6] = 0.55; // Breaking
      } else {
        values[(130 - 125) * classes.length + 0] = 0.2;
        values[(130 - 125) * classes.length + 1] = 0.8;
        values[(140 - 125) * classes.length + 4] = 0.25; // avg 0.50
        values[(140 - 125) * classes.length + 5] = 0.35; // avg 0.50
        values[(140 - 125) * classes.length + 6] = 0.25; // avg 0.40
        for (let f = 5; f <= 8; f++) values[f * classes.length + 2] = 0.9; // Gunshot frames [130..133] in window 1 only
      }
      sedWindow++;
      return { values, dims: [1, 250, classes.length], timings: {} };
    },
    onWaveform(record) {
      waveformResets.push({ name: record.file.name, scoreTimeline: record.scoreTimeline });
    },
    onCandidates(record) {
      if (record.scoreTimeline) {
        groupBuffers.push(record.scoreTimeline.groupScores.buffer);
        progressFrames.push(record.scoreTimeline.groupScoreFrames);
      }
    },
  });

  await queue.importFiles([{ name: 'sed.mkv', size: 100, lastModified: 1 }]);
  await queue.whenIdle();

  const [sedRecord] = queue.records;
  assert.equal(sedRecord.status, 'complete', sedRecord.error);
  assert.equal(sedRecord.audioOffset, -1.5);
  assert.equal('groupScores' in sedRecord, false);
  assert.equal('groupScoreFrames' in sedRecord, false);
  assert.equal('groupScorePyramid' in sedRecord, false);
  assert.equal('groupCount' in sedRecord, false);
  assert.ok(sedRecord.scoreTimeline);
  assert.equal(sedRecord.scoreTimeline.groupCount, 4);
  assert.equal(sedRecord.scoreTimeline.groupScoreFrames, 251);
  assert.equal(sedRecord.scoreTimeline.frameSeconds, 0.04);
  assert.equal(sedRecord.scoreTimeline.audioOffset, -1.5);
  assert.equal(sedRecord.scoreTimeline.audioDuration, 10.04);
  assert.ok(sedRecord.scoreTimeline.groupScores instanceof Float32Array);
  assert.equal(sedRecord.scoreTimeline.groupScores.length, 251 * 4);
  assert.ok(groupBuffers.length >= 2);
  assert.ok(groupBuffers.every((buf) => buf === groupBuffers[0]));
  assert.deepEqual(progressFrames.slice(0, 2), [125, 251]);

  // Frame 130: Speech group max after overlap average is 0.5 (not avg(max)=0.8), Gunshot is 0.45.
  assert.ok(Math.abs(sedRecord.scoreTimeline.groupScores[130 * 4 + 0] - 0.45) < 1e-6);
  assert.ok(Math.abs(sedRecord.scoreTimeline.groupScores[130 * 4 + 1] - 0.50) < 1e-6);
  // Frame 140: Music=0.50, Impact=0.40 (Footsteps excluded from display groups as background)
  assert.ok(Math.abs(sedRecord.scoreTimeline.groupScores[140 * 4 + 2] - 0.50) < 1e-6);
  assert.ok(Math.abs(sedRecord.scoreTimeline.groupScores[140 * 4 + 3] - 0.40) < 1e-6);

  // Recomputing gunshot candidates does not mutate scoreTimeline.groupScores and ignores non-gunshot groups.
  const groupSnapshot = sedRecord.scoreTimeline.groupScores.slice();
  const recomputed = queue.recompute(sedRecord.id, 0.8);
  assert.equal(recomputed.length, 0);
  assert.deepEqual(sedRecord.scoreTimeline.groupScores, groupSnapshot);

  // Retry resets scoreTimeline before re-populating.
  sedWindow = 0;
  waveformResets.length = 0;
  await queue.retry(sedRecord.id);
  await queue.whenIdle();
  assert.equal(waveformResets[0].scoreTimeline, null);
  assert.equal(sedRecord.scoreTimeline.groupScoreFrames, 251);
});

test('createBrowserAnalysis incrementally updates session groupScorePyramid per batch and resets cleanly on retry', async () => {
  const classes = ['Speech', 'Gunshot, gunfire', 'Machine gun', 'Music', 'Walk, footsteps', 'Breaking'];
  const manifests = {
    '/assets/efficientsed/model.json': { model: 'EfficientSED', modelFile: 'fmn10-tf256.onnx', classes, sampleRate: 16000, scoreType: 'frame', frameSeconds: 0.04, output: [1, 250, classes.length] },
  };
  const { MB, openAudioStream } = createFakeMediaBoundary({ duration: 25, audioDuration: 20, videoOrigin: 0, audioOrigin: 2 });
  const snapshots = [];
  const resetPyramids = [];
  let windowIdx = 0;

  const queue = createBrowserAnalysis({
    MB,
    openAudioStream,
    fetch: async (url) => ({ ok: Boolean(manifests[url]), status: manifests[url] ? 200 : 404, json: async () => manifests[url] }),
    infer: async () => {
      const values = new Float32Array(250 * classes.length);
      if (windowIdx === 0) {
        // 0.16s burst in frames 20..23 (audio 0.80..0.96s -> video 2.80..2.96s with audioOffset +2)
        for (let f = 20; f < 24; f++) values[f * classes.length + 1] = 0.86;
        // First half of overlap for burst at global frames 200..203 (audio 8.00..8.16s -> video 10.00..10.16s)
        for (let f = 200; f < 204; f++) values[f * classes.length + 1] = 0.92;
      } else if (windowIdx === 1) {
        // Second half of overlap for global frames 200..203
        for (let f = 75; f < 79; f++) values[f * classes.length + 1] = 0.92;
      }
      windowIdx++;
      return { values, dims: [1, 250, classes.length], timings: {} };
    },
    onWaveform(record) {
      resetPyramids.push(record.scoreTimeline?.groupScorePyramid ?? null);
    },
    onCandidates(record) {
      const pyramid = record.scoreTimeline?.groupScorePyramid;
      if (pyramid) {
        snapshots.push({
          analyzedFrames: pyramid.analyzedFrames,
          levelBuffer: pyramid.levels[0]?.scores.buffer,
          cols: groupScoreColumns(record.scoreTimeline, 0, 25, 25),
        });
      }
    },
  });

  await queue.importFiles([{ name: 'long-sed.mkv', size: 100, lastModified: 1 }]);
  await queue.whenIdle();

  const [sedRecord] = queue.records;
  assert.equal(sedRecord.status, 'complete', sedRecord.error);
  assert.ok(sedRecord.scoreTimeline?.groupScorePyramid);
  assert.equal(sedRecord.scoreTimeline.groupScorePyramid.analyzedFrames, 500);
  assert.ok(snapshots.length >= 3);
  assert.deepEqual(snapshots.slice(0, 3).map((s) => s.analyzedFrames), [125, 250, 500]);
  assert.ok(snapshots.every((s) => s.levelBuffer === snapshots[0].levelBuffer));

  // Snapshot 0 (after 5s audio = 125 frames, video [2..7)) sees first burst at video 2s, tail at 10s still null
  assert.ok(Math.abs(snapshots[0].cols[2][0] - 0.86) < 1e-6);
  assert.equal(snapshots[0].cols[10], null);

  // Snapshot 1 (after 10s audio = 250 frames, video [2..12)) preserves both bursts without overwriting
  assert.ok(Math.abs(snapshots[1].cols[2][0] - 0.86) < 1e-6);
  assert.ok(Math.abs(snapshots[1].cols[10][0] - 0.92) < 1e-6);
  assert.equal(snapshots[1].cols[15], null);

  // Retry resets groupScorePyramid before re-populating
  windowIdx = 0;
  resetPyramids.length = 0;
  await queue.retry(sedRecord.id);
  await queue.whenIdle();
  assert.equal(resetPyramids[0], null);
  assert.equal(sedRecord.scoreTimeline.groupScorePyramid.analyzedFrames, 500);
});

test('createBrowserAnalysis serializes custom registered model spec across Worker boundary', async () => {
  const registry = createModelRegistry();
  registry.register('custom-sed-v2', {
    manifestUrl: '/assets/custom/model.json',
    onnxUrl: '/assets/custom/custom-sed.onnx',
    frontendUrl: '/assets/custom/frontend.json',
    frontendType: 'efficientsed',
    sampleRate: 16000,
    windowSeconds: 10,
    strideSeconds: 5,
    frameSeconds: 0.04,
    framesPerWindow: 250,
    hopFrames: 125,
    scoreType: 'frame',
    inputName: 'mel',
    inputShape: [1, 1, 128, 1000],
    outputName: 'probabilities',
    outputShape: [1, 250, 3],
  });
  const classes = ['Speech', 'Gunshot, gunfire', 'Machine gun'];
  const customManifest = {
    model: 'CustomSED',
    modelFile: 'custom-sed.onnx',
    sha256: 'abc123',
    bytes: 1024,
    classes,
    sampleRate: 16000,
    scoreType: 'frame',
    frameSeconds: 0.04,
    inputName: 'mel',
    input: [1, 1, 128, 1000],
    output: [1, 250, 3],
  };

  const posted = [];
  let terminated = 0;
  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(msg, transfer) {
      const cloned = structuredClone(msg);
      posted.push({ msg: cloned, transferCount: transfer?.length ?? 0 });
      queueMicrotask(() => {
        const values = new Float32Array(250 * classes.length);
        values[20 * 3 + 1] = 0.85;
        values[21 * 3 + 1] = 0.85;
        this.onmessage?.({
          data: { id: msg.id, type: 'result', values, dims: [1, 250, 3], timings: { frontendMs: 1, inferenceMs: 2 } },
        });
      });
    }
    terminate() {
      terminated++;
    }
  }

  const { MB, openAudioStream } = createFakeMediaBoundary({ duration: 10, audioDuration: 10 });
  const queue = createBrowserAnalysis({
    MB,
    models: registry,
    Worker: FakeWorker,
    openAudioStream,
    fetch: async (url) => ({
      ok: url === '/assets/custom/model.json',
      status: url === '/assets/custom/model.json' ? 200 : 404,
      json: async () => customManifest,
    }),
  });

  await queue.importFiles([{ name: 'custom.mp4', size: 512, lastModified: 1 }], { model: 'custom-sed-v2' });
  await queue.whenIdle();

  const record = queue.records[0];
  assert.equal(record.status, 'complete', record.error);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.model, 'custom-sed-v2');
  assert.equal(posted[0].transferCount, 1);
  assert.deepEqual(posted[0].msg.spec, {
    id: 'custom-sed-v2',
    manifestUrl: '/assets/custom/model.json',
    onnxUrl: '/assets/custom/custom-sed.onnx',
    frontendUrl: '/assets/custom/frontend.json',
    frontendType: 'efficientsed',
    sampleRate: 16000,
    windowSeconds: 10,
    strideSeconds: 5,
    frameSeconds: 0.04,
    framesPerWindow: 250,
    hopFrames: 125,
    scoreType: 'frame',
    inputName: 'mel',
    inputShape: [1, 1, 128, 1000],
    outputName: 'probabilities',
    outputShape: [1, 250, 3],
    gunshotClasses: ['Gunshot, gunfire', 'Machine gun'],
  });
  assert.equal(record.candidates.length, 1);
  assert.equal(terminated, 0);
});

test('createBrowserAnalysis drives monotonic status badges without audio/percentage oscillation across multi-window batch imports', async () => {
  const classes = ['Speech', 'Gunshot, gunfire', 'Music', 'Machine gun'];
  const manifest = {
    model: 'EfficientSED',
    modelFile: 'fmn10-tf256.onnx',
    sha256: 'abc123',
    bytes: 1024,
    classes,
    sampleRate: 16000,
    windowSeconds: 10,
    strideSeconds: 5,
    frameSeconds: 0.04,
    scoreType: 'frame',
    output: [1, 250, classes.length],
  };

  let loaded = false;
  class StatusWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(msg) {
      queueMicrotask(() => {
        if (!loaded) {
          this.onmessage?.({ data: { type: 'status', message: '正在连接模型文件…' } });
          this.onmessage?.({ data: { type: 'status', phase: 'model', progress: 0.5, message: '正在下载模型' } });
          this.onmessage?.({ data: { type: 'status', phase: 'model', progress: null, message: '正在初始化 WASM…' } });
          loaded = true;
        }
        this.onmessage?.({ data: { type: 'status', phase: 'inference', progress: null, message: '正在计算窗口…' } });
        const values = new Float32Array(250 * classes.length);
        this.onmessage?.({ data: { id: msg.id, type: 'result', values, dims: [1, 250, classes.length], timings: { inferenceMs: 2 } } });
      });
    }
    terminate() {}
  }

  function makeFakeDom() {
    const makeEl = (tag) => {
      const el = {
        tagName: tag.toUpperCase(), className: '', textContent: '', title: '', hidden: false, disabled: false,
        dataset: {}, attributes: {}, children: [], parentNode: null,
        classList: { toggle() {} },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        removeAttribute(k) { delete this.attributes[k]; },
        append(...nodes) { for (const n of nodes) { if (!n) continue; if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); } },
        replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...nodes); },
        remove() { if (!this.parentNode) return; const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; },
      };
      el.ownerDocument = doc;
      return el;
    };
    const doc = { createElement: makeEl };
    return doc;
  }

  const doc = makeFakeDom();
  const listContainer = doc.createElement('div');
  const translate = (key, params = {}) => {
    let text = translations.zh[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };
  const view = createRecordingLibraryView({ listContainer, doc, showActions: false, showSize: false, translate });

  const historyByFile = new Map();
  const recordSnapshot = () => {
    view.render(projectRecordingLibrary({ records: queue.records }));
    for (const row of listContainer.children) {
      const name = row._refs?.filename?.textContent;
      const badge = row._refs?.statusBadge;
      if (!name || !badge) continue;
      const entry = { status: badge.dataset.status, phase: badge.dataset.phase, label: badge.textContent };
      const list = historyByFile.get(name) || [];
      const prev = list.at(-1);
      if (!prev || prev.status !== entry.status || prev.phase !== entry.phase || prev.label !== entry.label) {
        list.push(entry);
        historyByFile.set(name, list);
      }
    }
  };

  const { MB, openAudioStream } = createFakeMediaBoundary({ duration: 30, audioDuration: 30 });
  const queue = createBrowserAnalysis({
    MB,
    Worker: StatusWorker,
    openAudioStream,
    fetch: async () => ({ ok: true, status: 200, json: async () => manifest }),
    onChange: recordSnapshot,
  });

  await queue.importFiles([
    { name: 'cold-first.mp4', size: 1000, lastModified: 2000 },
    { name: 'warm-second.mp4', size: 1000, lastModified: 1000 },
  ]);
  await queue.whenIdle();

  const phaseOrder = ['preparing', 'video', 'audioTracks', 'queued', 'audio', 'model', 'inference', 'complete'];
  for (const name of ['cold-first.mp4', 'warm-second.mp4']) {
    const entries = historyByFile.get(name) || [];
    assert.ok(entries.length > 0, name);
    let maxRank = -1;
    let maxPercent = -1;
    for (const entry of entries) {
      const rank = phaseOrder.indexOf(entry.phase);
      assert.ok(rank >= 0, `${name}: unexpected phase ${JSON.stringify(entry)}`);
      assert.ok(rank >= maxRank, `${name}: phase regressed in ${JSON.stringify(entries)}`);
      maxRank = rank;
      const percentMatch = entry.label.match(/(\d+)%/);
      if (maxPercent >= 0 && entry.status === 'analyzing') {
        assert.ok(percentMatch, `${name}: label bounced away from percentage in ${JSON.stringify(entries)}`);
      }
      if (percentMatch) {
        const pct = Number(percentMatch[1]);
        assert.ok(pct >= maxPercent, `${name}: percentage regressed in ${JSON.stringify(entries)}`);
        maxPercent = pct;
      }
    }
    assert.equal(entries.at(-1).phase, 'complete', name);
    assert.ok(entries.some((e) => e.phase === 'audio'), `${name}: should show initial audio loading`);
    assert.ok(entries.some((e) => e.phase === 'inference' && /\d+%/.test(e.label)), `${name}: should show percentage`);
  }
  assert.ok(historyByFile.get('cold-first.mp4').some((e) => e.phase === 'model'), 'cold start should show model preparation');
  assert.equal(historyByFile.get('warm-second.mp4').some((e) => e.phase === 'model'), false, 'warm start should not flash model preparation');
});

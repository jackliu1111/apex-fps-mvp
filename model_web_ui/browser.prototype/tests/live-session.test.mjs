import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession } from '../../../site/live-session.mjs';
import { createAnalysisQueue } from '../../../site/analysis-queue.mjs';
import { createBrowserAnalysis } from '../../../site/browser-analysis.mjs';
import { mapLiveHistoryToMaster } from '../../../site/audio-aligner.mjs';
import { layeredWaveColumns, overviewDistributionColumns, groupScoresAtTime } from '../../../site/waveform-layers.mjs';

function mockMediaBunny(duration = 40) {
  const videoTrack = {
    displayWidth: 1920,
    displayHeight: 1080,
    getFirstTimestamp: async () => 0,
    computeDuration: async () => duration,
  };
  const audioTrack = {
    id: 1,
    codec: 'aac',
    canDecode: async () => true,
    getFirstTimestamp: async () => 0,
    computeDuration: async () => duration,
  };
  return {
    ALL_FORMATS: [],
    BlobSource: class { constructor(file) { this.file = file; } },
    Input: class {
      constructor({ source }) { this.source = source; }
      async getPrimaryVideoTrack() { return videoTrack; }
      async getPrimaryAudioTrack() { return audioTrack; }
      async getAudioTracks() { return [audioTrack]; }
      dispose() {}
    },
  };
}

test('live session retains rolling lightweight history for overlapping replays and enforces playback gate', () => {
  const session = createLiveSession({ windowSeconds: 120, threshold: 0.25 });
  const t0 = 1_700_000_000_000;
  session.start({ kind: 'display', nowMs: t0 });

  // Push 30 seconds of 20ms interleaved peak/rms envelope (1500 buckets).
  const batch = new Float32Array(3000);
  for (let i = 0; i < 1500; i++) {
    batch[i * 2] = 0.4;
    batch[i * 2 + 1] = 0.25;
  }
  session.pushEnvelope(batch, 0, t0);
  session.pushScoreWindow({ wallStartMs: t0 + 8_000, wallEndMs: t0 + 18_000, scores: [0.78, 0.1] });
  session.addMark({ wallStartMs: t0 + 11_000, wallEndMs: t0 + 16_000 });

  // Playback gate blocks new windows while webpage is playing unmuted audio.
  session.setPlaybackGate(true);
  assert.equal(session.snapshot().gateActive, true);
  assert.equal(session.pushScoreWindow({ wallStartMs: t0 + 20_000, wallEndMs: t0 + 30_000, scores: [0.95, 0.1] }), null);
  assert.equal(session.setAllowGateBypass(true), false); // forbidden for display capture

  session.setPlaybackGate(false);
  assert.equal(session.snapshot().gateActive, false);

  // Overlapping replay A [t0, t0+20s] and replay B [t0+5s, t0+25s] both independently slice full history.
  const history = session.getHistoryForAlignment();
  const sliceA = mapLiveHistoryToMaster({ liveHistory: history, duration: 20, masterStartEpochMs: t0 });
  const sliceB = mapLiveHistoryToMaster({ liveHistory: history, duration: 20, masterStartEpochMs: t0 + 5_000 });

  assert.equal(sliceA.windowScores.length, 1);
  assert.equal(sliceB.windowScores.length, 1);
  assert.equal(sliceA.liveDecisions[0].start, 11);
  assert.equal(sliceB.liveDecisions[0].start, 6);
});

test('analysis queue pause/resume holds queued jobs and browser-analysis importPrecomputed skips analyze while supporting recompute', async () => {
  let analyzed = 0;
  const q = createAnalysisQueue({
    async prepare(record) { return { duration: 60, name: record.file.name }; },
    async analyze() { analyzed++; },
  });
  q.pause();
  await q.importFiles([{ name: 'queued.mp4' }]);
  assert.equal(analyzed, 0);
  assert.equal(q.records[0].status, 'queued');
  q.resume();
  await q.whenIdle();
  assert.equal(analyzed, 1);
  assert.equal(q.records[0].status, 'complete');

  // Verify browser-analysis importPrecomputed skips full analyze and natively supports recompute().
  const MB = mockMediaBunny(60);
  const file = { name: 'replay.mp4', size: 1024, lastModified: Date.now() };
  const candidateUpdates = [];
  const browserQueue = createBrowserAnalysis({
    MB,
    onCandidates(_record, candidates) { candidateUpdates.push(candidates); },
  });

  const record = await browserQueue.importPrecomputed(file, {
    threshold: 0.3,
    windowScores: [
      { start: 5, end: 15, scores: [0.45, 0.1] },
      { start: 40, end: 50, scores: [0.85, 0.2] },
    ],
    alignment: { confidence: 'exact', correlation: 0.91, offsetMs: -420 },
  });

  assert.equal(record.status, 'complete');
  assert.equal(record.candidates.length, 2);
  assert.equal(record.alignment.confidence, 'exact');

  // Recompute with higher threshold should keep only the 0.85 window without re-running model inference.
  const recomputed = browserQueue.recompute(record.id, 0.6);
  assert.equal(recomputed.length, 1);
  assert.ok(recomputed[0].start >= 35 && recomputed[0].end <= 55);
  await browserQueue.dispose();
});

test('live session toWaveformView and conformed scoreTimeline plug directly into shared waveform-layers components', () => {
  const session = createLiveSession({ windowSeconds: 120, threshold: 0.2 });
  const t0 = 1_700_000_000_000;
  session.start({ kind: 'simulated', nowMs: t0 });

  // Push 40 seconds of 20ms peaks (2000 buckets) and 4-group prediction scores.
  const env = new Float32Array(4000);
  for (let i = 0; i < 2000; i++) {
    env[i * 2] = 0.65;
    env[i * 2 + 1] = 0.35;
  }
  session.pushEnvelope(env, 0, t0);
  session.pushScoreWindow({
    wallStartMs: t0 + 15_000,
    wallEndMs: t0 + 25_000,
    scores: [0.88, 0.2],
    groupScores: [0.88, 0.62, 0.1, 0.41],
  });

  const view = session.toWaveformView(120);
  assert.equal(view.duration, 40);
  assert.ok(view.scoreTimeline && view.scoreTimeline.groupScoreFrames > 0);

  const layered = layeredWaveColumns({
    wave: view.wave,
    scoreTimeline: view.scoreTimeline,
    start: 0,
    end: view.duration,
    width: 80,
    canvasHeight: 84,
  });
  assert.ok(layered.some((col) => col.layers.some((layer) => layer.id === 'gunshot')));
  assert.ok(layered.some((col) => col.layers.some((layer) => layer.id === 'speech')));

  const overview = overviewDistributionColumns({
    wave: view.wave,
    scoreTimeline: view.scoreTimeline,
    duration: view.duration,
    width: 80,
    canvasHeight: 12,
  });
  assert.ok(overview.some((col) => col.gunshotHeight > 0));

  const probe = groupScoresAtTime(view.scoreTimeline, 20);
  assert.equal(probe.status, 'ok');
  assert.ok(probe.scores[0] > 0.8);
  assert.ok(probe.scores[1] > 0.5);

  const conformed = mapLiveHistoryToMaster({
    liveHistory: session.getHistoryForAlignment(),
    duration: 40,
    masterStartEpochMs: t0,
  });
  assert.ok(conformed.scoreTimeline && conformed.scoreTimeline.groupScorePyramid);
});

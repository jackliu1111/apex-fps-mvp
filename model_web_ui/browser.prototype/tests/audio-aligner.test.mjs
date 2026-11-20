import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEnvelopeFromPcm,
  nccAlign,
  alignRecordingToLiveSession,
  ENVELOPE_STEP_SECONDS,
} from '../../../site/audio-aligner.mjs';

function syntheticGunshotEnvelope(durationSec, stepSec = ENVELOPE_STEP_SECONDS, seed = 7) {
  const n = Math.floor(durationSec / stepSec);
  const env = new Float32Array(n);
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  // Base low ambient floor + sharp combat bursts at deterministic positions.
  for (let i = 0; i < n; i++) env[i] = 0.03 + rand() * 0.02;
  const burstTimes = [4.2, 8.7, 11.1, 16.5, 22.8, 29.4, 38.0, 52.3];
  for (const t of burstTimes) {
    const idx = Math.floor(t / stepSec);
    for (let k = 0; k < 18 && idx + k < n; k++) {
      env[idx + k] = Math.min(1, env[idx + k] + Math.exp(-k / 4.5) * (0.45 + 0.45 * rand()));
    }
  }
  return env;
}

test('NCC fine alignment recovers +1420ms write-close offset under mixed noise within 25ms', () => {
  const liveStartEpochMs = 1_700_000_000_000;
  const cleanLive = syntheticGunshotEnvelope(60);
  // Add 25% uncorrelated voice/BGM noise onto live system mixdown.
  const noisyLive = new Float32Array(cleanLive.length);
  let s = 42;
  for (let i = 0; i < cleanLive.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const voice = (s / 0xffffffff) * 0.14;
    noisyLive[i] = Math.min(1, cleanLive[i] + voice);
  }

  // Master recording truly started at liveStart + 5.000s, lasted 40s.
  // Simulated recorder closed file late, making coarse start off by -1420ms.
  const trueMasterStartMs = liveStartEpochMs + 5000;
  const injectedErrorMs = -1420;
  const coarseStartEpochMs = trueMasterStartMs + injectedErrorMs;
  const anchorStartSec = 5;
  const anchorLen = Math.floor(15 / ENVELOPE_STEP_SECONDS);
  const trueAnchorIdx = Math.round(((trueMasterStartMs + anchorStartSec * 1000) - liveStartEpochMs) / (ENVELOPE_STEP_SECONDS * 1000));
  const masterEnv = cleanLive.subarray(trueAnchorIdx, trueAnchorIdx + anchorLen);

  const aligned = nccAlign({
    liveEnv: noisyLive,
    liveStartEpochMs,
    masterEnv,
    masterAnchorStartSec: anchorStartSec,
    coarseStartEpochMs,
  });

  assert.equal(aligned.confidence, 'exact');
  assert.ok(aligned.correlation > 0.75, `expected high correlation, got ${aligned.correlation}`);
  const recoveredStartMs = coarseStartEpochMs + aligned.offsetMs;
  assert.ok(Math.abs(recoveredStartMs - trueMasterStartMs) <= 25,
    `expected <=25ms error, got ${Math.abs(recoveredStartMs - trueMasterStartMs)}ms`);
});

test('two-stage aligner degrades cleanly to coarse on uncorrelated audio and unmatched for old files', async () => {
  const liveStartEpochMs = 1_700_000_000_000;
  const liveEnv = syntheticGunshotEnvelope(60);
  const liveHistory = {
    startEpochMs: liveStartEpochMs,
    envStepSeconds: ENVELOPE_STEP_SECONDS,
    envPeaks: liveEnv,
    envRms: liveEnv,
    scoreWindows: [
      { wallStartMs: liveStartEpochMs + 10_000, wallEndMs: liveStartEpochMs + 20_000, scores: [0.81, 0.12] },
    ],
    decisions: [
      { id: 'live-dec:1', kind: 'retain', wallStartMs: liveStartEpochMs + 12_000, wallEndMs: liveStartEpochMs + 18_000 },
    ],
  };

  // 1) Old recording completely outside live window -> unmatched (never auto-analyzed in background).
  const oldResult = await alignRecordingToLiveSession({
    file: { name: 'old.mp4', lastModified: liveStartEpochMs - 120_000 },
    duration: 30,
    liveHistory,
    extractSlice: async () => new Float32Array(750),
  });
  assert.equal(oldResult.confidence, 'unmatched');
  assert.equal(oldResult.mapped, null);

  // 2) Overlapping wall-clock but uncorrelated master audio -> safe coarse fallback + migrated decisions.
  const uncorrelatedMaster = new Float32Array(750).map((_, i) => Math.sin(i * 0.37) * 0.2 + 0.3);
  const coarseResult = await alignRecordingToLiveSession({
    file: { name: 'mismatch-track.mp4', lastModified: liveStartEpochMs + 45_000 },
    duration: 40,
    liveHistory,
    extractSlice: async () => uncorrelatedMaster,
  });
  assert.equal(coarseResult.confidence, 'coarse');
  assert.equal(coarseResult.mapped.windowScores.length, 1);
  assert.equal(coarseResult.mapped.liveDecisions.length, 1);
  assert.equal(coarseResult.mapped.liveDecisions[0].kind, 'retain');
});

test('computeEnvelopeFromPcm produces 20ms RMS buckets accurately', () => {
  const sr = 32000;
  const pcm = new Float32Array(sr); // 1 second
  pcm.fill(0.5, 0, sr / 2);
  pcm.fill(0, sr / 2);
  const env = computeEnvelopeFromPcm(pcm, sr, 0.02);
  assert.equal(env.length, 50);
  assert.ok(Math.abs(env[0] - 0.5) < 1e-4);
  assert.equal(env[49], 0);
});

test('two-stage aligner achieves exact alignment for short (~14s) demo clips and mid-stream conforms', async () => {
  const liveStartEpochMs = 1_700_000_000_000;
  const clipDuration = 14.13;
  const fullEnv = syntheticGunshotEnvelope(clipDuration);

  // Full 14.13s pass recorded in live history with +1400ms coarse offset.
  const injectedOffsetMs = 1400;
  const liveHistoryFull = {
    startEpochMs: liveStartEpochMs,
    envStepSeconds: ENVELOPE_STEP_SECONDS,
    envPeaks: fullEnv,
    envRms: fullEnv,
    scoreWindows: [
      { wallStartMs: liveStartEpochMs + 3000, wallEndMs: liveStartEpochMs + 13000, scores: [0.82, 0.14] },
    ],
    decisions: [],
  };

  const fullResult = await alignRecordingToLiveSession({
    file: { name: 'demo-apex-clip.mp4', lastModified: liveStartEpochMs + clipDuration * 1000 },
    duration: clipDuration,
    liveHistory: liveHistoryFull,
    coarseStartOverrideMs: liveStartEpochMs - injectedOffsetMs,
    extractSlice: async ({ startSec, spanSec }) => {
      const i0 = Math.floor(startSec / ENVELOPE_STEP_SECONDS);
      const len = Math.max(1, Math.floor(spanSec / ENVELOPE_STEP_SECONDS));
      return fullEnv.subarray(i0, Math.min(fullEnv.length, i0 + len));
    },
  });

  assert.equal(fullResult.confidence, 'exact');
  assert.ok(Math.abs(fullResult.masterStartEpochMs - liveStartEpochMs) <= 30,
    `expected <=30ms error on 14s clip, got ${Math.abs(fullResult.masterStartEpochMs - liveStartEpochMs)}ms`);

  // Mid-stream conform when only 8s of the 14s clip has played so far.
  const partialEnv = fullEnv.subarray(0, Math.floor(8 / ENVELOPE_STEP_SECONDS));
  const partialResult = await alignRecordingToLiveSession({
    file: { name: 'demo-apex-clip.mp4', lastModified: liveStartEpochMs + clipDuration * 1000 },
    duration: clipDuration,
    liveHistory: { ...liveHistoryFull, envPeaks: partialEnv, envRms: partialEnv },
    coarseStartOverrideMs: liveStartEpochMs - 800,
    extractSlice: async ({ startSec, spanSec }) => {
      const i0 = Math.floor(startSec / ENVELOPE_STEP_SECONDS);
      const len = Math.max(1, Math.floor(spanSec / ENVELOPE_STEP_SECONDS));
      return fullEnv.subarray(i0, Math.min(fullEnv.length, i0 + len));
    },
  });

  assert.equal(partialResult.confidence, 'exact');
  assert.ok(Math.abs(partialResult.masterStartEpochMs - liveStartEpochMs) <= 30);
});

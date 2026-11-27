import { ENVELOPE_STEP_SECONDS } from './audio-aligner.mjs';

export const DEFAULT_MAX_HISTORY_SECONDS = 3600; // 60 minutes rolling lightweight history

const INITIAL_CAPACITY_BUCKETS = 4096;

/**
 * Pure wall-clock rolling audio history store for Live Audio Analysis (实时音频分析).
 * Retains up to 60 minutes of 20 ms peak/RMS energy envelopes and gunshot/4-group
 * prediction score windows for master recording alignment & conforming (原片升格).
 * Contains zero video proxy, filmstrip, manual marking, or live pre-decision state.
 */
export function createLiveAudioHistory({
  maxHistorySeconds = DEFAULT_MAX_HISTORY_SECONDS,
  envStepSeconds = ENVELOPE_STEP_SECONDS,
} = {}) {
  const safeMaxSeconds = Math.max(1, Number(maxHistorySeconds) || DEFAULT_MAX_HISTORY_SECONDS);
  const stepSeconds = Number(envStepSeconds) > 0 ? Number(envStepSeconds) : ENVELOPE_STEP_SECONDS;
  const stepMs = stepSeconds * 1000;
  const maxBuckets = Math.max(1, Math.round(safeMaxSeconds / stepSeconds));
  const initialCapacity = Math.min(maxBuckets, INITIAL_CAPACITY_BUCKETS);

  let startEpochMs = 0;
  let peaksBuf = new Float32Array(initialCapacity);
  let rmsBuf = new Float32Array(initialCapacity);
  let head = 0;
  let count = 0;
  let scoreWindows = [];

  function ensureCapacity(required) {
    const target = Math.min(maxBuckets, required);
    if (target <= peaksBuf.length) return;
    let nextCap = peaksBuf.length;
    while (nextCap < target) nextCap = Math.min(maxBuckets, nextCap * 2);
    const nextPeaks = new Float32Array(nextCap);
    const nextRms = new Float32Array(nextCap);
    if (count > 0) {
      const firstLen = Math.min(count, peaksBuf.length - head);
      nextPeaks.set(peaksBuf.subarray(head, head + firstLen), 0);
      nextRms.set(rmsBuf.subarray(head, head + firstLen), 0);
      if (firstLen < count) {
        nextPeaks.set(peaksBuf.subarray(0, count - firstLen), firstLen);
        nextRms.set(rmsBuf.subarray(0, count - firstLen), firstLen);
      }
    }
    peaksBuf = nextPeaks;
    rmsBuf = nextRms;
    head = 0;
  }

  function appendBucket(peak, rms) {
    if (count < peaksBuf.length) {
      const idx = (head + count) % peaksBuf.length;
      peaksBuf[idx] = peak;
      rmsBuf[idx] = rms;
      count++;
      return;
    }
    peaksBuf[head] = peak;
    rmsBuf[head] = rms;
    head = (head + 1) % peaksBuf.length;
    startEpochMs += stepMs;
  }

  function latestEnvelopeEpochMs() {
    if (!startEpochMs) return 0;
    return startEpochMs + count * stepMs;
  }

  function latestEpochMs() {
    let latest = latestEnvelopeEpochMs();
    if (scoreWindows.length > 0) {
      const lastWinEnd = scoreWindows[scoreWindows.length - 1].wallEndMs;
      if (lastWinEnd > latest) latest = lastWinEnd;
    }
    return latest;
  }

  function trimTo(referenceEpochMs) {
    if (!Number.isFinite(referenceEpochMs) || referenceEpochMs <= 0) return;
    const cutoffMs = referenceEpochMs - safeMaxSeconds * 1000;
    if (startEpochMs > 0 && count > 0 && cutoffMs > startEpochMs) {
      const drop = Math.floor((cutoffMs - startEpochMs) / stepMs);
      if (drop >= count) {
        head = 0;
        count = 0;
        startEpochMs = 0;
      } else if (drop > 0) {
        head = (head + drop) % peaksBuf.length;
        count -= drop;
        startEpochMs += drop * stepMs;
      }
    }
    if (scoreWindows.length > 0) {
      scoreWindows = scoreWindows.filter((w) => w.wallEndMs >= cutoffMs);
    }
  }

  function readContiguous(buf) {
    const out = new Float32Array(count);
    if (count === 0) return out;
    const firstLen = Math.min(count, buf.length - head);
    out.set(buf.subarray(head, head + firstLen), 0);
    if (firstLen < count) out.set(buf.subarray(0, count - firstLen), firstLen);
    return out;
  }

  function clear() {
    startEpochMs = 0;
    head = 0;
    count = 0;
    scoreWindows = [];
  }

  function syncWallClock(nowMs) {
    if (!Number.isFinite(nowMs) || nowMs <= 0) return;
    if (!startEpochMs || count === 0) {
      startEpochMs = nowMs;
      trimTo(nowMs);
      return;
    }
    if (nowMs < startEpochMs) {
      clear();
      startEpochMs = nowMs;
      return;
    }
    const envEndMs = latestEnvelopeEpochMs();
    const gapMs = nowMs - envEndMs;
    if (gapMs <= 0) return;
    if (gapMs >= safeMaxSeconds * 1000) {
      clear();
      startEpochMs = nowMs;
      return;
    }
    const gapBuckets = Math.round(gapMs / stepMs);
    if (gapBuckets <= 0) return;
    ensureCapacity(count + gapBuckets);
    for (let i = 0; i < gapBuckets; i++) appendBucket(0, 0);
    trimTo(latestEpochMs());
  }

  return {
    begin(nowMs) {
      syncWallClock(nowMs);
    },

    syncWallClock,

    pushEnvelope(interleavedPeakRms, nowMs = Date.now()) {
      if (!interleavedPeakRms || interleavedPeakRms.length < 2) return 0;
      const incomingBuckets = Math.floor(interleavedPeakRms.length / 2);
      if (incomingBuckets <= 0) return 0;
      if (!startEpochMs) startEpochMs = nowMs;
      ensureCapacity(count + incomingBuckets);
      for (let i = 0; i < incomingBuckets; i++) {
        appendBucket(interleavedPeakRms[i * 2], interleavedPeakRms[i * 2 + 1]);
      }
      trimTo(latestEpochMs());
      return incomingBuckets;
    },

    pushScoreWindow({
      wallStartMs,
      wallEndMs,
      scores,
      groupScores = null,
      frameGroupScores = null,
      frameSeconds = 0.04,
    }) {
      const scorePair = Array.from(scores || [0, 0], (v) => Number(v) || 0);
      const maxScore = scorePair.length ? Math.max(...scorePair) : 0;
      const resolvedGroups = groupScores
        ? Array.from(groupScores, (v) => Number(v) || 0)
        : [maxScore, 0, 0, 0];
      const entry = {
        wallStartMs,
        wallEndMs,
        scores: scorePair,
        groupScores: resolvedGroups,
        frameGroupScores: frameGroupScores ? Float32Array.from(frameGroupScores) : null,
        frameSeconds: Number(frameSeconds) || 0.04,
        maxScore,
      };
      scoreWindows.push(entry);
      trimTo(Math.max(latestEpochMs(), wallEndMs));
      return entry;
    },

    clear,

    summary() {
      return {
        startEpochMs,
        latestEpochMs: latestEpochMs(),
        durationSec: count * stepSeconds,
        envelopeBucketCount: count,
        scoreWindowCount: scoreWindows.length,
      };
    },

    exportForAlignment() {
      return {
        startEpochMs,
        latestEpochMs: latestEpochMs(),
        envStepSeconds: stepSeconds,
        envPeaks: readContiguous(peaksBuf),
        envRms: readContiguous(rmsBuf),
        scoreWindows: scoreWindows.map((w) => ({
          wallStartMs: w.wallStartMs,
          wallEndMs: w.wallEndMs,
          scores: [...w.scores],
          groupScores: [...w.groupScores],
          frameGroupScores: w.frameGroupScores ? Float32Array.from(w.frameGroupScores) : null,
          frameSeconds: w.frameSeconds,
          maxScore: w.maxScore,
        })),
      };
    },
  };
}

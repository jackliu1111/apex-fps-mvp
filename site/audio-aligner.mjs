import { createAudioPeaks, updateAudioPeakPyramid } from './audio-peaks.mjs';
import { DISPLAY_GROUPS } from './lab-display-groups.mjs';
import { createGroupScorePyramid, updateGroupScorePyramid } from './waveform-layers.mjs';

export const ENVELOPE_STEP_SECONDS = 0.02; // 20 ms (50 Hz)
export const COARSE_SEARCH_SECONDS = 8;
export const EXACT_CORRELATION_THRESHOLD = 0.65;
export const ANCHOR_WINDOW_SECONDS = 15;

/**
 * Compute 20 ms peak/RMS energy envelope from mono PCM samples.
 * Uses RMS for robust cross-correlation under mixed voice/game noise.
 */
export function computeEnvelopeFromPcm(samples, sampleRate, stepSeconds = ENVELOPE_STEP_SECONDS) {
  if (!samples?.length || !(sampleRate > 0)) return new Float32Array(0);
  const bucketSamples = Math.max(1, Math.round(sampleRate * stepSeconds));
  const count = Math.floor(samples.length / bucketSamples);
  const envelope = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let sumSq = 0;
    const start = b * bucketSamples;
    const end = Math.min(samples.length, start + bucketSamples);
    for (let i = start; i < end; i++) {
      const v = samples[i];
      sumSq += v * v;
    }
    envelope[b] = Math.sqrt(sumSq / Math.max(1, end - start));
  }
  return envelope;
}

/**
 * Compute normalized cross-correlation (NCC) between a short master envelope
 * anchor and the live 20 ms envelope stream around a coarse wall-clock estimate.
 */
export function nccAlign({
  liveEnv,
  liveStartEpochMs,
  masterEnv,
  masterAnchorStartSec,
  coarseStartEpochMs,
  stepSeconds = ENVELOPE_STEP_SECONDS,
  searchSeconds = COARSE_SEARCH_SECONDS,
  threshold = EXACT_CORRELATION_THRESHOLD,
}) {
  if (!liveEnv?.length || !masterEnv?.length) {
    return { offsetMs: 0, correlation: 0, secondPeak: 0, confidence: 'coarse', matched: false };
  }

  const mLen = masterEnv.length;
  let mMean = 0;
  for (let i = 0; i < mLen; i++) mMean += masterEnv[i];
  mMean /= mLen;

  let mVar = 0;
  const mCentered = new Float32Array(mLen);
  for (let i = 0; i < mLen; i++) {
    const d = masterEnv[i] - mMean;
    mCentered[i] = d;
    mVar += d * d;
  }
  if (mVar < 1e-9) {
    return { offsetMs: 0, correlation: 0, secondPeak: 0, confidence: 'coarse', matched: false };
  }

  const stepMs = stepSeconds * 1000;
  const centerIndex = Math.round(((coarseStartEpochMs + masterAnchorStartSec * 1000) - liveStartEpochMs) / stepMs);
  const radius = Math.round(searchSeconds / stepSeconds);
  const minLag = Math.max(-radius, -centerIndex);
  const maxLag = Math.min(radius, liveEnv.length - mLen - centerIndex);

  if (minLag > maxLag) {
    return { offsetMs: 0, correlation: 0, secondPeak: 0, confidence: 'coarse', matched: false };
  }

  const scores = new Float32Array(maxLag - minLag + 1);
  let bestCorr = -Infinity;
  let bestLag = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const base = centerIndex + lag;
    let lMean = 0;
    for (let i = 0; i < mLen; i++) lMean += liveEnv[base + i];
    lMean /= mLen;

    let dot = 0;
    let lVar = 0;
    for (let i = 0; i < mLen; i++) {
      const ld = liveEnv[base + i] - lMean;
      dot += mCentered[i] * ld;
      lVar += ld * ld;
    }
    const corr = lVar > 1e-9 ? dot / Math.sqrt(mVar * lVar) : 0;
    scores[lag - minLag] = corr;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // Evaluate peak sharpness by finding the strongest correlation at least 0.5 s away from bestLag.
  const excludeBins = Math.round(0.5 / stepSeconds);
  let secondPeak = 0;
  for (let i = 0; i < scores.length; i++) {
    const lag = minLag + i;
    if (Math.abs(lag - bestLag) <= excludeBins) continue;
    if (scores[i] > secondPeak) secondPeak = scores[i];
  }

  // Quadratic sub-bin interpolation around bestLag for sub-20 ms refinement.
  let refinedLag = bestLag;
  const bestIdx = bestLag - minLag;
  if (bestIdx > 0 && bestIdx < scores.length - 1) {
    const y0 = scores[bestIdx - 1];
    const y1 = scores[bestIdx];
    const y2 = scores[bestIdx + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-9) {
      const delta = Math.max(-0.5, Math.min(0.5, (y0 - y2) / denom));
      refinedLag = bestLag + delta;
    }
  }

  const offsetMs = Math.round(refinedLag * stepMs);
  const sharpEnough = bestCorr >= threshold && (bestCorr - secondPeak >= 0.1 || bestCorr >= 0.85);
  return {
    offsetMs,
    correlation: Number(bestCorr.toFixed(4)),
    secondPeak: Number(secondPeak.toFixed(4)),
    confidence: sharpEnough ? 'exact' : 'coarse',
    matched: sharpEnough,
  };
}

/**
 * Pick anchor start seconds within [0, duration] that maximize energy variance in the live envelope.
 */
export function selectAnchorRanges({
  liveEnv,
  liveStartEpochMs,
  coarseStartEpochMs,
  duration,
  anchorSeconds = ANCHOR_WINDOW_SECONDS,
  stepSeconds = ENVELOPE_STEP_SECONDS,
}) {
  const liveDurationSec = (liveEnv?.length || 0) * stepSeconds;
  const effectiveDuration = liveDurationSec > 0 ? Math.min(duration, liveDurationSec) : duration;
  const span = Math.min(
    anchorSeconds,
    duration,
    Math.max(2, effectiveDuration * 0.45),
  );
  const stepMs = stepSeconds * 1000;
  const len = Math.round(span / stepSeconds);
  const scoreSlice = (startSec) => {
    const rawIdx = Math.round(((coarseStartEpochMs + startSec * 1000) - liveStartEpochMs) / stepMs);
    if (len < 10 || liveEnv.length < len) return -1;
    // Allow anchors whose coarse projection is slightly outside [0, liveEnv.length - len]
    // as long as the true anchor can still fall inside liveEnv within COARSE_SEARCH_SECONDS.
    const searchBins = Math.round(COARSE_SEARCH_SECONDS / stepSeconds);
    if (rawIdx + searchBins < 0 || rawIdx - searchBins > liveEnv.length - len) return -1;
    const idxStart = Math.max(0, Math.min(liveEnv.length - len, rawIdx));
    let sum = 0;
    let sumSq = 0;
    for (let i = idxStart; i < idxStart + len; i++) {
      const v = liveEnv[i];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / len;
    const variance = sumSq / len - mean * mean;
    // Slightly penalize anchors near the right edge of liveEnv so positive coarse offsets
    // retain sliding headroom during NCC.
    const rightRoom = liveEnv.length - (idxStart + len);
    const marginWeight = rightRoom >= Math.min(searchBins, Math.round(2 / stepSeconds)) ? 1 : 0.6;
    return variance * marginWeight;
  };

  const candidates = [];
  const stride = Math.max(1.5, Math.floor(span / 2));
  const maxStart = Math.max(0, Math.min(duration - span, liveDurationSec > 0 ? Math.max(0, liveDurationSec - span) : duration - span));
  for (let sec = 0; sec <= maxStart + 1e-6; sec += stride) {
    const clampedSec = Math.min(sec, maxStart);
    const variance = scoreSlice(clampedSec);
    if (variance >= 0) candidates.push({ startSec: clampedSec, spanSec: span, variance });
  }
  if (!candidates.length) return [{ startSec: 0, spanSec: span, variance: 0 }];
  candidates.sort((a, b) => b.variance - a.variance);
  return candidates;
}

/**
 * Map live history (scores and envelope peaks) onto a master recording timeline.
 * Supports linear clock-drift interpolation when head + tail anchors both achieve exact alignment.
 */
export function mapLiveHistoryToMaster({
  liveHistory,
  duration,
  masterStartEpochMs,
  driftRate = 0, // seconds of live drift per media second
  trackIndex = 0,
}) {
  const toMediaSec = (wallMs) => (wallMs - masterStartEpochMs) / (1000 * (1 + driftRate));

  const windowScores = [];
  for (const win of liveHistory.scoreWindows || []) {
    const start = toMediaSec(win.wallStartMs);
    const end = toMediaSec(win.wallEndMs);
    if (end <= 0 || start >= duration) continue;
    windowScores.push({
      start: Math.max(0, start),
      end: Math.min(duration, end),
      scores: [...win.scores],
    });
  }

  const waveform = createAudioPeaks(duration, trackIndex);
  const env = liveHistory.envPeaks || liveHistory.envRms || [];
  const stepMs = (liveHistory.envStepSeconds || ENVELOPE_STEP_SECONDS) * 1000;
  for (let i = 0; i < env.length; i++) {
    const t = toMediaSec(liveHistory.startEpochMs + i * stepMs);
    if (t < 0 || t >= duration) continue;
    const bucket = Math.min(waveform.peaks.length - 1, Math.floor(t / waveform.step));
    waveform.peaks[bucket] = Math.max(waveform.peaks[bucket] ?? 0, Math.min(1, env[i]));
    waveform.decodedUntil = Math.max(waveform.decodedUntil, Math.min(duration, t));
  }
  updateAudioPeakPyramid(waveform, 0, waveform.peaks.length);

  // Map 4-group live scores into a reusable session scoreTimeline for offline review layers.
  const groupCount = DISPLAY_GROUPS.length;
  const frameSeconds = 0.2;
  const totalFrames = Math.max(1, Math.ceil(duration / frameSeconds));
  const groupScores = new Float32Array(totalFrames * groupCount);
  let analyzedFrames = 0;
  for (const win of liveHistory.scoreWindows || []) {
    const start = toMediaSec(win.wallStartMs);
    const end = toMediaSec(win.wallEndMs);
    if (end <= 0 || start >= duration) continue;
    if (win.frameGroupScores && win.frameGroupScores.length >= groupCount) {
      const srcFrames = Math.floor(win.frameGroupScores.length / groupCount);
      const srcStep = win.frameSeconds || 0.04;
      for (let f = 0; f < srcFrames; f++) {
        const t = start + f * srcStep;
        if (t < 0 || t >= duration) continue;
        const dstF = Math.min(totalFrames - 1, Math.floor(t / frameSeconds));
        if (dstF + 1 > analyzedFrames) analyzedFrames = dstF + 1;
        const dstBase = dstF * groupCount;
        const srcBase = f * groupCount;
        for (let g = 0; g < groupCount; g++) {
          const v = win.frameGroupScores[srcBase + g];
          if (v > groupScores[dstBase + g]) groupScores[dstBase + g] = v;
        }
      }
    } else {
      const gs = win.groupScores || [Math.max(...(win.scores || [0])), 0, 0, 0];
      const f0 = Math.max(0, Math.floor(start / frameSeconds));
      const f1 = Math.min(totalFrames, Math.ceil(end / frameSeconds));
      if (f1 > analyzedFrames) analyzedFrames = f1;
      for (let f = f0; f < f1; f++) {
        const base = f * groupCount;
        for (let g = 0; g < groupCount; g++) {
          if (gs[g] > groupScores[base + g]) groupScores[base + g] = gs[g];
        }
      }
    }
  }
  let scoreTimeline = null;
  if (analyzedFrames > 0) {
    const pyramid = createGroupScorePyramid(groupScores, totalFrames, groupCount, frameSeconds);
    updateGroupScorePyramid(pyramid, 0, analyzedFrames);
    scoreTimeline = {
      groupScores,
      groupScoreFrames: analyzedFrames,
      groupScorePyramid: pyramid,
      groupCount,
      frameSeconds,
      audioOffset: 0,
      audioDuration: duration,
    };
  }

  return { windowScores, waveform, scoreTimeline };
}

/**
 * Locally decode a bounded audio slice [startSec, startSec + spanSec] via Mediabunny
 * and convert it into a 20 ms RMS envelope. Never scans the full recording.
 */
export async function extractMasterEnvelopeSlice({ MB, track, origin = 0, startSec, spanSec, stepSeconds = ENVELOPE_STEP_SECONDS }) {
  const sink = new MB.AudioBufferSink(track);
  const from = origin + Math.max(0, startSec);
  const to = from + spanSec;
  const iterator = sink.buffers(from, to)[Symbol.asyncIterator]();
  const buckets = new Float32Array(Math.max(1, Math.floor(spanSec / stepSeconds)));
  const counts = new Uint32Array(buckets.length);

  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) break;
      const { buffer, timestamp } = value;
      const sr = buffer.sampleRate;
      const channels = buffer.numberOfChannels;
      const relStart = timestamp - from;
      const len = buffer.length;
      for (let i = 0; i < len; i++) {
        const t = relStart + i / sr;
        if (t < 0 || t >= spanSec) continue;
        const b = Math.floor(t / stepSeconds);
        if (b < 0 || b >= buckets.length) continue;
        let mono = 0;
        for (let ch = 0; ch < channels; ch++) mono += buffer.getChannelData(ch)[i];
        mono /= channels;
        buckets[b] += mono * mono;
        counts[b]++;
      }
    }
  } finally {
    await iterator.return?.();
  }

  for (let b = 0; b < buckets.length; b++) {
    buckets[b] = counts[b] > 0 ? Math.sqrt(buckets[b] / counts[b]) : 0;
  }
  return buckets;
}

/**
 * Full two-stage Coarse-to-Fine alignment orchestrator for a newly finalized master recording.
 */
export async function alignRecordingToLiveSession({
  file,
  duration,
  origin = 0,
  trackIndex = 0,
  liveHistory,
  extractSlice, // async ({ startSec, spanSec }) => Float32Array (20 ms RMS envelope)
  coarseStartOverrideMs = null,
}) {
  const liveStartMs = liveHistory.startEpochMs;
  const stepSeconds = liveHistory.envStepSeconds || ENVELOPE_STEP_SECONDS;
  const liveDurationMs = (liveHistory.envRms?.length || 0) * stepSeconds * 1000;
  const liveEndMs = liveStartMs + liveDurationMs;

  const coarseStartEpochMs = coarseStartOverrideMs ?? (file.lastModified - duration * 1000);
  const coarseEndEpochMs = coarseStartEpochMs + duration * 1000;

  // Stage 1: Check wall-clock overlap with live history (including search margin).
  const marginMs = COARSE_SEARCH_SECONDS * 1000;
  if (!liveDurationMs || coarseEndEpochMs < liveStartMs - marginMs || coarseStartEpochMs > liveEndMs + marginMs) {
    return {
      confidence: 'unmatched',
      reason: 'out-of-live-history',
      coarseStartEpochMs,
      masterStartEpochMs: coarseStartEpochMs,
      offsetMs: 0,
      correlation: 0,
      driftPpm: 0,
      mapped: null,
    };
  }

  // Stage 2: Pick high-variance anchor(s) and perform local NCC alignment.
  const candidates = selectAnchorRanges({
    liveEnv: liveHistory.envRms,
    liveStartEpochMs: liveStartMs,
    coarseStartEpochMs,
    duration,
    stepSeconds,
  });

  const tryAnchor = async (anchor) => {
    const masterEnv = await extractSlice({ startSec: anchor.startSec, spanSec: anchor.spanSec });
    const res = nccAlign({
      liveEnv: liveHistory.envRms,
      liveStartEpochMs: liveStartMs,
      masterEnv,
      masterAnchorStartSec: anchor.startSec,
      coarseStartEpochMs,
      stepSeconds,
    });
    return { anchor, ...res };
  };

  let primary = await tryAnchor(candidates[0]);
  if (!primary.matched && candidates.length > 1) {
    // Retry once with a secondary distant anchor if primary had low correlation (e.g. voice-heavy segment).
    const secondaryCandidate = candidates.find((c) => Math.abs(c.startSec - candidates[0].startSec) >= 15) || candidates[1];
    const retry = await tryAnchor(secondaryCandidate);
    if (retry.correlation > primary.correlation) primary = retry;
  }

  let masterStartEpochMs = coarseStartEpochMs + (primary.matched ? primary.offsetMs : 0);
  let driftRate = 0;

  // For long recordings (> 30 min), align a second far-away anchor to compensate crystal clock drift.
  if (primary.matched && duration >= 1800) {
    const farHalf = primary.anchor.startSec < duration / 2
      ? candidates.find((c) => c.startSec > duration * 0.65)
      : candidates.find((c) => c.startSec < duration * 0.35);
    if (farHalf) {
      const far = await tryAnchor(farHalf);
      const dtSec = far.anchor.startSec - primary.anchor.startSec;
      if (far.matched && Math.abs(dtSec) >= 300) {
        const dOffsetSec = (far.offsetMs - primary.offsetMs) / 1000;
        driftRate = dOffsetSec / dtSec;
        masterStartEpochMs = coarseStartEpochMs + primary.offsetMs - driftRate * primary.anchor.startSec * 1000;
      }
    }
  }

  const mapped = mapLiveHistoryToMaster({
    liveHistory,
    duration,
    masterStartEpochMs,
    driftRate,
    trackIndex,
  });

  return {
    confidence: primary.matched ? 'exact' : 'coarse',
    coarseStartEpochMs,
    masterStartEpochMs,
    offsetMs: primary.matched ? primary.offsetMs : 0,
    correlation: primary.correlation,
    secondPeak: primary.secondPeak,
    driftPpm: Math.round(driftRate * 1e6),
    anchorStartSec: primary.anchor.startSec,
    mapped,
  };
}

import { waveformColumns } from './audio-peaks.mjs';
import { DISPLAY_GROUPS } from './lab-display-groups.mjs';
import { buildLevelDescriptors, propagatePyramidRange, visitPyramidRange } from './pyramid-cache.mjs';

export const DEFAULT_DISPLAY_THRESHOLD = 0.2;
export const DEFAULT_GAP_BRIDGE_MS = 80;
export const DEFAULT_MIN_GUNSHOT_PX = 4;
export const DEFAULT_WAVE_CSS_STRIDE = 4;
export const DEFAULT_WAVE_CSS_BAR_WIDTH = 2;

const SMOOTH_KERNEL_5 = Object.freeze([
  { offset: -2, weight: 0.14 },
  { offset: -1, weight: 0.22 },
  { offset: 0, weight: 0.28 },
  { offset: 1, weight: 0.22 },
  { offset: 2, weight: 0.14 },
]);

/**
 * Smooth adjacent analyzed peak columns with a 5-tap symmetric envelope kernel
 * while keeping unanalyzed (null) regions strictly isolated and uniform regions invariant.
 */
export function smoothWavePeaks(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) return [];
  const len = peaks.length;
  const out = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const center = peaks[i];
    if (center === null || center === undefined) continue;
    let weightedSum = 0;
    let weightTotal = 0;
    for (let k = 0; k < SMOOTH_KERNEL_5.length; k++) {
      const { offset, weight } = SMOOTH_KERNEL_5[k];
      const idx = i + offset;
      if (idx < 0 || idx >= len) continue;
      const neighbor = peaks[idx];
      if (neighbor === null || neighbor === undefined) continue;
      weightedSum += neighbor * weight;
      weightTotal += weight;
    }
    out[i] = weightTotal > 0 ? weightedSum / weightTotal : center;
  }
  return out;
}

/**
 * Resolve discrete bar + gap layout (Jianying / CapCut style) so the waveform renders
 * at a comfortable spatial frequency instead of a dense 1px wall.
 */
export function resolveWaveBarLayout(
  pixelWidth,
  dpr = 1,
  {
    cssStride = DEFAULT_WAVE_CSS_STRIDE,
    cssBarWidth = DEFAULT_WAVE_CSS_BAR_WIDTH,
    minBars = 60,
  } = {},
) {
  const safeWidth = Math.max(1, Math.round(pixelWidth || 1));
  const safeDpr = Math.max(1, dpr || 1);
  const stride = Math.max(1, Math.round(cssStride * safeDpr));
  if (stride <= 1 || safeWidth < minBars * stride) {
    return { barCount: safeWidth, barStride: 1, barWidth: 1 };
  }
  const barWidth = Math.max(1, Math.min(stride - 1, Math.round(cssBarWidth * safeDpr)));
  const barCount = Math.max(1, Math.ceil(safeWidth / stride));
  return { barCount, barStride: stride, barWidth };
}

const NON_GUNSHOT_ORDER = Object.freeze(
  Array.from({ length: Math.max(0, DISPLAY_GROUPS.length - 1) }, (_, idx) => idx + 1),
);

/** Preallocate a session-only multi-resolution max pyramid over preallocated groupScores. */
export function createGroupScorePyramid(groupScores, totalFrames, groupCount = DISPLAY_GROUPS.length, frameSeconds = 0.04) {
  const descriptors = buildLevelDescriptors(totalFrames, frameSeconds);
  const levels = descriptors.map((desc) => ({
    ...desc,
    scores: new Float32Array(desc.length * groupCount),
  }));
  return {
    version: 1,
    totalFrames,
    analyzedFrames: 0,
    groupCount,
    frameSeconds,
    baseScores: groupScores,
    levels,
  };
}

/** Incrementally propagate newly finalized frames [startFrame, startFrame + frameCount) up the pyramid. */
export function updateGroupScorePyramid(pyramid, startFrame, frameCount) {
  if (!pyramid || !(frameCount > 0)) return;
  const endFrame = Math.min(pyramid.totalFrames, startFrame + frameCount);
  pyramid.analyzedFrames = Math.max(pyramid.analyzedFrames, endFrame);
  const { levels, groupCount, baseScores, totalFrames } = pyramid;
  if (!levels?.length || !(endFrame > startFrame)) return;
  propagatePyramidRange(levels.length, startFrame, endFrame, (idx, start, end) => {
    const prev = idx === 0 ? baseScores : levels[idx - 1].scores;
    const prevLen = idx === 0 ? totalFrames : levels[idx - 1].length;
    const curr = levels[idx].scores;
    const limit = Math.min(levels[idx].length, end);
    for (let i = start; i < limit; i++) {
      const a = i * 2 * groupCount;
      const b = (i * 2 + 1) * groupCount;
      const dst = i * groupCount;
      if (i * 2 + 1 < prevLen) {
        for (let g = 0; g < groupCount; g++) {
          const va = prev[a + g];
          const vb = prev[b + g];
          curr[dst + g] = va > vb ? va : vb;
        }
      } else {
        for (let g = 0; g < groupCount; g++) curr[dst + g] = prev[a + g];
      }
    }
  });
}

function mergeScoreSlot(arr, idx, groupCount, out) {
  const base = idx * groupCount;
  for (let g = 0; g < groupCount; g++) {
    const value = arr[base + g];
    if (value > out[g]) out[g] = value;
  }
}

function queryGroupScoreRange(pyramid, groupScores, groupCount, firstFrame, lastFrame, out) {
  const levels = pyramid?.baseScores === groupScores ? pyramid.levels : null;
  visitPyramidRange(levels?.length || 0, firstFrame, lastFrame, (lvlIdx, index) => {
    mergeScoreSlot(lvlIdx < 0 ? groupScores : levels[lvlIdx].scores, index, groupCount, out);
  });
}

function bridgedGapScore(groupScores, groupCount, maxSearchFrame, firstFrame, lastFrame, groupIndex, threshold, maxGapFrames) {
  const leftMin = Math.max(0, lastFrame - maxGapFrames - 1);
  let leftIdx = -1;
  let leftScore = 0;
  for (let f = firstFrame - 1; f >= leftMin; f--) {
    const value = groupScores[f * groupCount + groupIndex];
    if (value >= threshold) {
      leftIdx = f;
      leftScore = value;
      break;
    }
  }
  if (leftIdx < 0) return 0;

  const rightMax = Math.min(maxSearchFrame - 1, leftIdx + maxGapFrames + 1);
  for (let f = lastFrame; f <= rightMax; f++) {
    const value = groupScores[f * groupCount + groupIndex];
    if (value >= threshold) {
      return Math.min(leftScore, value);
    }
  }
  return 0;
}

function normalizeScoreTimeline(scoreTimeline) {
  if (!scoreTimeline?.groupScores || !(scoreTimeline.groupScoreFrames > 0)) return null;
  return {
    groupScores: scoreTimeline.groupScores,
    groupScoreFrames: scoreTimeline.groupScoreFrames,
    groupScorePyramid: scoreTimeline.groupScorePyramid || null,
    groupCount: scoreTimeline.groupCount || DISPLAY_GROUPS.length,
    frameSeconds: scoreTimeline.frameSeconds || 0.04,
    audioOffset: scoreTimeline.audioOffset ?? 0,
    audioDuration: scoreTimeline.audioDuration,
  };
}

/** Project session frame-level display group scores onto video-time columns using per-column max preservation. */
export function groupScoreColumns(scoreTimeline, start, end, width, { threshold = DEFAULT_DISPLAY_THRESHOLD, gapBridgeMs = 0 } = {}) {
  const columns = new Array(Math.max(0, width)).fill(null);
  const timeline = normalizeScoreTimeline(scoreTimeline);
  if (!timeline || !(end > start) || !(width > 0)) {
    return columns;
  }
  const {
    groupScores,
    groupScoreFrames,
    groupScorePyramid,
    groupCount,
    frameSeconds,
    audioOffset,
    audioDuration,
  } = timeline;
  const maxAudio = groupScoreFrames * frameSeconds;
  const audioLimit = Number.isFinite(audioDuration) ? Math.min(audioDuration, maxAudio) : maxAudio;
  const maxSearchFrame = Math.min(groupScoreFrames, Math.ceil(audioLimit / frameSeconds - 1e-9));
  const maxGapFrames = gapBridgeMs > 0 ? Math.floor(gapBridgeMs / 1000 / frameSeconds + 1e-9) : 0;
  const span = end - start;

  for (let x = 0; x < width; x++) {
    const audioStart = start + (x / width) * span - audioOffset;
    const audioEnd = start + ((x + 1) / width) * span - audioOffset;
    if (audioEnd <= 0 || audioStart >= audioLimit) continue;

    const clampedStart = Math.max(0, audioStart);
    const clampedEnd = Math.min(audioLimit, audioEnd);
    if (!(clampedEnd > clampedStart)) continue;

    const firstFrame = Math.max(0, Math.floor(clampedStart / frameSeconds + 1e-9));
    const lastFrame = Math.min(groupScoreFrames, Math.ceil(clampedEnd / frameSeconds - 1e-9));
    if (lastFrame <= firstFrame) continue;

    const columnMax = new Float32Array(groupCount);
    queryGroupScoreRange(groupScorePyramid, groupScores, groupCount, firstFrame, lastFrame, columnMax);
    if (maxGapFrames > 0 && lastFrame - firstFrame <= maxGapFrames) {
      for (let g = 0; g < groupCount; g++) {
        if (columnMax[g] < threshold) {
          const bridged = bridgedGapScore(groupScores, groupCount, maxSearchFrame, firstFrame, lastFrame, g, threshold, maxGapFrames);
          if (bridged >= threshold) columnMax[g] = bridged;
        }
      }
    }
    columns[x] = columnMax;
  }
  return columns;
}

function isGroupEnabled(enabledGroups, groupId) {
  if (!enabledGroups) return true;
  if (typeof enabledGroups.has === 'function') return enabledGroups.has(groupId);
  if (Array.isArray(enabledGroups)) return enabledGroups.includes(groupId);
  return Boolean(enabledGroups[groupId]);
}

function independentLayer(group, score, waveHeight, waveTop, canvasHeight, usableHeight, minOverlayPx, minTopPx) {
  const scaled = Math.round(score * waveHeight);
  const height = group.anchor === 'top'
    ? Math.min(usableHeight, Math.max(Math.min(usableHeight, minTopPx), scaled))
    : Math.min(waveHeight, Math.max(minOverlayPx, scaled));
  return {
    id: group.id,
    color: group.color,
    alpha: group.alpha,
    anchor: group.anchor,
    score,
    y: group.anchor === 'top' ? Math.min(waveTop, canvasHeight - height) : canvasHeight - height,
    height,
  };
}

/** Build per-column waveform contours and non-softmax independent foreground layers across the 3 display states. */
export function layeredWaveColumns({
  wave,
  scoreTimeline = null,
  start,
  end,
  width,
  canvasHeight,
  pad = 8,
  minBar = 1,
  minGunshotPx = Math.max(1, Math.round(minBar * DEFAULT_MIN_GUNSHOT_PX)),
  threshold = DEFAULT_DISPLAY_THRESHOLD,
  gapBridgeMs = DEFAULT_GAP_BRIDGE_MS,
  enabledGroups = null,
  smooth = false,
}) {
  const rawPeaks = waveformColumns(wave, start, end, width);
  const peaks = smooth ? smoothWavePeaks(rawPeaks) : rawPeaks;
  const scoreCols = groupScoreColumns(scoreTimeline, start, end, width, { threshold, gapBridgeMs });
  const usableHeight = Math.max(0, canvasHeight - pad);
  const minOverlayPx = Math.max(1, Math.round(minBar));

  return peaks.map((peak, x) => {
    if (peak === null) {
      return { state: 'unanalyzed', waveTop: null, waveHeight: 0, layers: [] };
    }
    const amplitude = smooth ? Math.pow(peak, 0.56) * 0.92 : Math.sqrt(peak);
    const waveHeight = Math.max(minBar, Math.round(amplitude * usableHeight));
    const waveTop = canvasHeight - waveHeight;
    const scores = scoreCols[x];
    const layers = [];

    if (scores) {
      for (const index of NON_GUNSHOT_ORDER) {
        const group = DISPLAY_GROUPS[index];
        const score = scores[index];
        if (isGroupEnabled(enabledGroups, group.id) && score >= threshold) {
          layers.push(independentLayer(group, score, waveHeight, waveTop, canvasHeight, usableHeight, minOverlayPx, minOverlayPx));
        }
      }
      const gunshot = DISPLAY_GROUPS[0];
      const gunshotScore = scores[0];
      if (isGroupEnabled(enabledGroups, gunshot.id) && gunshotScore >= threshold) {
        layers.push(independentLayer(gunshot, gunshotScore, waveHeight, waveTop, canvasHeight, usableHeight, minOverlayPx, minGunshotPx));
      }
    }

    return {
      state: layers.length > 0 ? 'active' : 'neutral',
      waveTop,
      waveHeight,
      layers,
    };
  });
}

/** Look up raw 5-group prediction scores at a source video timestamp using audioOffset without threshold filtering. */
export function groupScoresAtTime(scoreTimeline, videoTime) {
  const timeline = normalizeScoreTimeline(scoreTimeline);
  if (!timeline || !Number.isFinite(videoTime)) {
    return { status: 'unanalyzed', videoTime, audioTime: null, frameIndex: null, scores: null };
  }
  const {
    groupScores,
    groupScoreFrames,
    groupCount,
    frameSeconds,
    audioOffset,
    audioDuration,
  } = timeline;
  const audioTime = videoTime - audioOffset;
  const maxAnalyzedAudio = groupScoreFrames * frameSeconds;
  const limit = Number.isFinite(audioDuration) ? audioDuration : maxAnalyzedAudio;
  if (audioTime < 0 || audioTime >= limit) {
    return { status: 'out-of-range', videoTime, audioTime, frameIndex: null, scores: null };
  }
  if (audioTime >= maxAnalyzedAudio) {
    return { status: 'unanalyzed', videoTime, audioTime, frameIndex: null, scores: null };
  }
  const frameIndex = Math.min(groupScoreFrames - 1, Math.max(0, Math.floor(audioTime / frameSeconds + 1e-9)));
  const start = frameIndex * groupCount;
  const scores = groupScores.slice(start, start + groupCount);
  return { status: 'ok', videoTime, audioTime, frameIndex, scores };
}

/** Build full-recording [0, duration] overview gunshot distribution columns using peak-preserving pyramid slices. */
export function overviewDistributionColumns({
  wave = null,
  scoreTimeline = null,
  duration,
  width,
  canvasHeight,
  pad = 2,
  minBar = 1,
  threshold = DEFAULT_DISPLAY_THRESHOLD,
  gapBridgeMs = DEFAULT_GAP_BRIDGE_MS,
  enabledGroups = null,
  smooth = false,
}) {
  const count = Math.max(0, width);
  if (!(duration > 0) || !(count > 0)) return [];
  const rawPeaks = waveformColumns(wave, 0, duration, count);
  const peaks = smooth ? smoothWavePeaks(rawPeaks) : rawPeaks;
  const scoreCols = groupScoreColumns(scoreTimeline, 0, duration, count, { threshold, gapBridgeMs });
  const usableHeight = Math.max(0, canvasHeight - pad);
  const minGunshotPx = Math.max(2, Math.round(minBar) * 2);
  const gunshotEnabled = isGroupEnabled(enabledGroups, DISPLAY_GROUPS[0].id);

  return Array.from({ length: count }, (_, x) => {
    const peak = peaks[x];
    const scores = scoreCols[x];
    if (peak === null && !scores) {
      return { state: 'unanalyzed', waveTop: null, waveHeight: 0, gunshotScore: 0, gunshotHeight: 0, gunshotY: null };
    }
    const amplitude = peak === null ? 0 : (smooth ? Math.pow(peak, 0.56) * 0.92 : Math.sqrt(peak));
    const waveHeight = peak === null ? 0 : Math.max(minBar, Math.round(amplitude * usableHeight));
    const waveTop = peak === null ? null : canvasHeight - waveHeight;
    const gunshotScore = scores ? scores[0] : 0;
    const gunshotActive = gunshotEnabled && gunshotScore >= threshold;
    const gunshotHeight = gunshotActive
      ? Math.min(usableHeight, Math.max(minGunshotPx, Math.round(gunshotScore * usableHeight)))
      : 0;
    return {
      state: gunshotActive ? 'active' : 'neutral',
      waveTop,
      waveHeight,
      gunshotScore,
      gunshotHeight,
      gunshotY: gunshotActive ? canvasHeight - gunshotHeight : null,
    };
  });
}

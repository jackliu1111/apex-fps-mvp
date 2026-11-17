import { waveformColumns } from './audio-peaks.mjs';
import { DISPLAY_GROUPS } from './lab-display-groups.mjs';
import { buildLevelDescriptors, propagatePyramidRange, selectPyramidLevel, visitPyramidRange } from './pyramid-cache.mjs';

export const DEFAULT_DISPLAY_THRESHOLD = 0.2;

const NON_GUNSHOT_ORDER = Object.freeze([1, 2, 3, 4]);

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

/** Select the score pyramid zoom level matching secondsPerColumn. */
export function selectScoreLevel(pyramid, secondsPerColumn) {
  if (!pyramid) return null;
  return selectPyramidLevel(pyramid.levels, pyramid.frameSeconds, pyramid.totalFrames, secondsPerColumn);
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

/** Project session frame-level display group scores onto video-time columns using per-column max preservation. */
export function groupScoreColumns(scoreData, start, end, width) {
  const columns = new Array(Math.max(0, width)).fill(null);
  if (!scoreData || !scoreData.groupScores || !(scoreData.groupScoreFrames > 0) || !(end > start) || !(width > 0)) {
    return columns;
  }
  const {
    groupScores,
    groupScoreFrames,
    groupScorePyramid = null,
    groupCount = DISPLAY_GROUPS.length,
    frameSeconds = 0.04,
    audioOffset = 0,
    audioDuration,
  } = scoreData;
  const maxAudio = groupScoreFrames * frameSeconds;
  const audioLimit = Number.isFinite(audioDuration) ? Math.min(audioDuration, maxAudio) : maxAudio;
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

function independentLayer(group, score, waveHeight, waveTop, canvasHeight, minOverlayPx) {
  const height = Math.min(waveHeight, Math.max(minOverlayPx, Math.round(score * waveHeight)));
  return {
    id: group.id,
    color: group.color,
    alpha: group.alpha,
    anchor: group.anchor,
    score,
    y: group.anchor === 'top' ? waveTop : canvasHeight - height,
    height,
  };
}

/** Build per-column waveform contours and non-softmax independent foreground layers across the 3 display states. */
export function layeredWaveColumns({
  wave,
  scoreData = null,
  start,
  end,
  width,
  canvasHeight,
  pad = 8,
  minBar = 1,
  threshold = DEFAULT_DISPLAY_THRESHOLD,
  enabledGroups = null,
}) {
  const peaks = waveformColumns(wave, start, end, width);
  const scoreCols = groupScoreColumns(scoreData, start, end, width);
  const usableHeight = Math.max(0, canvasHeight - pad);
  const minOverlayPx = Math.max(1, Math.round(minBar));

  return peaks.map((peak, x) => {
    if (peak === null) {
      return { state: 'unanalyzed', waveTop: null, waveHeight: 0, layers: [] };
    }
    const waveHeight = Math.max(minBar, Math.round(Math.sqrt(peak) * usableHeight));
    const waveTop = canvasHeight - waveHeight;
    const scores = scoreCols[x];
    const layers = [];

    if (scores) {
      for (const index of NON_GUNSHOT_ORDER) {
        const group = DISPLAY_GROUPS[index];
        const score = scores[index];
        if (isGroupEnabled(enabledGroups, group.id) && score >= threshold) {
          layers.push(independentLayer(group, score, waveHeight, waveTop, canvasHeight, minOverlayPx));
        }
      }
      const gunshot = DISPLAY_GROUPS[0];
      const gunshotScore = scores[0];
      if (isGroupEnabled(enabledGroups, gunshot.id) && gunshotScore >= threshold) {
        layers.push(independentLayer(gunshot, gunshotScore, waveHeight, waveTop, canvasHeight, minOverlayPx));
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
export function groupScoresAtTime(scoreData, videoTime) {
  if (!scoreData || !scoreData.groupScores || !(scoreData.groupScoreFrames > 0) || !Number.isFinite(videoTime)) {
    return { status: 'unanalyzed', videoTime, audioTime: null, frameIndex: null, scores: null };
  }
  const {
    groupScores,
    groupScoreFrames,
    groupCount = DISPLAY_GROUPS.length,
    frameSeconds = 0.04,
    audioOffset = 0,
    audioDuration,
  } = scoreData;
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
  scoreData = null,
  duration,
  width,
  canvasHeight,
  pad = 2,
  minBar = 1,
  threshold = DEFAULT_DISPLAY_THRESHOLD,
  enabledGroups = null,
}) {
  const count = Math.max(0, width);
  if (!(duration > 0) || !(count > 0)) return [];
  const peaks = waveformColumns(wave, 0, duration, count);
  const scoreCols = groupScoreColumns(scoreData, 0, duration, count);
  const usableHeight = Math.max(0, canvasHeight - pad);
  const minGunshotPx = Math.max(2, Math.round(minBar) * 2);
  const gunshotEnabled = isGroupEnabled(enabledGroups, DISPLAY_GROUPS[0].id);

  return Array.from({ length: count }, (_, x) => {
    const peak = peaks[x];
    const scores = scoreCols[x];
    if (peak === null && !scores) {
      return { state: 'unanalyzed', waveTop: null, waveHeight: 0, gunshotScore: 0, gunshotHeight: 0, gunshotY: null };
    }
    const waveHeight = peak === null ? 0 : Math.max(minBar, Math.round(Math.sqrt(peak) * usableHeight));
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

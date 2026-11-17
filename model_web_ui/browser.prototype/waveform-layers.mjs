import { waveformColumns } from './audio-peaks.mjs';
import { DISPLAY_GROUPS } from './lab-display-groups.mjs';

export const DEFAULT_DISPLAY_THRESHOLD = 0.2;

const NON_GUNSHOT_ORDER = Object.freeze([1, 2, 3, 4]);

/** Project session frame-level display group scores onto video-time columns using per-column max preservation. */
export function groupScoreColumns(scoreData, start, end, width) {
  const columns = new Array(Math.max(0, width)).fill(null);
  if (!scoreData || !scoreData.groupScores || !(scoreData.groupScoreFrames > 0) || !(end > start) || !(width > 0)) {
    return columns;
  }
  const {
    groupScores,
    groupScoreFrames,
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
    for (let frame = firstFrame; frame < lastFrame; frame++) {
      const base = frame * groupCount;
      for (let g = 0; g < groupCount; g++) {
        const value = groupScores[base + g];
        if (value > columnMax[g]) columnMax[g] = value;
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

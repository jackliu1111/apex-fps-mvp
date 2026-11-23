import { CANDIDATE_PADDING_SECONDS, CANDIDATE_GAP_SECONDS, mergeCandidateRanges } from './candidate-ranges.mjs';
import { ENVELOPE_STEP_SECONDS } from './audio-aligner.mjs';
import { DISPLAY_GROUPS } from './lab-display-groups.mjs';

const MAX_HISTORY_SECONDS = 3600; // 60 minutes rolling lightweight history
const LIVE_SCORE_FRAME_SECONDS = 0.2; // 200 ms display score grid for smooth layered live waveform

/**
 * Live Companion Session state machine (Wall-Clock coordinates).
 * Strictly isolated from review-workspace.mjs (Media-Time coordinates).
 * Retains 60 min of lightweight history so multiple overlapping instant replays
 * can independently slice and conform without consuming or erasing history.
 */
export function createLiveSession({
  windowSeconds = 120,
  threshold = 0.2,
  maxHistorySeconds = MAX_HISTORY_SECONDS,
  onChange = () => {},
} = {}) {
  let active = false;
  let sourceKind = null; // 'display' | 'device' | 'simulated'
  let startEpochMs = 0;
  let envStepSeconds = ENVELOPE_STEP_SECONDS;
  let envPeaks = [];
  let envRms = [];
  let scoreWindows = []; // { wallStartMs, wallEndMs, scores: [gunshot, machineGun], maxScore }
  let decisions = [];    // { id, kind: 'retain' | 'exclude', wallStartMs, wallEndMs, note, thumbnail }
  let conformed = [];    // { id, name, file, duration, alignment, windowScores, waveform, liveDecisions, wallStartMs, wallEndMs }
  let gateActive = false;
  let gateReason = null;
  let allowGateBypass = false;
  let silentSeconds = 0;
  let decisionSeq = 0;
  let proxyWindowSeconds = Math.max(60, Math.min(300, windowSeconds));
  let detectThreshold = threshold;

  const emit = () => onChange(session.snapshot());

  function trimHistory(latestEpochMs) {
    const cutoffMs = latestEpochMs - maxHistorySeconds * 1000;
    if (startEpochMs > 0 && cutoffMs > startEpochMs) {
      const dropBuckets = Math.floor((cutoffMs - startEpochMs) / (envStepSeconds * 1000));
      if (dropBuckets > 0) {
        envPeaks = envPeaks.slice(dropBuckets);
        envRms = envRms.slice(dropBuckets);
        startEpochMs += dropBuckets * envStepSeconds * 1000;
      }
    }
    scoreWindows = scoreWindows.filter((w) => w.wallEndMs >= cutoffMs);
    decisions = decisions.filter((d) => d.wallEndMs >= cutoffMs);
  }

  function computeLiveCandidates() {
    const raw = [];
    for (const win of scoreWindows) {
      if (Math.max(...win.scores) > detectThreshold) {
        const startSec = (win.wallStartMs - startEpochMs) / 1000 - CANDIDATE_PADDING_SECONDS;
        const endSec = (win.wallEndMs - startEpochMs) / 1000 + CANDIDATE_PADDING_SECONDS;
        raw.push({
          key: `live-${win.wallStartMs}`,
          start: Math.max(0, startSec),
          end: Math.max(0.5, endSec),
          provisional: false,
          maxScore: Math.max(...win.scores),
        });
      }
    }
    const merged = mergeCandidateRanges(raw);
    return merged.map((range) => {
      const wallStartMs = startEpochMs + range.start * 1000;
      const wallEndMs = startEpochMs + range.end * 1000;
      const excluded = decisions.some((d) => d.kind === 'exclude' && d.wallStartMs < wallEndMs && wallStartMs < d.wallEndMs);
      return {
        id: `live-cand:${Math.round(wallStartMs)}:${Math.round(wallEndMs)}`,
        wallStartMs,
        wallEndMs,
        startSec: range.start,
        endSec: range.end,
        excluded,
      };
    });
  }

  const session = {
    start({ kind = 'display', nowMs = Date.now(), windowSec } = {}) {
      active = true;
      sourceKind = kind;
      startEpochMs = nowMs;
      envPeaks = [];
      envRms = [];
      scoreWindows = [];
      decisions = [];
      gateActive = false;
      gateReason = null;
      allowGateBypass = false;
      silentSeconds = 0;
      if (windowSec) proxyWindowSeconds = Math.max(60, Math.min(300, windowSec));
      emit();
    },
    stop() {
      active = false;
      gateActive = false;
      gateReason = null;
      emit();
    },
    setWindowSeconds(seconds) {
      proxyWindowSeconds = Math.max(60, Math.min(300, Number(seconds) || 120));
      emit();
    },
    setThreshold(next) {
      if (!Number.isFinite(next) || next < 0 || next > 1) return;
      detectThreshold = next;
      emit();
    },
    setPlaybackGate(isPlayingUnmuted, reason = '回放中 · 实时监听已暂停') {
      if (sourceKind === 'device' && allowGateBypass) {
        gateActive = false;
        gateReason = null;
      } else {
        gateActive = !!isPlayingUnmuted;
        gateReason = gateActive ? reason : null;
      }
      emit();
    },
    setAllowGateBypass(allow) {
      if (sourceKind !== 'device') return false;
      allowGateBypass = !!allow;
      if (allowGateBypass) { gateActive = false; gateReason = null; }
      emit();
      return true;
    },
    pushEnvelope(interleavedPeakRms, latestSilentSeconds = 0, nowMs = Date.now()) {
      if (!active || gateActive) return;
      if (!startEpochMs) startEpochMs = nowMs;
      for (let i = 0; i + 1 < interleavedPeakRms.length; i += 2) {
        envPeaks.push(interleavedPeakRms[i]);
        envRms.push(interleavedPeakRms[i + 1]);
      }
      silentSeconds = latestSilentSeconds;
      trimHistory(startEpochMs + envPeaks.length * envStepSeconds * 1000);
      emit();
    },
    pushScoreWindow({ wallStartMs, wallEndMs, scores, groupScores = null, frameGroupScores = null, frameSeconds = 0.04, thumbnail = null }) {
      if (!active || gateActive) return null;
      const maxScore = Math.max(...scores);
      const resolvedGroups = groupScores
        ? Array.from(groupScores, (v) => Number(v) || 0)
        : [maxScore, 0, 0, 0];
      const entry = {
        wallStartMs,
        wallEndMs,
        scores: [...scores],
        groupScores: resolvedGroups,
        frameGroupScores: frameGroupScores ? Float32Array.from(frameGroupScores) : null,
        frameSeconds,
        maxScore,
        thumbnail,
      };
      scoreWindows.push(entry);
      trimHistory(wallEndMs);
      emit();
      return entry;
    },
    addMark({ wallStartMs, wallEndMs, note = '', thumbnail = null }) {
      const dec = {
        id: `live-dec:${++decisionSeq}`,
        kind: 'retain',
        wallStartMs,
        wallEndMs: Math.max(wallStartMs + 1000, wallEndMs),
        note,
        thumbnail,
      };
      decisions.push(dec);
      emit();
      return dec;
    },
    excludeRange({ wallStartMs, wallEndMs }) {
      const dec = {
        id: `live-dec:${++decisionSeq}`,
        kind: 'exclude',
        wallStartMs,
        wallEndMs: Math.max(wallStartMs + 500, wallEndMs),
      };
      decisions.push(dec);
      emit();
      return dec;
    },
    removeDecision(id) {
      const idx = decisions.findIndex((d) => d.id === id);
      if (idx < 0) return false;
      decisions.splice(idx, 1);
      conformed = conformed.map(master => {
        const remaining = master.liveDecisions.filter(mark => mark.id !== id);
        return remaining.length === master.liveDecisions.length ? master : { ...master, liveDecisions: remaining };
      });
      emit();
      return true;
    },
    getConformed(id) {
      return conformed.find(master => master.id === id);
    },
    registerConformed(record) {
      // Alignment took a snapshot before asynchronous media reads. A mark may have been undone since then.
      const currentIds = new Set(decisions.map(mark => mark.id));
      const item = {
        id: record.id || `conform:${crypto.randomUUID()}`,
        name: record.name,
        file: record.file,
        duration: record.duration,
        alignment: record.alignment,
        windowScores: record.windowScores,
        waveform: record.waveform,
        scoreTimeline: record.scoreTimeline || null,
        liveDecisions: (record.liveDecisions || []).filter(mark => currentIds.has(mark.id)),
        wallStartMs: record.alignment.masterStartEpochMs,
        wallEndMs: record.alignment.masterStartEpochMs + record.duration * 1000,
        createdAt: Date.now(),
      };
      conformed.unshift(item);
      emit();
      return item;
    },
    getHistoryForAlignment() {
      return {
        startEpochMs,
        envStepSeconds,
        envPeaks: Float32Array.from(envPeaks),
        envRms: Float32Array.from(envRms),
        scoreWindows: scoreWindows.map((w) => ({
          ...w,
          scores: [...w.scores],
          groupScores: w.groupScores ? [...w.groupScores] : [w.maxScore, 0, 0, 0],
          frameGroupScores: w.frameGroupScores ? Float32Array.from(w.frameGroupScores) : null,
        })),
        decisions: decisions.map((d) => ({ ...d })),
      };
    },
    /**
     * Project the rolling live window [end - visibleSec, end] into standard
     * `{ wave, scoreTimeline, duration }` structures directly consumable by
     * waveform-layers.mjs and waveform-renderer.mjs.
     */
    toWaveformView(requestedSpanSec = proxyWindowSeconds) {
      const durationSec = envPeaks.length * envStepSeconds;
      const visibleSec = Math.max(10, Math.min(Math.max(30, durationSec), requestedSpanSec));
      const endEpochMs = startEpochMs + durationSec * 1000;
      const windowStartMs = endEpochMs - visibleSec * 1000;
      const step = envStepSeconds;
      const bucketCount = Math.max(1, Math.ceil(visibleSec / step));
      const peaks = new Array(bucketCount).fill(null);

      if (envPeaks.length > 0 && startEpochMs > 0) {
        const stepMs = step * 1000;
        const firstSrc = Math.max(0, Math.floor((windowStartMs - startEpochMs) / stepMs));
        for (let i = firstSrc; i < envPeaks.length; i++) {
          const wallMs = startEpochMs + i * stepMs;
          const dst = Math.floor((wallMs - windowStartMs) / stepMs);
          if (dst >= 0 && dst < bucketCount) {
            peaks[dst] = Math.max(peaks[dst] ?? 0, Math.min(1, envPeaks[i]));
          }
        }
      }

      const groupCount = DISPLAY_GROUPS.length;
      const frameSec = LIVE_SCORE_FRAME_SECONDS;
      const totalFrames = Math.max(1, Math.ceil(visibleSec / frameSec));
      const groupScores = new Float32Array(totalFrames * groupCount);
      let analyzedFrames = 0;

      for (const sw of scoreWindows) {
        if (sw.wallEndMs <= windowStartMs || sw.wallStartMs >= endEpochMs) continue;
        if (sw.frameGroupScores && sw.frameGroupScores.length >= groupCount) {
          const srcFrames = Math.floor(sw.frameGroupScores.length / groupCount);
          const srcStepMs = (sw.frameSeconds || 0.04) * 1000;
          for (let f = 0; f < srcFrames; f++) {
            const tMs = sw.wallStartMs + f * srcStepMs;
            const dstF = Math.floor((tMs - windowStartMs) / (frameSec * 1000));
            if (dstF < 0 || dstF >= totalFrames) continue;
            if (dstF + 1 > analyzedFrames) analyzedFrames = dstF + 1;
            const dstBase = dstF * groupCount;
            const srcBase = f * groupCount;
            for (let g = 0; g < groupCount; g++) {
              const v = sw.frameGroupScores[srcBase + g];
              if (v > groupScores[dstBase + g]) groupScores[dstBase + g] = v;
            }
          }
        } else {
          const fStart = Math.max(0, Math.floor((sw.wallStartMs - windowStartMs) / (frameSec * 1000)));
          const fEnd = Math.min(totalFrames, Math.ceil((sw.wallEndMs - windowStartMs) / (frameSec * 1000)));
          if (fEnd > analyzedFrames) analyzedFrames = fEnd;
          const gs = sw.groupScores || [sw.maxScore, 0, 0, 0];
          for (let f = fStart; f < fEnd; f++) {
            const base = f * groupCount;
            for (let g = 0; g < groupCount; g++) {
              if (gs[g] > groupScores[base + g]) groupScores[base + g] = gs[g];
            }
          }
        }
      }

      return {
        startEpochMs: windowStartMs,
        endEpochMs,
        duration: visibleSec,
        elapsedSec: durationSec,
        wave: { version: 1, step, peaks, decodedUntil: Math.min(visibleSec, durationSec), trackIndex: 0 },
        scoreTimeline: analyzedFrames > 0
          ? {
              groupScores,
              groupScoreFrames: analyzedFrames,
              groupCount,
              frameSeconds: frameSec,
              audioOffset: 0,
              audioDuration: visibleSec,
            }
          : null,
      };
    },
    snapshot() {
      const durationSec = envPeaks.length * envStepSeconds;
      const latestEpochMs = startEpochMs + durationSec * 1000;
      return {
        active,
        sourceKind,
        startEpochMs,
        latestEpochMs,
        durationSec,
        proxyWindowSeconds,
        threshold: detectThreshold,
        envStepSeconds,
        envPeaks,
        scoreWindows,
        candidates: computeLiveCandidates(),
        decisions: decisions.map((d) => ({ ...d })),
        conformed: [...conformed],
        gateActive,
        gateReason,
        allowGateBypass,
        silentSeconds,
      };
    },
  };
  return session;
}

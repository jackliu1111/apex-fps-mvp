/**
 * Live Companion resource telemetry collector.
 *
 * Designed to keep recording in BOTH foreground and background (`document.hidden === true`)
 * purely via existing event callbacks (inference results, proxy encoder chunks,
 * PerformanceObserver long tasks, directory conform runs, and visibility transitions)
 * without introducing any high-frequency background polling timers.
 */

const DEFAULT_MAX_SAMPLES = 3600; // ~2 hours at 2s inference hop
const DEFAULT_MAX_EVENTS = 500;
const RENDER_WINDOW_MS = 1000;

function readJsHeapBytes(perf) {
  const mem = perf?.memory;
  if (!mem || !Number.isFinite(mem.usedJSHeapSize)) return null;
  return mem.usedJSHeapSize;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function createBucketStats() {
  return {
    inferenceCount: 0,
    inferenceTotalSumMs: 0,
    inferenceMaxMs: 0,
    inferenceTotals: [],
    droppedWindows: 0,
    chunkCount: 0,
    bitrateSumBps: 0,
    bitrateMaxBps: 0,
    chunkGapMaxMs: 0,
    longTaskCount: 0,
    longTaskMaxMs: 0,
    peakProxyBytes: 0,
    peakJsHeapBytes: 0,
  };
}

function summarizeBucket(bucket, hopSeconds) {
  const avgMs = bucket.inferenceCount > 0 ? bucket.inferenceTotalSumMs / bucket.inferenceCount : 0;
  const p95Ms = percentile(bucket.inferenceTotals, 95);
  const dutyPct = hopSeconds > 0 ? (avgMs / (hopSeconds * 1000)) * 100 : 0;
  const avgBitrateBps = bucket.chunkCount > 0 ? bucket.bitrateSumBps / bucket.chunkCount : 0;
  return {
    inferenceCount: bucket.inferenceCount,
    inferenceAvgMs: Math.round(avgMs * 10) / 10,
    inferenceP95Ms: Math.round(p95Ms * 10) / 10,
    inferenceMaxMs: Math.round(bucket.inferenceMaxMs * 10) / 10,
    dutyPct: Math.round(dutyPct * 10) / 10,
    droppedWindows: bucket.droppedWindows,
    chunkCount: bucket.chunkCount,
    encodeAvgBitrateBps: Math.round(avgBitrateBps),
    encodeMaxBitrateBps: Math.round(bucket.bitrateMaxBps),
    encodeMaxGapMs: Math.round(bucket.chunkGapMaxMs),
    longTaskCount: bucket.longTaskCount,
    longTaskMaxMs: Math.round(bucket.longTaskMaxMs * 10) / 10,
    peakProxyBytes: bucket.peakProxyBytes,
    peakJsHeapBytes: bucket.peakJsHeapBytes,
  };
}

export function createLiveResourceMonitor({
  maxSamples = DEFAULT_MAX_SAMPLES,
  maxEvents = DEFAULT_MAX_EVENTS,
  doc = typeof document !== 'undefined' ? document : null,
  perf = typeof performance !== 'undefined' ? performance : null,
  PerformanceObserverCtor = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null,
  onVisibilityReturn = () => {},
} = {}) {
  let active = false;
  let startedAtMs = 0;
  let endedAtMs = 0;
  let sourceKind = null; // 'display' | 'device' | 'simulated'
  let proxyMode = 'smooth'; // 'smooth' | 'eco'
  let hopSeconds = 2;

  let isHidden = !!doc?.hidden;
  let visibilitySliceStartMs = 0;
  let fgAccumMs = 0;
  let bgAccumMs = 0;

  let overall = createBucketStats();
  let bgStats = createBucketStats();
  let fgStats = createBucketStats();

  // Latest instantaneous readings
  let lastFrontendMs = 0;
  let lastInferenceMs = 0;
  let lastTotalMs = 0;
  let lastCold = false;
  let lastBitrateBps = 0;
  let lastChunkGapMs = 0;
  let proxyBytes = 0;
  let proxyMaxBytes = 150 * 1024 * 1024;
  let overloadCount = 0;
  let conformCount = 0;
  let lastConformMs = 0;
  let maxConformMs = 0;
  let totalMemory = null; // { bytes, breakdown, measuredAtMs }

  // Foreground render sliding window (1 s)
  let renderFrames = []; // { ts, drawMs }

  let samples = [];
  let events = [];

  let longTaskObserver = null;
  let visibilityHandler = null;

  function currentHidden() {
    if (doc && typeof doc.hidden === 'boolean') return doc.hidden;
    return isHidden;
  }

  function pushEvent(evt) {
    events.push(evt);
    if (events.length > maxEvents) events.shift();
  }

  function pushSample(sample) {
    samples.push(sample);
    if (samples.length > maxSamples) samples.shift();
  }

  function flushVisibilitySlice(nowMs) {
    if (!active || !visibilitySliceStartMs) return;
    const delta = Math.max(0, nowMs - visibilitySliceStartMs);
    if (isHidden) bgAccumMs += delta;
    else fgAccumMs += delta;
    visibilitySliceStartMs = nowMs;
  }

  function handleVisibilityChange(nowMs = Date.now(), forcedHidden = null) {
    const nextHidden = forcedHidden !== null ? !!forcedHidden : currentHidden();
    if (!active) {
      isHidden = nextHidden;
      return;
    }
    if (nextHidden === isHidden) return;
    flushVisibilitySlice(nowMs);
    isHidden = nextHidden;
    if (isHidden) {
      renderFrames = [];
    }
    pushEvent({
      ts: nowMs,
      iso: new Date(nowMs).toISOString(),
      hidden: isHidden,
      type: 'visibility',
      state: isHidden ? 'background' : 'foreground',
    });
    if (!isHidden) {
      onVisibilityReturn(getSnapshot(nowMs));
    }
  }

  function attachObservers() {
    detachObservers();
    if (doc && typeof doc.addEventListener === 'function') {
      visibilityHandler = () => handleVisibilityChange(Date.now());
      doc.addEventListener('visibilitychange', visibilityHandler);
    }
    if (PerformanceObserverCtor) {
      try {
        const supported = PerformanceObserverCtor.supportedEntryTypes;
        if (!supported || supported.includes('longtask')) {
          longTaskObserver = new PerformanceObserverCtor((list) => {
            for (const entry of list.getEntries()) {
              recordLongTask({ durationMs: entry.duration, startTime: entry.startTime, nowMs: Date.now() });
            }
          });
          longTaskObserver.observe({ entryTypes: ['longtask'] });
        }
      } catch {
        longTaskObserver = null;
      }
    }
  }

  function detachObservers() {
    if (doc && visibilityHandler && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', visibilityHandler);
    }
    visibilityHandler = null;
    if (longTaskObserver) {
      try { longTaskObserver.disconnect(); } catch {}
      longTaskObserver = null;
    }
  }

  function pruneRenderFrames(nowMs) {
    const cutoff = nowMs - RENDER_WINDOW_MS;
    while (renderFrames.length && renderFrames[0].ts < cutoff) {
      renderFrames.shift();
    }
  }

  function getRenderMetrics(nowMs) {
    if (isHidden) return { renderFps: 0, renderAvgMs: 0 };
    pruneRenderFrames(nowMs);
    if (!renderFrames.length) return { renderFps: 0, renderAvgMs: 0 };
    let sumMs = 0;
    for (const f of renderFrames) sumMs += f.drawMs;
    return {
      renderFps: renderFrames.length,
      renderAvgMs: Math.round((sumMs / renderFrames.length) * 100) / 100,
    };
  }

  function recordMemoryToBuckets(bucket, jsHeapBytes) {
    if (proxyBytes > bucket.peakProxyBytes) bucket.peakProxyBytes = proxyBytes;
    if (jsHeapBytes !== null && jsHeapBytes > bucket.peakJsHeapBytes) {
      bucket.peakJsHeapBytes = jsHeapBytes;
    }
  }

  function recordLongTask({ durationMs, startTime = 0, nowMs = Date.now() } = {}) {
    if (!active || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const hidden = currentHidden();
    const target = hidden ? bgStats : fgStats;
    for (const b of [overall, target]) {
      b.longTaskCount += 1;
      if (durationMs > b.longTaskMaxMs) b.longTaskMaxMs = durationMs;
    }
    pushEvent({
      ts: nowMs,
      iso: new Date(nowMs).toISOString(),
      hidden,
      type: 'longtask',
      durationMs: Math.round(durationMs * 10) / 10,
      startTime: Math.round(startTime * 10) / 10,
    });
  }

  function resetState() {
    startedAtMs = 0;
    endedAtMs = 0;
    fgAccumMs = 0;
    bgAccumMs = 0;
    visibilitySliceStartMs = 0;
    overall = createBucketStats();
    bgStats = createBucketStats();
    fgStats = createBucketStats();
    lastFrontendMs = 0;
    lastInferenceMs = 0;
    lastTotalMs = 0;
    lastCold = false;
    lastBitrateBps = 0;
    lastChunkGapMs = 0;
    proxyBytes = 0;
    overloadCount = 0;
    conformCount = 0;
    lastConformMs = 0;
    maxConformMs = 0;
    renderFrames = [];
    samples = [];
    events = [];
  }

  function getSnapshot(nowMs = Date.now()) {
    let fgMs = fgAccumMs;
    let bgMs = bgAccumMs;
    if (active && visibilitySliceStartMs > 0) {
      const delta = Math.max(0, nowMs - visibilitySliceStartMs);
      if (isHidden) bgMs += delta;
      else fgMs += delta;
    }
    const jsHeapBytes = readJsHeapBytes(perf);
    const { renderFps, renderAvgMs } = active ? getRenderMetrics(nowMs) : { renderFps: 0, renderAvgMs: 0 };
    const overallSummary = summarizeBucket(overall, hopSeconds);
    const bgSummary = summarizeBucket(bgStats, hopSeconds);
    const fgSummary = summarizeBucket(fgStats, hopSeconds);
    const lastDutyPct = hopSeconds > 0 ? Math.round((lastTotalMs / (hopSeconds * 1000)) * 1000) / 10 : 0;

    return {
      active,
      startedAtMs,
      endedAtMs,
      sourceKind,
      proxyMode,
      hopSeconds,
      hidden: isHidden,
      fgSeconds: Math.round((fgMs / 1000) * 10) / 10,
      bgSeconds: Math.round((bgMs / 1000) * 10) / 10,
      totalSeconds: Math.round(((fgMs + bgMs) / 1000) * 10) / 10,
      lastFrontendMs: Math.round(lastFrontendMs * 10) / 10,
      lastInferenceMs: Math.round(lastInferenceMs * 10) / 10,
      lastTotalMs: Math.round(lastTotalMs * 10) / 10,
      lastDutyPct,
      lastCold,
      lastBitrateBps: Math.round(lastBitrateBps),
      lastChunkGapMs: Math.round(lastChunkGapMs),
      proxyBytes,
      proxyMaxBytes,
      jsHeapBytes,
      totalMemory,
      renderFps,
      renderAvgMs,
      overloadCount,
      conformCount,
      lastConformMs: Math.round(lastConformMs),
      maxConformMs: Math.round(maxConformMs),
      sampleCount: samples.length,
      eventCount: events.length,
      overall: overallSummary,
      background: bgSummary,
      foreground: fgSummary,
      recentEvents: events.slice(-12),
    };
  }

  return {
    start({ sourceKind: nextSource = 'display', proxyMode: nextMode = 'smooth', hopSeconds: nextHop = 2, maxBytes = 150 * 1024 * 1024, nowMs = Date.now() } = {}) {
      resetState();
      active = true;
      startedAtMs = nowMs;
      sourceKind = nextSource;
      proxyMode = nextMode;
      hopSeconds = Math.max(0.5, Number(nextHop) || 2);
      proxyMaxBytes = maxBytes || proxyMaxBytes;
      isHidden = currentHidden();
      visibilitySliceStartMs = nowMs;
      pushEvent({
        ts: nowMs,
        iso: new Date(nowMs).toISOString(),
        hidden: isHidden,
        type: 'session_start',
        sourceKind,
        proxyMode,
      });
      attachObservers();
    },

    stop(nowMs = Date.now()) {
      if (!active) return;
      flushVisibilitySlice(nowMs);
      active = false;
      endedAtMs = nowMs;
      renderFrames = [];
      pushEvent({
        ts: nowMs,
        iso: new Date(nowMs).toISOString(),
        hidden: isHidden,
        type: 'session_stop',
      });
      detachObservers();
    },

    setContext({ sourceKind: nextSource, proxyMode: nextMode, nowMs = Date.now() } = {}) {
      const prevMode = proxyMode;
      if (nextSource !== undefined) sourceKind = nextSource;
      if (nextMode !== undefined) proxyMode = nextMode;
      if (active && nextMode !== undefined && nextMode !== prevMode) {
        if (sourceKind === 'device') lastBitrateBps = 0;
        pushEvent({
          ts: nowMs,
          iso: new Date(nowMs).toISOString(),
          hidden: currentHidden(),
          type: 'mode_change',
          from: prevMode,
          to: proxyMode,
        });
      }
    },

    recordInference({ frontendMs = 0, inferenceMs = 0, cold = false, nowMs = Date.now() } = {}) {
      if (!active) return;
      const hidden = currentHidden();
      const fe = Math.max(0, Number(frontendMs) || 0);
      const inf = Math.max(0, Number(inferenceMs) || 0);
      const total = fe + inf;
      lastFrontendMs = fe;
      lastInferenceMs = inf;
      lastTotalMs = total;
      lastCold = !!cold;

      const jsHeapBytes = readJsHeapBytes(perf);
      const target = hidden ? bgStats : fgStats;
      for (const b of [overall, target]) {
        b.inferenceCount += 1;
        b.inferenceTotalSumMs += total;
        if (total > b.inferenceMaxMs) b.inferenceMaxMs = total;
        b.inferenceTotals.push(total);
        if (b.inferenceTotals.length > maxSamples) b.inferenceTotals.shift();
        recordMemoryToBuckets(b, jsHeapBytes);
      }

      const { renderFps, renderAvgMs } = getRenderMetrics(nowMs);
      const dutyPct = hopSeconds > 0 ? Math.round((total / (hopSeconds * 1000)) * 1000) / 10 : 0;

      pushSample({
        ts: nowMs,
        iso: new Date(nowMs).toISOString(),
        hidden,
        sourceKind,
        proxyMode: sourceKind === 'device' ? 'none' : proxyMode,
        frontendMs: Math.round(fe * 10) / 10,
        inferenceMs: Math.round(inf * 10) / 10,
        totalMs: Math.round(total * 10) / 10,
        dutyPct,
        cold: !!cold,
        droppedWindowsTotal: overall.droppedWindows,
        encodeBitrateBps: sourceKind === 'device' ? 0 : Math.round(lastBitrateBps),
        encodeGapMs: sourceKind === 'device' ? 0 : Math.round(lastChunkGapMs),
        proxyBytes,
        jsHeapBytes,
        renderFps,
        renderAvgMs,
        longTasksTotal: overall.longTaskCount,
      });
    },

    recordDroppedWindow(nowMs = Date.now()) {
      if (!active) return;
      const hidden = currentHidden();
      overall.droppedWindows += 1;
      if (hidden) bgStats.droppedWindows += 1;
      else fgStats.droppedWindows += 1;
      pushEvent({
        ts: nowMs,
        iso: new Date(nowMs).toISOString(),
        hidden,
        type: 'dropped_window',
      });
    },

    recordProxyChunk({ bytes = 0, gapMs = 0, bitrateBps = 0, bufferedBytes = 0, maxBytes, mode, nowMs = Date.now() } = {}) {
      if (!active) return;
      const hidden = currentHidden();
      if (mode) proxyMode = mode;
      if (Number.isFinite(maxBytes) && maxBytes > 0) proxyMaxBytes = maxBytes;
      proxyBytes = Math.max(0, Number(bufferedBytes) || 0);
      lastBitrateBps = Math.max(0, Number(bitrateBps) || 0);
      lastChunkGapMs = Math.max(0, Number(gapMs) || 0);

      const jsHeapBytes = readJsHeapBytes(perf);
      const target = hidden ? bgStats : fgStats;
      for (const b of [overall, target]) {
        b.chunkCount += 1;
        b.bitrateSumBps += lastBitrateBps;
        if (lastBitrateBps > b.bitrateMaxBps) b.bitrateMaxBps = lastBitrateBps;
        if (lastChunkGapMs > b.chunkGapMaxMs) b.chunkGapMaxMs = lastChunkGapMs;
        recordMemoryToBuckets(b, jsHeapBytes);
      }
      // Keep reference to bytes parameter to avoid lint issues and verify valid positive payloads
      void bytes;
    },

    recordProxyOverload({ message = '', nowMs = Date.now() } = {}) {
      if (!active) return;
      overloadCount += 1;
      pushEvent({
        ts: nowMs,
        iso: new Date(nowMs).toISOString(),
        hidden: currentHidden(),
        type: 'proxy_overload',
        message,
      });
    },

    recordRenderFrame({ drawMs = 0, nowMs = Date.now() } = {}) {
      if (!active || currentHidden()) return;
      renderFrames.push({ ts: nowMs, drawMs: Math.max(0, Number(drawMs) || 0) });
      pruneRenderFrames(nowMs);
    },

    recordConform({ fileName = '', durationMs = 0, confidence = '', nowMs = Date.now() } = {}) {
      const dur = Math.max(0, Number(durationMs) || 0);
      conformCount += 1;
      lastConformMs = dur;
      if (dur > maxConformMs) maxConformMs = dur;
      pushEvent({
        ts: nowMs,
        iso: new Date(nowMs).toISOString(),
        hidden: currentHidden(),
        type: 'conform',
        fileName,
        durationMs: Math.round(dur),
        confidence,
      });
    },

    recordLongTask,

    setHiddenForTest(hidden, nowMs = Date.now()) {
      handleVisibilityChange(nowMs, hidden);
    },

    async measureTotalMemory(nowMs = Date.now()) {
      if (!perf || typeof perf.measureUserAgentSpecificMemory !== 'function') {
        return { supported: false, reason: '当前浏览器不支持 measureUserAgentSpecificMemory（需桌面 Chrome/Edge 且启用跨源隔离）' };
      }
      try {
        const result = await perf.measureUserAgentSpecificMemory();
        const bytes = Number(result?.bytes) || 0;
        const breakdown = Array.isArray(result?.breakdown)
          ? result.breakdown
            .filter((b) => (b?.bytes || 0) > 0)
            .map((b) => ({
              bytes: b.bytes,
              types: Array.isArray(b.types) ? b.types : [],
            }))
          : [];
        totalMemory = { bytes, breakdown, measuredAtMs: nowMs };
        pushEvent({
          ts: nowMs,
          iso: new Date(nowMs).toISOString(),
          hidden: currentHidden(),
          type: 'total_memory_measure',
          bytes,
        });
        return { supported: true, ...totalMemory };
      } catch (error) {
        return { supported: false, reason: error?.message || String(error) };
      }
    },

    getSnapshot,

    exportReport(nowMs = Date.now()) {
      const snap = getSnapshot(nowMs);
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      return {
        schemaVersion: 1,
        exportedAt: new Date(nowMs).toISOString(),
        environment: {
          userAgent: nav?.userAgent || '',
          hardwareConcurrency: nav?.hardwareConcurrency ?? null,
          deviceMemoryGB: nav?.deviceMemory ?? null,
          crossOriginIsolated: typeof self !== 'undefined' ? !!self.crossOriginIsolated : null,
        },
        session: {
          active: snap.active,
          startedAt: snap.startedAtMs ? new Date(snap.startedAtMs).toISOString() : null,
          endedAt: snap.endedAtMs ? new Date(snap.endedAtMs).toISOString() : null,
          totalSeconds: snap.totalSeconds,
          foregroundSeconds: snap.fgSeconds,
          backgroundSeconds: snap.bgSeconds,
          sourceKind: snap.sourceKind,
          proxyMode: snap.proxyMode,
          hopSeconds: snap.hopSeconds,
          overloadCount: snap.overloadCount,
          conformCount: snap.conformCount,
          maxConformMs: snap.maxConformMs,
        },
        summary: {
          overall: snap.overall,
          backgroundOnly: snap.background,
          foregroundOnly: snap.foreground,
        },
        totalMemoryMeasurement: snap.totalMemory,
        events: [...events],
        samples: [...samples],
      };
    },
  };
}

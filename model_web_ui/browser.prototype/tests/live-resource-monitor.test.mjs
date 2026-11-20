import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveResourceMonitor } from '../../../site/live-resource-monitor.mjs';

function createFakeDoc(initialHidden = false) {
  const listeners = new Map();
  return {
    hidden: initialHidden,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    triggerVisibility(nextHidden) {
      this.hidden = nextHidden;
      const fn = listeners.get('visibilitychange');
      if (fn) fn();
    },
  };
}

test('tracks foreground and background inference, encoding, long tasks, and preserves data after stop', () => {
  const doc = createFakeDoc(false);
  let returnedCount = 0;
  const fakePerf = {
    memory: { usedJSHeapSize: 40 * 1024 * 1024 },
  };
  let observedLongTaskCb = null;
  class FakePerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    constructor(cb) {
      observedLongTaskCb = cb;
    }
    observe() {}
    disconnect() {
      observedLongTaskCb = null;
    }
  }

  const monitor = createLiveResourceMonitor({
    doc,
    perf: fakePerf,
    PerformanceObserverCtor: FakePerformanceObserver,
    onVisibilityReturn: () => { returnedCount += 1; },
  });

  const t0 = 1_700_000_000_000;
  monitor.start({ sourceKind: 'display', proxyMode: 'smooth', hopSeconds: 2, nowMs: t0 });

  // Foreground activity (10s)
  monitor.recordRenderFrame({ drawMs: 2.0, nowMs: t0 + 1000 });
  monitor.recordRenderFrame({ drawMs: 4.0, nowMs: t0 + 1500 });
  monitor.recordProxyChunk({
    bytes: 250_000,
    gapMs: 2000,
    bitrateBps: 1_000_000,
    bufferedBytes: 10 * 1024 * 1024,
    mode: 'smooth',
    nowMs: t0 + 2000,
  });
  monitor.recordInference({ frontendMs: 20, inferenceMs: 100, cold: false, nowMs: t0 + 2000 });

  // Switch to background (in-game) at t0 + 10s
  doc.hidden = true;
  monitor.setHiddenForTest(true, t0 + 10_000);

  // Render frames should be ignored while hidden
  monitor.recordRenderFrame({ drawMs: 8.0, nowMs: t0 + 12_000 });

  // Background inference & encoding & long task & dropped window must all be recorded!
  fakePerf.memory.usedJSHeapSize = 64 * 1024 * 1024;
  monitor.recordProxyChunk({
    bytes: 500_000,
    gapMs: 2600,
    bitrateBps: 2_000_000,
    bufferedBytes: 22 * 1024 * 1024,
    mode: 'smooth',
    nowMs: t0 + 14_000,
  });
  monitor.recordInference({ frontendMs: 30, inferenceMs: 270, cold: false, nowMs: t0 + 14_000 });
  monitor.recordInference({ frontendMs: 40, inferenceMs: 360, cold: false, nowMs: t0 + 16_000 });
  monitor.recordDroppedWindow(t0 + 16_500);
  assert.ok(observedLongTaskCb, 'PerformanceObserver should be attached while active');
  observedLongTaskCb({ getEntries: () => [{ duration: 92.4, startTime: 15000 }] });
  monitor.recordConform({ fileName: 'apex-match.mkv', durationMs: 420, confidence: 'exact', nowMs: t0 + 20_000 });

  // Return to foreground at t0 + 30s -> triggers immediate UI refresh callback
  doc.hidden = false;
  monitor.setHiddenForTest(false, t0 + 30_000);
  assert.equal(returnedCount, 1);

  const liveSnap = monitor.getSnapshot(t0 + 30_000);
  assert.equal(liveSnap.fgSeconds, 10);
  assert.equal(liveSnap.bgSeconds, 20);
  assert.equal(liveSnap.background.inferenceCount, 2);
  assert.equal(liveSnap.background.inferenceAvgMs, 350);
  assert.equal(liveSnap.background.inferenceMaxMs, 400);
  assert.equal(liveSnap.background.droppedWindows, 1);
  assert.equal(liveSnap.background.longTaskCount, 1);
  assert.equal(liveSnap.background.longTaskMaxMs, 92.4);
  assert.equal(liveSnap.background.encodeAvgBitrateBps, 2_000_000);
  assert.equal(liveSnap.background.peakProxyBytes, 22 * 1024 * 1024);
  assert.equal(liveSnap.background.peakJsHeapBytes, 64 * 1024 * 1024);
  assert.equal(liveSnap.overall.inferenceCount, 3);
  assert.equal(liveSnap.conformCount, 1);
  assert.equal(liveSnap.lastConformMs, 420);

  // Stop should preserve report for post-match inspection & export
  monitor.stop(t0 + 35_000);
  assert.equal(observedLongTaskCb, null, 'Observer should disconnect on stop');

  const report = monitor.exportReport(t0 + 40_000);
  assert.equal(report.session.active, false);
  assert.equal(report.session.foregroundSeconds, 15);
  assert.equal(report.session.backgroundSeconds, 20);
  assert.equal(report.samples.length, 3);
  assert.equal(report.samples[0].hidden, false);
  assert.equal(report.samples[1].hidden, true);
  assert.equal(report.samples[1].renderFps, 0);
  assert.equal(report.summary.backgroundOnly.inferenceMaxMs, 400);
});

test('measureTotalMemory handles supported and unsupported browsers cleanly', async () => {
  const unsupported = createLiveResourceMonitor({ doc: createFakeDoc(false), perf: {}, PerformanceObserverCtor: null });
  const r1 = await unsupported.measureTotalMemory();
  assert.equal(r1.supported, false);

  const supported = createLiveResourceMonitor({
    doc: createFakeDoc(false),
    perf: {
      async measureUserAgentSpecificMemory() {
        return {
          bytes: 185 * 1024 * 1024,
          breakdown: [{ bytes: 120 * 1024 * 1024, types: ['DOM', 'JS'] }],
        };
      },
    },
    PerformanceObserverCtor: null,
  });
  const r2 = await supported.measureTotalMemory(1_700_000_000_500);
  assert.equal(r2.supported, true);
  assert.equal(r2.bytes, 185 * 1024 * 1024);
  assert.equal(supported.getSnapshot().totalMemory.bytes, 185 * 1024 * 1024);
});

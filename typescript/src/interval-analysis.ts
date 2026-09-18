import { type Analysis, type DamageOptions, type DamageProbe, type Reading, type WorkerEvent, type AnalysisPhase, round, timecode } from './shared';
import { HudLocator, CounterTracker, readLocatedCounter } from './core/damage';
import { type Image } from './core/image';
import { PROBE_INTERVAL, DENSE_FPS, probeTimes, classifyWindows, anomalyRanges, assignGrowth, windowClips } from './core/interval';
import { checkCancelled, streamVideoWindow, tailFrameStart, type VideoWindowOptions } from './media';

type Supply = (source: string, toolsDir: string, options: VideoWindowOptions) => Promise<{ frames: number; bytesRead: number }>;
export async function analyzeIntervals(result: Analysis, options: DamageOptions, toolsDir: string, signal: AbortSignal,
  emit: (e: WorkerEvent) => void,
  progress: (phase: AnalysisPhase, current: number, total: number, detail?: string) => void,
  log: (stage: string, message: string, level?: 'info' | 'warning' | 'error') => void,
  supply: Supply = streamVideoWindow,
  tailStart = tailFrameStart) {
  const { media } = result, times = probeTimes(media.duration), probes: DamageProbe[] = [];
  const actual = new Map<number, Reading>();
  const sparseLocator = new HudLocator(media.fps);
  let frames = 0, bytes = 0, starts = 0, cropped = 0, valid = 0, hudMs = 0, globalSearches = 0;
  const collect = async (o: Omit<VideoWindowOptions, 'width' | 'height' | 'signal' | 'event'>) => {
    checkCancelled(signal); starts++;
    const stats = await supply(result.source.path, toolsDir, { width: media.width, height: media.height, signal, event: emit, ...o });
    frames += stats.frames; bytes += stats.bytesRead;
    if (o.region) cropped += stats.frames;
  };
  let unknown = 0, tailMetadataMs = 0;
  function read(image: Image, time: number, locator: HudLocator, region?: VideoWindowOptions['region'], resetFrames = 2) {
    const t = performance.now(), frame = region ? { ...image, origin: region } : image;
    const anchor = locator.locate(frame, Math.round(time * media.fps));
    const value = anchor ? readLocatedCounter(frame, anchor) : null;
    if (value !== null) { valid++; unknown = 0; }
    else if (++unknown >= resetFrames && anchor) { locator.invalidate(); unknown = 0; }
    hudMs += performance.now() - t;
    return { time: round(time), value, anchor: anchor ? { ...anchor } : undefined };
  }
  const sparseStart = performance.now();
  progress('sparse', 0, times.length, '每 5 秒读取相邻两帧');
  for (const [i, time] of times.entries()) {
    const tail = i === times.length - 1;
    const region = sparseLocator.searchRegion(media.width, media.height, true) ?? undefined;
    const pair: ReturnType<typeof read>[] = [];
    let start = time;
    if (tail) {
      const metadataStart = performance.now();
      start = await tailStart(result.source.path, toolsDir, media.duration, signal, emit);
      tailMetadataMs += performance.now() - metadataStart;
    }
    if (start < media.duration) await collect({ start, end: media.duration, limit: 2, region,
      consume(image, frameTime) { pair.push(read(image, frameTime, sparseLocator, region)); }
    });
    for (const r of pair) actual.set(r.time, { time: r.time, value: r.value, source: 'probe' });
    const value = pair.length === 2 && pair[0].value !== null && pair[0].value === pair[1].value ? pair[0].value : null;
    probes.push({ time, frame_times: pair.map(r => r.time), value, ...(value !== null && pair[1].anchor ? { anchor: pair[1].anchor } : {}) });
    progress('sparse', i + 1, times.length, `${i + 1}/${times.length} 个探测点 · ${timecode(time)} · ${value ?? '未知'}`);
  }
  globalSearches += sparseLocator.searches;
  const sparseMs = performance.now() - sparseStart;
  const windows = classifyWindows(probes), ranges = anomalyRanges(windows);
  const denseDuration = ranges.reduce((n, r) => n + r.end - r.start, 0);
  const denseStart = performance.now();
  let completedDuration = 0, lastProgress = 0;
  progress('dense', 0, denseDuration || 1, ranges.length ? `${ranges.length} 个连续区间，共 ${denseDuration.toFixed(2)} 秒` : '没有异常区间，无需补查');
  for (const range of ranges) {
    // Fresh state per range: nearby anchors are hints, never counter baselines.
    const locator = new HudLocator(media.fps), tracker = new CounterTracker(true);
    unknown = 0;
    const hint = probes.filter(p => p.anchor).sort((a, b) => Math.abs(a.time - range.start) - Math.abs(b.time - range.start))[0]?.anchor;
    if (hint) locator.seed(hint);
    const region = locator.searchRegion(media.width, media.height, true) ?? undefined;
    const padding = Math.max(2 / DENSE_FPS, 2 / media.fps);
    const start = Math.max(0, range.start - padding);
    const end = Math.min(media.duration, range.end + padding);
    // Dense observations supersede sparse evidence throughout the overlap.
    for (const time of actual.keys()) if (time >= start && time < end) actual.delete(time);
    let previousTime = -Infinity;
    await collect({ start, end, fps: DENSE_FPS, region, consume(image, time) {
      // Keep the existing roughly one-second unreadable-digit recalibration
      // cadence. The two-frame rule confirms counters, not HUD scale resets.
      const reading = read(image, time, locator, region, Math.max(1, Math.round(Math.min(DENSE_FPS, media.fps))));
      if (reading.time <= previousTime) return;
      previousTime = reading.time;
      actual.set(reading.time, { time: reading.time, value: reading.value, source: 'dense' });
      const event = tracker.update(reading.time, reading.value);
      if (event && event.time >= range.start - 1e-6 && event.time < range.end - 1e-6 &&
          assignGrowth(windows, event)) result.damageEvents.push(event);
      if (performance.now() - lastProgress > 200) {
        progress('dense', completedDuration + Math.max(0, Math.min(time, range.end) - range.start), denseDuration,
          `${timecode(time)} · 已确认 ${result.damageEvents.length} 次补查增长`);
        lastProgress = performance.now();
      }
    } });
    globalSearches += locator.searches;
    completedDuration += range.end - range.start;
  }
  progress('dense', denseDuration || 1, denseDuration || 1, `补查完成，共 ${result.damageEvents.length} 次确认增长`);
  const denseMs = performance.now() - denseStart;
  progress('finalize', 0, 1, '合并高亮窗口并添加前后缓冲');
  const finalStart = performance.now();
  result.damage_strategy = 'interval-v1';
  result.damage_parameters = { ...options, probe_interval_s: PROBE_INTERVAL, dense_fps: DENSE_FPS };
  result.damageWindows = windows;
  result.damageProbes = probes;
  result.readings = [...actual.values()].sort((a, b) => a.time - b.time);
  result.clips = windowClips(windows, media.duration, options);
  result.stats = { sampled_frames: frames, readable_frames: valid, probe_points: probes.length,
    probe_interval_s: PROBE_INTERVAL, dense_fps: DENSE_FPS, dense_ranges: ranges.length,
    dense_duration_s: round(denseDuration), dense_ratio: denseDuration / media.duration,
    sparse_ms: round(sparseMs, 2), dense_ms: round(denseMs, 2), hud_ms: round(hudMs, 2),
    finalize_ms: round(performance.now() - finalStart, 2),
    tail_metadata_ms: round(tailMetadataMs, 2), rgb_pipe_bytes: bytes, ffmpeg_starts: starts, frame_streams: starts,
    full_frame_samples: frames - cropped, cropped_samples: cropped, global_searches: globalSearches,
    highlighted_windows: windows.filter(w => w.highlighted).length };
  log('分析统计', `探测 ${probes.length} 点 · 补查 ${denseDuration.toFixed(2)} 秒 (${(denseDuration / media.duration * 100).toFixed(1)}%) · 读取 ${frames} 帧 · FFmpeg 启动 ${starts} 次`);
  log('阶段耗时', `稀疏 ${(sparseMs / 1000).toFixed(2)} 秒 · 补查 ${(denseMs / 1000).toFixed(2)} 秒 · HUD 识别 ${(hudMs / 1000).toFixed(2)} 秒（包含在阶段耗时内）`);
  result.warnings.push('虚线为 5 秒窗口的区间估算；相等端点跳过内部识别，窗口内重置或短暂增长可能无法发现。', '补查未知读数与计数下降会重新建立基线；未知部分不计作零伤害。');
  if (!valid) result.warnings.push('没有可靠读出伤害数字，请检查 HUD 是否完整、样式和录像清晰度。');
}

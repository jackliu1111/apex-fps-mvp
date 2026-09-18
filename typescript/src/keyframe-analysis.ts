import { type Analysis, type DamageOptions, type DamageProbe, type WorkerEvent, type AnalysisPhase, round, timecode } from './shared';
import { HudLocator } from './core/damage';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPaddleReader, type CounterReader, type OCRObservation } from './paddleocr';
import { keyframeWindows } from './core/keyframes';
import { MIN_HIGHLIGHT_SECONDS, windowClips } from './core/interval';
import { checkCancelled, streamVideoWindow, type VideoWindowOptions } from './media';

type Supply = (source: string, toolsDir: string, options: VideoWindowOptions) => Promise<{ frames: number; bytesRead: number }>;
export async function analyzeKeyframes(result: Analysis, options: DamageOptions, toolsDir: string, signal: AbortSignal,
  emit: (e: WorkerEvent) => void,
  progress: (phase: AnalysisPhase, current: number, total: number, detail?: string) => void,
  log: (stage: string, message: string, level?: 'info' | 'warning' | 'error') => void,
  supply: Supply = streamVideoWindow,
  runtime: { debugDir?: string; createReader?: typeof createPaddleReader } = {}) {
  checkCancelled(signal);
  const debugDir = resolve(runtime.debugDir ?? join('work', 'ocr-debug', result.id));
  await mkdir(debugDir, { recursive: true });
  result.stats.ocr_debug_dir = debugDir;
  log('PaddleOCR', `正在加载本地识别模型 · 调试图片：${debugDir}`);
  let reader: CounterReader | undefined;
  const getReader = async () => reader ??= await (runtime.createReader ?? createPaddleReader)(debugDir, signal, emit);
  const { media } = result, locator = new HudLocator(media.fps), probes: DamageProbe[] = [];
  let frames = 0, bytes = 0, starts = 0, cropped = 0, valid = 0, hudMs = 0, previousTime = -Infinity;
  let ocrCalls = 0;
  const scanStart = performance.now();
  progress('keyframes', 0, media.duration, '关键帧定位 → PaddleOCR → 保存标框原图');
  const collect = async (start: number) => {
    checkCancelled(signal); starts++;
    const stats = await supply(result.source.path, toolsDir, {
      width: media.width, height: media.height, start, end: media.duration,
      keyframesOnly: true, signal, event: emit,
      async consume(image, time) {
        checkCancelled(signal);
        const actualTime = round(time);
        if (actualTime <= previousTime) return;
        previousTime = actualTime;
        const hudStart = performance.now();
        const engine = await getReader();
        const attempts: OCRObservation[] = [];
        const located = await locator.locateAndRead(image, Math.round(time * media.fps), async anchor => {
          checkCancelled(signal);
          const observation = await engine.read(image, anchor, time, probes.length + 1, attempts.length + 1);
          attempts.push(observation); ocrCalls++;
          return observation.value;
        });
        // Preserve every actual keyframe, even when no candidate was found.
        if (!attempts.length) attempts.push(await engine.read(image, null, time, probes.length + 1, 0));
        const anchor = located?.anchor, value = located?.value ?? null;
        const observation = attempts.at(-1)!;
        await appendFile(join(debugDir, 'frames.jsonl'), JSON.stringify({
          frame_index: probes.length + 1, time, value, anchor: anchor ?? null,
          selected_metadata: located ? observation.metadata_path : null, attempts,
        }) + '\n');
        if (value !== null) valid++;
        // Keyframes can be seconds apart; retry localization after an unreadable
        // observation without ever turning an unknown counter into zero.
        else if (anchor) locator.invalidate();
        hudMs += performance.now() - hudStart;
        result.readings.push({ time: actualTime, value, source: 'keyframe' });
        probes.push({ time: actualTime, frame_times: [actualTime], value,
          ...(anchor ? { anchor: { ...anchor } } : {}), ocr: observation });
        progress('keyframes', actualTime, media.duration,
          `${probes.length} 个关键帧 · ${timecode(actualTime)} · ${value ?? '未知'}`);

      },
    });
    frames += stats.frames; bytes += stats.bytesRead;
  };
  try { await collect(0); }
  finally { await reader?.close(); }
  checkCancelled(signal);
  const keyframeMs = performance.now() - scanStart;
  progress('keyframes', media.duration, media.duration, `已识别 ${probes.length} 个关键帧`);
  progress('finalize', 0, 1, '按相邻关键帧构建窗口，合并并添加前后缓冲');
  const finalStart = performance.now();
  const windows = keyframeWindows(result.readings, media.duration);
  result.damage_strategy = 'keyframes-v1';
  result.damage_parameters = { ...options, frame_selection: 'keyframes', confirmation_frames: 1, min_window_s: MIN_HIGHLIGHT_SECONDS };
  result.damageWindows = windows;
  result.damageProbes = probes;
  result.damageEvents = [];
  result.clips = windowClips(windows, media.duration, options);
  const gaps = probes.slice(1).map((p, i) => p.time - probes[i].time);
  result.stats = { ...result.stats, digit_engine: 'paddleocr', ocr_calls: ocrCalls, sampled_frames: frames, readable_frames: valid, keyframe_points: probes.length,
    keyframe_interval_mean_s: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0,
    keyframe_interval_max_s: gaps.reduce((a, b) => Math.max(a, b), 0),
    keyframe_ms: round(keyframeMs, 2), hud_ms: round(hudMs, 2),
    finalize_ms: round(performance.now() - finalStart, 2), rgb_pipe_bytes: bytes,
    ffmpeg_starts: starts, frame_streams: starts, full_frame_samples: frames - cropped,
    cropped_samples: cropped, global_searches: locator.searches,
    highlighted_windows: windows.filter(w => w.highlighted).length };
  log('分析统计', `关键帧 ${probes.length} 个 · 可读 ${valid} 个 · 读取 ${frames} 帧 · FFmpeg 启动 ${starts} 次`);
  log('阶段耗时', `关键帧分析 ${(keyframeMs / 1000).toFixed(2)} 秒 · HUD 识别 ${(hudMs / 1000).toFixed(2)} 秒（包含在关键帧分析内）`);
  result.warnings.push('只识别关键帧，每帧读一次；虚线为相邻关键帧之间的区间估算，时间间隔由录像决定。',
    '伤害数字由本地 PaddleOCR 识别，不使用数字模板或多读数取最大值；未知读数和计数下降处断线。每个关键帧保留标框原图、OCR 输入及结果，调试保存会增加耗时和磁盘占用。单帧误读仍可能影响候选。');
  if (!valid) result.warnings.push('没有检测到可用的伤害数字候选，请检查 HUD 是否完整、样式和录像清晰度。');
}

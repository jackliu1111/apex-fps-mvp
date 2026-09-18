import { basename, extname, join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  type WorkerRequest,
  type WorkerEvent,
  type Analysis,
  type Progress,
  type AnalysisPhase,
  type TaskLog,
  analysisStageNames,
  timecode,
  validateSettings,
} from "./shared";
import {
  audioClips,
  audioCurve,
  detectAudioEvents,
  RMSAccumulator,
} from "./core/audio";
import { analyzeKeyframes } from "./keyframe-analysis";
import {
  Cancelled,
  atomicJSON,
  checkCancelled,
  doctor,
  identify,
  probe,
  renderClip,
  runMedia,
  toolsPath,
  verifySource,
} from "./media";

export async function analyzeSource(
  source: string,
  request: WorkerRequest,
  signal: AbortSignal,
  emit: (e: WorkerEvent) => void,
): Promise<Analysis> {
  const analysisStart = performance.now();
  const s = request.settings!;
  validateSettings(s);
  const progress = (phase: AnalysisPhase, current: number, total: number, detail?: string) =>
    emit({
      type: "progress",
      progress: { stage: phase === "finalize" && s.mode === "audio" ? "生成声音轴与候选" : analysisStageNames[phase],
        phase, current, total, source: basename(source), sourceKey: source, detail },
    });
  const log = (stage: string, message: string, level: TaskLog["level"] = "info") =>
    emit({ type: "log", entry: { stage, message, level, source: basename(source) } });
  progress("validate", 0, 1, "正在检查录像路径、大小和修改时间");
  const hashStart = performance.now();
  const identity = await identify(source, signal);
  const hashMs = performance.now() - hashStart;
  progress("probe", 0, 1, "读取分辨率、帧率和录像时长");
  const media = await probe(identity.path, request.toolsDir, signal);
  log("视频信息", `${media.width}×${media.height} · ${media.fps.toFixed(2)} FPS · 时长 ${timecode(media.duration)}`);
  const result: Analysis = {
    id: crypto.randomUUID(),
    source: identity,
    name: basename(source),
    mode: s.mode,
    media,
    clips: [],
    audioEvents: [],
    damageEvents: [],
    readings: [],
    curve: [],
    stats: {},
    warnings: [],
  };
  if (s.mode === "audio") {
    if (!media.hasAudio)
      throw new Error("音频模式需要录像带有音轨；无音轨录像可使用伤害模式");
    const accumulator = new RMSAccumulator(
      Math.round((s.audio.sample_rate * s.audio.frame_ms) / 1000),
    );
    let remaining = new Uint8Array(0),
      lastUpdate = 0;
    progress("audio", 0, media.duration, "正在解码音轨并分析声音能量");
    await runMedia(
      toolsPath(request.toolsDir, "ffmpeg"),
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        identity.path,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(s.audio.sample_rate),
        "-f",
        "f32le",
        "pipe:1",
      ],
      {
        signal,
        event: emit,
        consume(bytes) {
          const combined = Buffer.concat([remaining, bytes]),
            length = combined.length - (combined.length % 4);
          accumulator.push(combined.subarray(0, length));
          remaining = combined.subarray(length);
          if (Date.now() - lastUpdate > 200) {
            progress(
              "audio",
              (accumulator.values.length * s.audio.frame_ms) / 1000,
              media.duration,
              `已分析至 ${timecode((accumulator.values.length * s.audio.frame_ms) / 1000)}`,
            );
            lastUpdate = Date.now();
          }
        },
      },
    );
    progress("finalize", 0, 1, "正在整理声音事件和候选区间");
    const { threshold, events } = detectAudioEvents(
      accumulator.values,
      s.audio,
    );
    result.threshold = threshold;
    result.audioEvents = events;
    result.clips = audioClips(events, media.duration, s.audio);
    result.curve = audioCurve(accumulator.values, s.audio.frame_ms);
    result.stats = { sampled_frames: accumulator.values.length };
    result.warnings.push("音频候选表示高能量声音区间，仍需人工检查。");
  } else {
    await analyzeKeyframes(result, s.damage, request.toolsDir, signal, emit, progress, log, undefined,
      { debugDir: join(request.jobDir, 'ocr-debug', result.id) });
  }
  result.stats.file_validation_ms = hashMs;
  result.stats.total_ms = performance.now() - analysisStart;
  await verifySource(identity, signal);
  checkCancelled(signal);
  progress("finalize", 1, 1, `已生成 ${result.clips.length} 个候选片段`);
  for (const warning of result.warnings) log("结果说明", warning, "warning");
  return result;
}
export async function exportSelections(
  request: WorkerRequest,
  signal: AbortSignal,
  emit: (e: WorkerEvent) => void,
) {
  const selections = request.selections ?? [];
  const total = selections.reduce((n, s) => n + s.indices.length, 0);
  let completed = 0;
  if (!total) throw new Error("请至少选择一个片段");
  await mkdir(request.outputDir, { recursive: true });
  for (const { analysis, indices } of selections) {
    if (!indices.length) continue;
    const unique = [...new Set(indices)].sort((a, b) => a - b);
    if (
      unique.some(
        (i) => !Number.isInteger(i) || i < 0 || i >= analysis.clips.length,
      )
    )
      throw new Error("候选编号无效");
    await verifySource(analysis.source, signal);
    let stem =
      basename(analysis.name, extname(analysis.name))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 100) || "recording";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem))
      stem = `_${stem}`;
    let folder = "",
      suffix = 0;
    while (!folder) {
      const candidate = join(
        request.outputDir,
        stem + (suffix ? `_${suffix + 1}` : ""),
      );
      try {
        await mkdir(candidate);
        folder = candidate;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        suffix++;
      }
    }
    const files: {
      path: string;
      clip: Analysis["clips"][number];
      rendered: unknown;
    }[] = [];
    try {
      for (const index of unique) {
        checkCancelled(signal);
        const path = join(
            folder,
            `clip_${String(index + 1).padStart(3, "0")}.mp4`,
          ),
          clip = analysis.clips[index];
        emit({
          type: "progress",
          progress: {
            stage: `导出片段 ${index + 1}`,
            current: completed,
            total,
            source: analysis.name,
          },
        });
        const rendered = await renderClip(
          analysis.source.path,
          clip,
          analysis.media,
          path,
          request.toolsDir,
          signal,
          false,
          emit,
        );
        files.push({ path, clip, rendered });
        completed++;
      }
      await verifySource(analysis.source, signal);
      checkCancelled(signal);
      await atomicJSON(join(folder, "selection.json"), {
        version: 1,
        analysisId: analysis.id,
        source: analysis.source,
        clips: files,
      });
      for (const file of files)
        emit({
          type: "export",
          file: { source: analysis.name, clip: file.clip, path: file.path },
        });
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }
}
export async function runWorker(file: string) {
  const request: WorkerRequest = await Bun.file(file).json(),
    controller = new AbortController();
  const emit = (event: WorkerEvent) => console.log(JSON.stringify(event));
  const cancelFile = join(request.jobDir, "cancel");
  const timer = setInterval(() => {
    if (existsSync(cancelFile)) controller.abort();
  }, 100);
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    emit({ type: "log", entry: { level: "info", stage: "运行环境",
      message: `Bun ${Bun.version} · ${process.platform}/${process.arch}` } });
    emit({ type: "progress", progress: { stage: "检查媒体工具", current: 0, total: 1,
      detail: "正在检查视频解码工具" } });
    await doctor(request.toolsDir);
    checkCancelled(controller.signal);
    if (request.kind === "analyze") {
      for (const source of request.sources ?? []) {
        const analysis = await analyzeSource(
          source,
          request,
          controller.signal,
          emit,
        );
        await atomicJSON(
          join(request.jobDir, `analysis-${analysis.id}.json`),
          analysis,
        );
        emit({ type: "analysis", analysis });
      }
    } else await exportSelections(request, controller.signal, emit);
    emit({ type: "done" });
  } catch (error) {
    emit({
      type: "error",
      cancelled:
        controller.signal.aborted ||
        existsSync(cancelFile) ||
        error instanceof Cancelled,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

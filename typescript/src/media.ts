import { createServer, type Socket, type AddressInfo } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { stat, realpath, mkdir, copyFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import type { Clip, Identity, MediaInfo, WorkerEvent } from "./shared";
import type { Image, Region } from "./core/image";

export class Cancelled extends Error {
  constructor() {
    super("任务已取消");
  }
}
export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Cancelled();
}
export function toolsPath(dir: string, name: string) {
  return join(dir, name + (process.platform === "win32" ? ".exe" : ""));
}
export function locateTools(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const beside = join(dirname(process.execPath), "tools");
  if (Bun.file(toolsPath(beside, "ffmpeg")).size > 0) return beside;
  const development = resolve(
    import.meta.dir,
    "../tools",
    `${process.platform}-${process.arch}`,
  );
  if (Bun.file(toolsPath(development, "ffmpeg")).size > 0) return development;
  const system = Bun.which("ffmpeg");
  if (system && Bun.which("ffprobe")) return dirname(system);
  return beside;
}

// Bun 1.3.12/1.3.13 eagerly buffer subprocess stdout while OCR awaits.
// Large RGB recordings can exceed ArrayBuffer's limit and SIGTRAP. A TCP
// socket propagates pause/backpressure to FFmpeg; bytes stay on this machine.
async function openMediaOutput() {
  let socket: Socket | undefined;
  let accept!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => { accept = resolve; });
  const server = createServer((peer) => {
    if (socket) { peer.destroy(); return; }
    socket = peer;
    peer.pause();
    accept(peer);
    server.close();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) { server.close(); throw error; }
  const port = (server.address() as AddressInfo).port;
  return { url: `tcp://127.0.0.1:${port}`, connected,
    close() { socket?.destroy(); server.close(); } };
}

export async function runMedia(
  executable: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    // false deliberately ends this stream; cancellation and other errors still propagate.
    consume?: (chunk: Uint8Array) => void | false | Promise<void | false>;
    // FFmpeg raw output uses a bounded loopback socket, not Bun's eager stdout pipe.
    streamOutput?: boolean;
    event?: (e: WorkerEvent) => void;
    stderrLine?: (line: string) => void;
    stderrEnd?: () => void;
  } = {},
): Promise<string> {
  checkCancelled(options.signal);
  if (options.streamOutput && (!options.consume || args.at(-1) !== "pipe:1"))
    throw new Error("流式媒体输出需要 consume 和末尾 pipe:1");
  const transport = options.streamOutput ? await openMediaOutput() : undefined;
  let child: Bun.Subprocess<"ignore", "ignore" | "pipe", "pipe">;
  const spawnOptions = { stdin: "ignore", stdout: transport ? "ignore" : "pipe", stderr: "pipe", windowsHide: true } as const;
  try {
    child = Bun.spawn([executable, ...(transport ? [...args.slice(0, -1), transport.url] : args)], spawnOptions);
  } catch (error) { transport?.close(); throw error; }
  options.event?.({ type: "pid", pid: child.pid, active: true });
  const cancel = () => {
    try {
      child.kill();
    } catch {}
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let errors = "";
  const stderr = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const bytes of child.stderr) {
      const text = decoder.decode(bytes, { stream: true });
      errors = (errors + text).slice(-16000);
      if (options.stderrLine) {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) options.stderrLine(line);
      }
    }
    if (pending) options.stderrLine?.(pending);
    options.stderrEnd?.();
  })();
  const output: Uint8Array[] = [];
  let outputBytes = 0, stopped = false;
  try {
    const source = transport
      ? await Promise.race([transport.connected, child.exited.then(() => null)])
      : child.stdout;
    if (!source || typeof source === "number") {
      await stderr;
      checkCancelled(options.signal);
      throw new Error(`${basename(executable)} 执行失败：${errors.trim() || "未连接视频数据通道"}`);
    }
    for await (const bytes of source) {
      checkCancelled(options.signal);
      if (options.consume) {
        if (await options.consume(bytes) === false) {
          stopped = true;
          cancel();
          break;
        }
      }
      else {
        outputBytes += bytes.length;
        if (outputBytes > 8_000_000) throw new Error("媒体工具输出过大");
        output.push(bytes);
      }
    }
    const code = await child.exited;
    await stderr;
    checkCancelled(options.signal);
    if (!stopped && code !== 0)
      throw new Error(
        `${basename(executable)} 执行失败：${errors.trim() || "退出码 " + code}`,
      );
    return new TextDecoder().decode(Buffer.concat(output));
  } finally {
    cancel();
    transport?.close();
    await child.exited;
    await stderr.catch(() => {});
    options.signal?.removeEventListener("abort", cancel);
    options.event?.({ type: "pid", pid: child.pid, active: false });
  }
}

export interface VideoWindowOptions {
  width: number;
  height: number;
  start: number;
  end: number;
  // Omitted for adjacent original frames. Sampling selects real frames and
  // never duplicates a source frame to manufacture confirmation on low/VFR fps.
  fps?: number;
  // Decoder-side skip: non-keyframes are discarded before reconstruction.
  keyframesOnly?: boolean;
  limit?: number;
  region?: Region;
  signal?: AbortSignal;
  event?: (e: WorkerEvent) => void;
  consume: (frame: Image, time: number) => void | false | Promise<void | false>;
}
export async function streamVideoWindow(source: string, toolsDir: string, o: VideoWindowOptions) {
  checkCancelled(o.signal);
  if (!Number.isFinite(o.start) || !Number.isFinite(o.end) || o.start < 0 || o.end <= o.start ||
      (o.fps !== undefined && (!Number.isFinite(o.fps) || o.fps <= 0)) ||
      (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1)))
    throw new Error("视频短窗口参数无效");
  const width = o.region?.width ?? o.width, height = o.region?.height ?? o.height;
  const buffer = new Uint8Array(width * height * 3);
  const filters = [`trim=start=${o.start}:end=${o.end}`];
  // Also enforce the output contract for codecs that ignore skip_frame.
  // trim rounds to the stream timebase. Enforce the requested lower bound
  // again before writing RGB so a cropped restart cannot emit the old frame.
  if (o.keyframesOnly) filters.push(`select='key*gte(t,${o.start - 1e-6})'`);
  if (o.fps) filters.push(`select='isnan(prev_selected_t)+gt(floor(t*${o.fps}+0.000001),floor(prev_selected_t*${o.fps}+0.000001))'`);
  filters.push("format=rgb24");
  if (o.region) filters.push(`crop=${width}:${height}:${o.region.x}:${o.region.y}:exact=1`);
  filters.push("showinfo=checksum=0");
  const times: number[] = [];
  let wake: (() => void) | undefined, stderrEnded = false;
  let filled = 0, frames = 0, bytesRead = 0;
  const run = runMedia(toolsPath(toolsDir, "ffmpeg"), [
    "-nostdin", "-v", "info", "-noautorotate", "-copyts", "-start_at_zero", "-ss", String(o.start),
    ...(o.keyframesOnly ? ["-skip_frame", "nokey"] : []), "-i", source,
    "-map", "0:v:0", "-an", "-vf", filters.join(","),
    ...(o.limit ? ["-frames:v", String(o.limit)] : []),
    "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], {
    signal: o.signal, event: o.event, streamOutput: true,
    stderrLine(line) {
      const match = line.match(/Parsed_showinfo.*\bn:\s*\d+.*\bpts_time:([\d.eE+-]+)/);
      if (match) { times.push(Number(match[1])); wake?.(); wake = undefined; }
    },
    stderrEnd() { stderrEnded = true; wake?.(); wake = undefined; },
    async consume(bytes) {
      bytesRead += bytes.length;
      for (let offset = 0; offset < bytes.length;) {
        const take = Math.min(buffer.length - filled, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + take), filled);
        offset += take; filled += take;
        if (filled !== buffer.length) continue;
        checkCancelled(o.signal);
        // showinfo is emitted before the corresponding RGB frame. The separate
        // pipe may be delivered later, so yield without retaining more frames.
        if (!times.length && !stderrEnded) await new Promise<void>((resolve) => { wake = resolve; });
        checkCancelled(o.signal);
        if (!times.length) throw new Error("视频帧缺少原录像时间戳");
        const time = times.shift()!;
        // trim works in the stream timebase and may round its exclusive end.
        let proceed: void | false = undefined;
        if (time >= o.start - 1e-6 && time < o.end - 1e-6)
          proceed = await o.consume({ data: buffer, width, height, channels: 3 }, time);
        frames++; filled = 0;
        await Bun.sleep(0);
        if (proceed === false) return false;
      }
    },
  });
  // Cancellation wakes a pending timestamp wait as well as killing FFmpeg.
  const abort = () => { stderrEnded = true; wake?.(); wake = undefined; };
  o.signal?.addEventListener("abort", abort, { once: true });
  try { await run; }
  finally { o.signal?.removeEventListener("abort", abort); }
  if (filled) throw new Error("解码得到不完整的视频帧");
  return { frames, bytesRead };
}

// A demux seek lands at/before the requested tail on a keyframe. Packet PTS
// handles VFR and reordered frames without decoding the tail a second time;
// the RGB request then emits at most the final two original frames.
export async function tailFrameStart(source: string, toolsDir: string, duration: number, signal?: AbortSignal, event?: (e: WorkerEvent) => void) {
  const data = JSON.parse(await runMedia(toolsPath(toolsDir, "ffprobe"), [
    "-v", "error", "-select_streams", "v:0", "-read_intervals", `${Math.max(0, duration - 5)}%`,
    "-show_packets", "-show_format", "-show_entries", "packet=pts_time:format=start_time", "-of", "json", source,
  ], { signal, event }));
  const origin = Number(data.format?.start_time ?? 0);
  const times = (data.packets ?? []).map((f: any) => Number(f.pts_time) - origin)
    // Audio preroll may give the container a negative start. Match the same
    // normalized, exclusive end as the RGB stream, so an out-of-range packet
    // cannot displace the second-to-last available frame.
    .filter((t: number) => Number.isFinite(t) && t >= 0 && t < duration - 1e-6)
    .sort((a: number, b: number) => a - b);
  return Math.max(0, (times.at(-2) ?? times.at(-1) ?? duration) - .000001);
}

// Restart from the same sampling grid, then drop already-consumed sample indices
// inside FFmpeg. Seeking by seconds would shift fps rounding on VFR recordings.
export async function streamVideoFrames(
  source: string,
  toolsDir: string,
  options: {
    width: number;
    height: number;
    fps: number;
    startFrame?: number;
    region?: Region;
    signal?: AbortSignal;
    event?: (e: WorkerEvent) => void;
    consume: (frame: Image, index: number) => void | false | Promise<void | false>;
  },
) {
  const { region, fps, signal } = options,
    start = options.startFrame ?? 0,
    width = region?.width ?? options.width,
    height = region?.height ?? options.height,
    frameBytes = width * height * 3,
    buffer = new Uint8Array(frameBytes),
    filters = [`fps=${fps}:start_time=0`];
  if (start) filters.push(`trim=start_frame=${start}`);
  // Convert before cropping to preserve the existing RGB values, including
  // chroma interpolation at odd crop origins and different source formats.
  filters.push("format=rgb24");
  if (region)
    filters.push(`crop=${width}:${height}:${region.x}:${region.y}:exact=1`);
  let filled = 0, frames = 0, bytesRead = 0;
  await runMedia(toolsPath(toolsDir, "ffmpeg"), [
    "-nostdin", "-v", "error", "-noautorotate", "-i", source, "-an",
    "-vf", filters.join(","), "-fps_mode", "passthrough",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], {
    signal, event: options.event, streamOutput: true,
    async consume(bytes) {
      bytesRead += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const take = Math.min(frameBytes - filled, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled !== frameBytes) continue;
        checkCancelled(signal);
        const proceed = await options.consume(
          { data: buffer, width, height, channels: 3 }, start + frames,
        );
        frames++;
        filled = 0;
        // Allow cancellation-file checks even when FFmpeg has buffered frames.
        await Bun.sleep(0);
        if (proceed === false) return false;
      }
    },
  });
  if (filled) throw new Error("解码得到不完整的视频帧");
  return { frames, bytesRead };
}

export async function doctor(toolsDir: string) {
  const ffmpeg = toolsPath(toolsDir, "ffmpeg"),
    ffprobe = toolsPath(toolsDir, "ffprobe");
  for (const tool of [ffmpeg, ffprobe])
    if (!(await Bun.file(tool).exists()))
      throw new Error(`缺少媒体工具：${tool}。请保留完整发布目录。`);
  const [version, probeVersion, encoders] = await Promise.all([
    runMedia(ffmpeg, ["-version"]),
    runMedia(ffprobe, ["-version"]),
    runMedia(ffmpeg, ["-hide_banner", "-encoders"]),
  ]);
  if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders))
    throw new Error(
      "此 FFmpeg 缺少 libx264 / AAC 编码器，请使用完整预编译版本",
    );
  return {
    ffmpeg: version.split("\n")[0],
    ffprobe: probeVersion.split("\n")[0],
    toolsDir,
  };
}
export async function probe(
  source: string,
  toolsDir: string,
  signal?: AbortSignal,
): Promise<MediaInfo> {
  const data = JSON.parse(
    await runMedia(
      toolsPath(toolsDir, "ffprobe"),
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", source],
      { signal },
    ),
  );
  const video = data.streams.find((s: any) => s.codec_type === "video");
  if (!video) throw new Error("录像没有视频轨道");
  const fraction = String(video.avg_frame_rate || video.r_frame_rate)
    .split("/")
    .map(Number);
  let fps = fraction[0] / (fraction[1] ?? 1);
  if (!Number.isFinite(fps) || fps <= 0) {
    const [n, d = 1] = String(video.r_frame_rate).split("/").map(Number);
    fps = n / d;
  }
  const duration = Number(data.format.duration ?? video.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0
  )
    throw new Error("无法确定录像时长或帧率");
  if (video.width * video.height > 7680 * 4320)
    throw new Error("当前版本支持最高 8K 录像");
  return {
    duration,
    width: video.width,
    height: video.height,
    fps,
    hasAudio: data.streams.some((s: any) => s.codec_type === "audio"),
    videoCodec: video.codec_name,
  };
}
// Identify local recordings without reading their contents.
export async function identify(source: string, signal?: AbortSignal): Promise<Identity> {
  checkCancelled(signal);
  const path = await realpath(source), info = await stat(path);
  checkCancelled(signal);
  if (!info.isFile()) throw new Error("请选择录像文件");
  return { path, size: info.size, mtimeMs: info.mtimeMs };
}
export async function verifySource(expected: Identity, signal?: AbortSignal) {
  const current = await identify(expected.path, signal);
  // Legacy SHA-256 fields remain readable but never trigger a full-file scan.
  if (current.path !== expected.path || current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs)
    throw new Error("原录像已变更，请重新分析");
}
export async function atomicJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, JSON.stringify(value, null, 2) + "\n");
    await import("node:fs/promises").then((fs) => fs.rename(temporary, path));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function frameInterval(clip: Clip, media: MediaInfo) {
  if (
    ![clip.start, clip.end].every(Number.isFinite) ||
    clip.start < 0 ||
    clip.end <= clip.start ||
    clip.end > media.duration + 0.001
  )
    throw new Error("裁剪区间无效");
  const first = Math.ceil(clip.start * media.fps - 1e-4),
    last = Math.max(first + 1, Math.ceil(clip.end * media.fps - 1e-4));
  return {
    start: first / media.fps,
    duration: (last - first) / media.fps,
    frames: last - first,
  };
}
export async function renderClip(
  source: string,
  clip: Clip,
  media: MediaInfo,
  output: string,
  toolsDir: string,
  signal?: AbortSignal,
  preview = false,
  event?: (e: WorkerEvent) => void,
) {
  const { start, duration, frames } = frameInterval(clip, media);
  await mkdir(dirname(output), { recursive: true });
  if (await Bun.file(output).exists()) throw new Error("输出文件已存在");
  const temporary = join(dirname(output), `.render-${crypto.randomUUID()}.mp4`);
  const scale = preview
    ? ",scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2"
    : ",scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const args = [
    "-nostdin",
    "-v",
    "error",
    "-n",
    "-ss",
    start.toFixed(9),
    "-i",
    source,
    "-map",
    "0:v:0",
    "-vf",
    `trim=duration=${duration.toFixed(9)},setpts=PTS-STARTPTS${scale}`,
  ];
  if (media.hasAudio)
    args.push(
      "-map",
      "0:a:0",
      "-af",
      `atrim=duration=${duration.toFixed(9)},asetpts=PTS-STARTPTS,apad=whole_dur=${duration.toFixed(9)}`,
    );
  args.push(
    "-t",
    duration.toFixed(9),
    "-r",
    String(media.fps),
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    preview ? "ultrafast" : "fast",
    "-crf",
    preview ? "25" : "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    temporary,
  );
  try {
    await runMedia(toolsPath(toolsDir, "ffmpeg"), args, { signal, event });
    checkCancelled(signal);
    // COPYFILE_EXCL works on NTFS and removable drives; existing user files are never replaced.
    await copyFile(temporary, output, constants.COPYFILE_EXCL);
    return { start, end: start + duration, frames };
  } finally {
    await rm(temporary, { force: true });
  }
}

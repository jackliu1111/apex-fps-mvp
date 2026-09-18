import { damageClips } from "../src/core/damage";
import { resolve, join, dirname } from "node:path";
import { mkdir, copyFile, rm, readdir } from "node:fs/promises";
import { strict as assert } from "node:assert";
import {
  doctor,
  locateTools,
  probe,
  runMedia,
  toolsPath,
  frameInterval,
} from "../src/media";
import {
  audioDefaults,
  damageDefaults,
  type Job,
  type Analysis,
} from "../src/shared";

const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const root = resolve(import.meta.dir, ".."),
  binary = option("--binary") ? resolve(option("--binary")!) : undefined;
if (!binary) await import("./build-web");
const toolsDir = option("--tools-dir")
  ? resolve(option("--tools-dir")!)
  : binary
    ? join(dirname(binary), "tools")
    : locateTools();
const work = resolve(
  option("--work-dir") || join(root, "work", `verify-${Date.now()}`),
);
const outputDir = join(work, "输出 片段"),
  dataDir = join(work, "state");
await mkdir(work, { recursive: true });
await doctor(toolsDir);
const fixture = join(work, "测试 录像.mkv"),
  second = join(work, "第二场.mkv");
await makeFixture(fixture);
await copyFile(fixture, second);
const checks: string[] = [],
  passed = (name: string) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
let service: Awaited<ReturnType<typeof launch>> | undefined;
try {
  service = await launch();
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(service!.base + path, {
      headers: {
        "x-apex-token": service!.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await response.json();
    if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  };
  const config = await api("/api/config");
  assert.equal(config.toolError, undefined);
  assert.equal((await fetch(service.base + "/api/jobs")).status, 401);
  assert.equal(
    (
      await fetch(service.base + "/api/config", {
        headers: {
          "x-apex-token": service.token,
          origin: "https://example.com",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(service.base + "/api/config", {
        headers: { "x-apex-token": "x".repeat(64) },
      })
    ).status,
    401,
  );
  const page = await fetch(service.base);
  assert.match(await page.text(), /app\.js/);
  assert.match(
    page.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  const files = await api(
    "/api/browse?path=" + encodeURIComponent(`"${fixture}"`),
  );
  assert.equal(files.file.path, fixture);
  passed(
    "loopback authentication, origin, embedded page and quoted Chinese file path",
  );

  const settings = {
    mode: "damage",
    audio: audioDefaults,
    // Keep three separate candidates for preview and selection/export checks.
    damage: {
      ...damageDefaults,
      sampling_fps: 8,
      gap_s: 0.3,
      before_s: 0.3,
      after_s: 0.5,
    },
  };
  const started: Job = await api("/api/analyze", {
    sources: [fixture, second],
    settings,
    outputDir,
  });
  await assert.rejects(
    api("/api/analyze", { sources: [fixture], settings, outputDir }),
    /当前任务/,
  );
  const analysisJob = await waitJob(started.id, api);
  assert.equal(
    analysisJob.status,
    "completed",
    analysisJob.error || "任务未完成",
  );
  assert.equal(analysisJob.analyses.length, 2);
  for (const a of analysisJob.analyses) {
    assert.equal(a.damage_strategy, "keyframes-v1");
    assert.deepEqual(a.damageEvents, []);
    assert.deepEqual(a.damageWindows!.filter(w => w.highlighted).map(w => [w.start, w.end, w.net_increase]),
      [[5, 10, 39], [15, 20, 14], [25, 30, 43]]);
    assert.equal(a.clips.length, 3);
    assert(a.clips.every(c => c.window_count === 1 && c.event_count === 0));
    assert.equal(a.stats.keyframe_points, 7);
    assert.equal(a.stats.sampled_frames, a.stats.keyframe_points);
    assert.equal(a.stats.readable_frames, 7);
    assert.equal(a.source.sha256, undefined);
  }
  assert(analysisJob.logs?.some((e) => e.stage === "分析统计" && e.message.includes("关键帧")));
  assert(analysisJob.logs?.some((e) => e.stage === "任务完成"));
  assert.equal(analysisJob.stages?.length, 8);
  assert(analysisJob.stages?.every((s) => s.status === "completed" && s.elapsedMs! >= 0));
  assert.equal(new Set(analysisJob.stages?.map((s) => s.sourceKey)).size, 2);
  const a = analysisJob.analyses[0];
  passed(
    "two-file keyframe analysis, three inferred windows without fabricated events, busy rejection",
  );
  let preview: any;
  for (let i = 0; i < 600; i++) {
    preview = await api("/api/preview", { analysisId: a.id, index: 0 });
    if (preview.status === "completed") break;
    assert.notEqual(preview.status, "failed", preview.error);
    await Bun.sleep(100);
  }
  assert.equal(preview.status, "completed");
  const partial = await fetch(service.base + preview.url, {
    headers: { range: "bytes=0-99" },
  });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);
  const suffix = await fetch(service.base + preview.url, {
    headers: { range: "bytes=-10" },
  });
  assert.equal((await suffix.arrayBuffer()).byteLength, 10);
  assert.equal(
    (
      await fetch(service.base + preview.url, {
        headers: { range: "bytes=99999999999-" },
      })
    ).status,
    416,
  );
  const previewInfo = await probe(
    join(dataDir, "previews", `${a.id}_0.mp4`),
    toolsDir,
  );
  assert.equal(previewInfo.videoCodec, "h264");
  assert.equal(previewInfo.hasAudio, true);
  passed(
    "H.264/AAC preview, seeking, suffix ranges and invalid-range rejection",
  );

  const selected = [
    { analysisId: a.id, indices: [0, 2] },
    { analysisId: analysisJob.analyses[1].id, indices: [1] },
  ];
  const exportJob = await waitJob(
    (await api("/api/export", { selections: selected, outputDir })).id,
    api,
  );
  assert.equal(exportJob.status, "completed", exportJob.error || "任务未完成");
  assert.equal(exportJob.exports.length, 3);
  for (const file of exportJob.exports) {
    const info = JSON.parse(
      await runMedia(toolsPath(toolsDir, "ffprobe"), [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-of",
        "json",
        file.path,
      ]),
    );
    const video = info.streams.find((s: any) => s.codec_type === "video"),
      audio = info.streams.find((s: any) => s.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(audio.codec_name, "aac");
    assert.equal(video.width, 640);
    assert.equal(video.height, 360);
    assert.equal(
      Number(video.nb_read_frames),
      frameInterval(file.clip, a.media).frames,
    );
    const selection = await Bun.file(
      join(dirname(file.path), "selection.json"),
    ).json();
    assert.ok(selection.clips.length);
  }
  const again = await waitJob(
    (await api("/api/export", { selections: [selected[0]], outputDir })).id,
    api,
  );
  assert.equal(again.status, "completed", again.error || "任务未完成");
  assert.notEqual(
    dirname(again.exports[0].path),
    dirname(exportJob.exports[0].path),
  );
  for (const file of exportJob.exports)
    assert.ok(await Bun.file(file.path).exists());
  passed(
    "selected multi-file export, exact frame counts, audio and non-overwriting repeat export",
  );

  const audioJob = await waitJob(
    (
      await api("/api/analyze", {
        sources: [fixture],
        settings: {
          ...settings,
          mode: "audio",
          audio: {
            ...audioDefaults,
            threshold_percentile: 75,
            min_events: 1,
            fight_gap_s: 0.1,
            event_bridge_ms: 0,
            before_s: 0.1,
            after_s: 0.2,
          },
        },
        outputDir,
      })
    ).id,
    api,
  );
  assert.equal(audioJob.status, "completed", audioJob.error || "任务未完成");
  assert.ok(audioJob.analyses[0].audioEvents.length >= 4);
  assert.ok(audioJob.analyses[0].clips.length >= 4);
  passed("audio decoding, energy analysis and candidate generation");

  await Bun.write(second, new Uint8Array([1, 2, 3]));
  const rejected = await waitJob(
    (await api("/api/export", { selections: [selected[1]], outputDir })).id,
    api,
  );
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error!, /变更/);
  await copyFile(fixture, second);
  passed("source modification prevents exporting stale analysis");

  const cancelJob: Job = await api("/api/analyze", {
    sources: [fixture, second],
    settings: { ...settings, damage: { ...settings.damage, sampling_fps: 60 } },
    outputDir,
  });
  await waitStage(cancelJob.id, api, "关键帧识别");
  await api("/api/cancel", { id: cancelJob.id });
  const cancelledAnalysis = await waitJob(cancelJob.id, api);
  assert.equal(cancelledAnalysis.status, "cancelled");
  assert(cancelledAnalysis.logs?.some((e) => e.stage === "任务取消"));
  assert.equal(cancelledAnalysis.stages?.at(-1)?.status, "cancelled");
  const afterCancel = await waitJob(
    (
      await api("/api/analyze", {
        sources: [fixture],
        settings: { ...settings, mode: "audio" },
        outputDir,
      })
    ).id,
    api,
  );
  assert.equal(
    afterCancel.status,
    "completed",
    afterCancel.error || "任务未完成",
  );
  passed("cancellation cleans up and allows the next task");

  const cancelledOutput = join(work, "取消导出");
  const exporting: Job = await api("/api/export", {
    selections: [{ analysisId: a.id, indices: [0, 1, 2] }],
    outputDir: cancelledOutput,
  });
  await waitStage(exporting.id, api, "导出片段");
  await api("/api/cancel", { id: exporting.id });
  const cancelledExport = await waitJob(exporting.id, api);
  assert.equal(cancelledExport.status, "cancelled");
  assert.equal(cancelledExport.exports.length, 0);
  assert.equal((await readdir(cancelledOutput)).length, 0);
  passed("cancelling active FFmpeg export removes unfinished output");

  await api("/api/shutdown", {});
  await stopped(service);
  // Seed a completed legacy-schema job without rewriting any existing task.
  const legacy = structuredClone(analysisJob);
  legacy.id = crypto.randomUUID();
  legacy.analyses = [structuredClone(a)];
  const old = legacy.analyses[0];
  old.id = crypto.randomUUID();
  old.warnings = ["未知读数与计数下降会重新建立基线。"];
  old.stats = { sampled_frames: 960, readable_frames: 960, sampling_fps: 30 };
  legacy.logs = []; legacy.stages = []; legacy.logCount = 0;
  delete old.damage_strategy; delete old.damageWindows; delete old.damageProbes; delete old.damage_parameters;
  old.damageEvents = [{ time: 8, previous: 64, value: 103, increase: 39 }, { time: 18, previous: 103, value: 117, increase: 14 }, { time: 28, previous: 117, value: 160, increase: 43 }];
  old.readings = [{ time: 0, value: 64 }, { time: 8, value: 103 }, { time: 18, value: 117 }, { time: 28, value: 160 }];
  old.clips = damageClips(old.damageEvents, old.media.duration, settings.damage);
  const legacyPath = join(dataDir, "jobs", legacy.id, "job.json");
  const legacyText = JSON.stringify(legacy);
  await mkdir(dirname(legacyPath), { recursive: true });
  await Bun.write(legacyPath, legacyText);
  const interval = structuredClone(analysisJob);
  interval.id = crypto.randomUUID();
  interval.analyses = [structuredClone(a)];
  interval.logs = []; interval.stages = []; interval.logCount = 0;
  const intervalAnalysis = interval.analyses[0];
  intervalAnalysis.id = crypto.randomUUID();
  intervalAnalysis.damage_strategy = 'interval-v1';
  intervalAnalysis.damage_parameters = { ...damageDefaults, probe_interval_s: 5, dense_fps: 10 };
  intervalAnalysis.damageWindows!.forEach(w => { w.source = w.reason === 'unknown' ? 'dense' : 'endpoints'; });
  intervalAnalysis.readings.forEach(r => { r.source = 'probe'; });
  intervalAnalysis.warnings = ['历史 5 秒探测结果'];
  const intervalPath = join(dataDir, 'jobs', interval.id, 'job.json');
  const intervalText = JSON.stringify(interval);
  await mkdir(dirname(intervalPath), { recursive: true });
  await Bun.write(intervalPath, intervalText);
  service = await launch();
  const loadedLegacy: Job = await api("/api/jobs/" + legacy.id);
  assert.deepEqual(loadedLegacy, legacy);
  let legacyPreview: any;
  for (let i = 0; i < 600; i++) {
    legacyPreview = await api("/api/preview", { analysisId: old.id, index: 0 });
    if (legacyPreview.status === "completed") break;
    assert.notEqual(legacyPreview.status, "failed", legacyPreview.error);
    await Bun.sleep(100);
  }
  assert.equal(legacyPreview.status, "completed");
  const legacyExport = await waitJob((await api("/api/export", {
    selections: [{ analysisId: old.id, indices: [0] }], outputDir,
  })).id, api);
  assert.equal(legacyExport.status, "completed", legacyExport.error || "旧任务导出失败");
  assert.equal(await Bun.file(legacyPath).text(), legacyText);
  passed("legacy results restore, preview and export without rewriting saved evidence");
  assert.deepEqual(await api('/api/jobs/' + interval.id), interval);
  let intervalPreview: any;
  for (let i = 0; i < 600; i++) {
    intervalPreview = await api('/api/preview', { analysisId: intervalAnalysis.id, index: 0 });
    if (intervalPreview.status === 'completed') break;
    assert.notEqual(intervalPreview.status, 'failed', intervalPreview.error);
    await Bun.sleep(100);
  }
  assert.equal(intervalPreview.status, 'completed');
  const intervalExport = await waitJob((await api('/api/export', {
    selections: [{ analysisId: intervalAnalysis.id, indices: [0] }], outputDir,
  })).id, api);
  assert.equal(intervalExport.status, 'completed', intervalExport.error || '区间旧任务导出失败');
  assert.equal(await Bun.file(intervalPath).text(), intervalText);
  passed('interval-v1 results restore, preview and export without rewriting saved evidence');
  const restored: Job = await api("/api/jobs/" + analysisJob.id);
  assert.equal(restored.analyses.length, 2);
  assert.equal(restored.status, "completed");
  assert.deepEqual(restored.logs, analysisJob.logs);
  assert.deepEqual(restored.stages, analysisJob.stages);
  const interrupted: Job = await api("/api/analyze", {
    sources: [fixture, second],
    settings: { ...settings, damage: { ...settings.damage, sampling_fps: 60 } },
    outputDir,
  });
  await waitStage(interrupted.id, api, "关键帧识别");
  await api("/api/shutdown", {});
  await stopped(service);
  service = await launch();
  assert.equal((await api("/api/jobs/" + interrupted.id)).status, "cancelled");
  passed("restart restores results; shutdown cancels active worker");
  await api("/api/shutdown", {});
  await stopped(service);
  service = undefined;
  await Bun.write(
    join(work, "verification.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        binary: binary || "source",
        toolsDir,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`完整流程验证通过（${checks.length} 项）：${work}`);
} finally {
  if (service) {
    service.child.kill();
    await service.child.exited;
  }
}

async function makeFixture(path: string) {
  const crops = new Uint8Array(
      await Bun.file(join(root, "tests/fixtures/hud.rgb")).arrayBuffer(),
    ),
    raw = join(work, "frames.rgb");
  const file = Bun.file(raw).writer();
  for (let index = 1; index <= 4; index++) {
    const data = new Uint8Array(640 * 360 * 3).fill(35),
      crop = crops.subarray(index * 54000, (index + 1) * 54000);
    for (let y = 0; y < 90; y++)
      data.set(
        crop.subarray(y * 600, (y + 1) * 600),
        ((y + 50) * 640 + 400) * 3,
      );
    for (let repeat = 0; repeat < [0, 64, 80, 80, 32][index]; repeat++) file.write(data);
  }
  await file.end();
  try {
    await runMedia(toolsPath(toolsDir, "ffmpeg"), [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      "640x360",
      "-r",
      "8",
      "-i",
      raw,
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='0.4*sin(2*PI*800*t)*lt(mod(t,1),0.15)':s=16000:d=32",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264rgb",
      "-crf", "0", "-g", "40", "-keyint_min", "40", "-sc_threshold", "0",
      "-pix_fmt",
      "rgb24",
      "-c:a",
      "pcm_s16le",
      "-t",
      "32",
      path,
    ]);
  } finally {
    await rm(raw, { force: true });
  }
}
async function launch() {
  const command = binary
    ? [binary]
    : [process.execPath, join(root, "src/main.ts")];
  const child = Bun.spawn(
    [
      ...command,
      "--no-open",
      "--tools-dir",
      toolsDir,
      "--data-dir",
      dataDir,
      "--output-dir",
      outputDir,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: root },
  );
  let text = "",
    errors = "",
    url = "";
  const stdout = (async () => {
    for await (const bytes of child.stdout) {
      text += new TextDecoder().decode(bytes);
      const found = text.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/);
      if (found) url = found[0];
    }
  })();
  const stderr = (async () => {
    for await (const bytes of child.stderr)
      errors += new TextDecoder().decode(bytes);
  })();
  for (let i = 0; i < 300 && !url; i++) {
    if (child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  if (!url) {
    child.kill();
    await child.exited;
    await stderr;
    throw new Error(`启动失败：${text}\n${errors}`);
  }
  const parsed = new URL(url);
  return {
    child,
    base: parsed.origin,
    token: new URLSearchParams(parsed.hash.slice(1)).get("token")!,
    stdout,
    stderr,
  };
}
async function stopped(s: Awaited<ReturnType<typeof launch>>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      s.child.exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("服务未在 15 秒内退出")),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  await s.stdout;
  await s.stderr;
  assert.equal(s.child.exitCode, 0);
}
async function waitJob(
  id: string,
  api: (path: string, body?: unknown) => Promise<any>,
): Promise<Job> {
  for (let i = 0; i < 1800; i++) {
    const job: Job = await api("/api/jobs/" + id);
    if (!["running", "cancelling"].includes(job.status)) return job;
    await Bun.sleep(100);
  }
  throw new Error(`任务超时：${id}`);
}

async function waitStage(
  id: string,
  api: (path: string, body?: unknown) => Promise<any>,
  stage: string | string[],
) {
  for (let i = 0; i < 3000; i++) {
    const job: Job = await api("/api/jobs/" + id);
    if ((typeof stage === "string" ? [stage] : stage).some((s) => job.progress.stage.startsWith(s))) return;
    if (job.status !== "running")
      throw new Error(`任务在目标阶段前结束：${job.status} ${job.error || ""}`);
    await Bun.sleep(10);
  }
  throw new Error(`等待任务阶段超时：${stage}`);
}

import { expect, test } from "bun:test";
import { appendLog, finishStage, MAX_TASK_LOGS, recordProgress } from "../src/journal";
import type { Job, Progress } from "../src/shared";
const job = (): Job => ({ id: "test", kind: "analyze", status: "running", created: new Date(0).toISOString(), progress: { stage: "准备中", current: 0, total: 1 }, analyses: [], exports: [], outputDir: "test" });
const progress = (phase: Progress["phase"], sourceKey = "/a/video.mkv"): Progress => ({ phase, stage: phase!, sourceKey, source: "video.mkv", current: 1, total: 100, detail: "已处理 1 帧" });
test("stage durations and identical filenames remain separate across sources", () => {
  const j = job();
  recordProgress(j, progress("validate"), 1000);
  recordProgress(j, progress("global"), 1200);
  recordProgress(j, progress("local"), 3200);
  recordProgress(j, progress("finalize"), 4000);
  finishStage(j, "completed", 4500);
  recordProgress(j, progress("validate", "/b/video.mkv"), 5000);
  expect(j.stages?.map((s) => s.elapsedMs)).toEqual([200, 2000, 800, 500, undefined]);
  expect(j.stages?.at(-1)?.sourceKey).toBe("/b/video.mkv");
  expect(j.stages?.filter((s) => s.status === "running")).toHaveLength(1);
});
test("high-frequency progress is throttled while important events remain immediate and bounded", () => {
  const j = job();
  for (let i = 0; i < 600; i++) recordProgress(j, progress("global"), i * 200);
  expect(j.progress.current).toBe(1);
  expect(j.logs).toHaveLength(24);
  appendLog(j, { stage: "定位成功", message: "立即记录", level: "info" }, 120000);
  expect(j.logs?.at(-1)?.message).toBe("立即记录");
  for (let i = 0; i < 600; i++) appendLog(j, { stage: "test", message: String(i), level: "info" });
  expect(j.logs).toHaveLength(MAX_TASK_LOGS);
  expect(j.logCount).toBe(625);
  expect(j.logs?.[0].id).toBe(326);
});
test("failed and cancelled stages are never marked successful, and terminal handling is idempotent", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const j = job();
    recordProgress(j, progress("global"), 1000);
    finishStage(j, status, 2400);
    const count = j.logCount;
    finishStage(j, "completed", 3000);
    expect(j.stages?.[0].status).toBe(status);
    expect(j.stages?.[0].elapsedMs).toBe(1400);
    expect(j.logCount).toBe(count);
  }
});

test("interrupted jobs retain their last checkpoint and load older jobs without logs", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Jobs } = await import("../src/jobs");
  const directory = await mkdtemp(join(tmpdir(), "apex-journal-"));
  try {
    const j = job();
    j.id = crypto.randomUUID();
    recordProgress(j, progress("global"), 1000);
    recordProgress(j, progress("global"), 7000);
    await mkdir(join(directory, j.id));
    await Bun.write(join(directory, j.id, "job.json"), JSON.stringify(j));
    const legacy = { ...job(), id: crypto.randomUUID(), status: "completed" as const };
    await mkdir(join(directory, legacy.id));
    await Bun.write(join(directory, legacy.id, "job.json"), JSON.stringify(legacy));
    const jobs = new Jobs(directory, directory);
    await jobs.load();
    const recovered = jobs.items.get(j.id)!;
    expect(recovered.status).toBe("failed");
    expect(recovered.stages?.[0].elapsedMs).toBe(6000);
    expect(recovered.stages?.[0].status).toBe("failed");
    expect(recovered.logs?.at(-1)?.stage).toBe("任务中断");
    expect(jobs.items.get(legacy.id)?.logs).toBeUndefined();
    const reloaded = new Jobs(directory, directory);
    await reloaded.load();
    expect(reloaded.items.get(j.id)?.logs).toEqual(recovered.logs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import type { Job, Progress, StageRecord, TaskLog } from "./shared";

export const MAX_TASK_LOGS = 300;
export function appendLog(
  job: Job,
  entry: Omit<TaskLog, "id" | "at">,
  now = Date.now(),
) {
  job.logCount = (job.logCount ?? job.logs?.at(-1)?.id ?? 0) + 1;
  const logs = job.logs ??= [];
  logs.push({ ...entry, id: job.logCount, at: new Date(now).toISOString() });
  if (logs.length > MAX_TASK_LOGS) logs.splice(0, logs.length - MAX_TASK_LOGS);
}
export function finishStage(
  job: Job,
  status: Exclude<StageRecord["status"], "running">,
  now = Date.now(),
) {
  const active = job.stages?.at(-1);
  if (!active || active.status !== "running") return;
  active.status = status;
  active.ended = new Date(now).toISOString();
  active.elapsedMs = Math.max(0, now - Date.parse(active.started));
  const outcome = { completed: "阶段结束", cancelled: "已取消", failed: "中断" }[status];
  appendLog(job, {
    level: status === "failed" ? "error" : "info",
    stage: active.label,
    source: active.source,
    message: `${outcome}，耗时 ${(active.elapsedMs / 1000).toFixed(1)} 秒`,
  }, now);
}
// Stage transitions are retained immediately. A progress snapshot is appended
// at most every five seconds, keeping both the worker pipe and polling small.
export function recordProgress(job: Job, progress: Progress, now = Date.now()): boolean {
  const previous = job.progress;
  job.progress = progress;
  const active = job.stages?.at(-1);
  const changed = previous.stage !== progress.stage || previous.sourceKey !== progress.sourceKey;
  if (progress.phase && (active?.phase !== progress.phase || active.sourceKey !== progress.sourceKey)) {
    finishStage(job, "completed", now);
    (job.stages ??= []).push({
      phase: progress.phase, label: progress.stage, source: progress.source,
      sourceKey: progress.sourceKey, status: "running", started: new Date(now).toISOString(),
    });
    appendLog(job, { level: "info", stage: progress.stage, source: progress.source,
      message: progress.detail || "开始处理" }, now);
    return true;
  }
  const last = job.logs?.at(-1);
  if (changed || (progress.detail && now - Date.parse(last?.at ?? job.created) >= 5000)) {
    appendLog(job, { level: "info", stage: progress.stage, source: progress.source,
      message: progress.detail || "开始处理" }, now);
    return true;
  }
  return false;
}

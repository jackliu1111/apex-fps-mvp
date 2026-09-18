import { join, resolve } from "node:path";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { atomicJSON } from "./media";
import type { Job, WorkerEvent, WorkerRequest } from "./shared";
import { appendLog, finishStage, recordProgress } from "./journal";

declare const APEX_COMPILED: boolean;
export function selfCommand(): string[] {
  return typeof APEX_COMPILED !== "undefined" && APEX_COMPILED
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, "main.ts")];
}
export class Jobs {
  items = new Map<string, Job>();
  private starting = false;
  private processes = new Map<
    string,
    {
      child: ReturnType<typeof Bun.spawn>;
      mediaPids: Set<number>;
      done: Promise<void>;
    }
  >();
  constructor(
    readonly directory: string,
    readonly toolsDir: string,
  ) {}
  async load() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory);
    for (const id of entries) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const job: Job = await Bun.file(
          join(this.directory, id, "job.json"),
        ).json();
        if (job.id !== id || !Array.isArray(job.analyses)) continue;
        if (job.status === "running" || job.status === "cancelling") {
          job.status = "failed";
          job.error = "上次程序退出，任务未完成；已完成结果仍可查看。";
          // A restart cannot know the exact interruption time. Stop the saved
          // duration at its last checkpoint instead of counting offline time.
          finishStage(job, "failed", Date.parse(job.logs?.at(-1)?.at ?? job.created));
          appendLog(job, { level: "error", stage: "任务中断", message: job.error });
          await atomicJSON(join(this.directory, id, "job.json"), job);
        }
        this.items.set(id, job);
      } catch {
        /* Ignore incomplete writes or unrelated files. */
      }
    }
  }
  busy() {
    return [...this.items.values()].some(
      (j) => j.status === "running" || j.status === "cancelling",
    );
  }
  list() {
    return [...this.items.values()]
      .sort((a, b) => b.created.localeCompare(a.created))
      .map(({ analyses, logs, stages, logCount, ...job }) => ({
        ...job,
        analyses: analyses.map((a) => ({
          id: a.id,
          name: a.name,
          clips: a.clips.length,
        })),
      }));
  }
  async start(
    request: Omit<WorkerRequest, "jobDir" | "toolsDir">,
  ): Promise<Job> {
    if (this.starting || this.busy()) throw new Error("请先完成或取消当前任务");
    this.starting = true;
    try {
      const id = crypto.randomUUID(),
        jobDir = join(this.directory, id);
      const job: Job = {
        id,
        kind: request.kind,
        status: "running",
        created: new Date().toISOString(),
        progress: { stage: "准备中", current: 0, total: 1 },
        analyses: [],
        exports: [],
        outputDir: request.outputDir,
        mode: request.settings?.mode,
        logs: [],
        stages: [],
      };
      appendLog(job, { level: "info", stage: "准备中", message:
        request.kind === "analyze" ? `开始分析 ${request.sources?.length ?? 0} 个录像` : "开始导出所选片段" });
      await mkdir(jobDir);
      await atomicJSON(join(jobDir, "job.json"), job);
      const file = join(jobDir, "request.json");
      await atomicJSON(file, { ...request, jobDir, toolsDir: this.toolsDir });
      this.items.set(id, job);
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = Bun.spawn([...selfCommand(), "--worker", file], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          windowsHide: true,
        });
      } catch (error) {
        job.status = "failed";
        job.error = String(error);
        appendLog(job, { level: "error", stage: "启动失败", message: job.error });
        await atomicJSON(join(jobDir, "job.json"), job);
        throw error;
      }
      const mediaPids = new Set<number>();
      const done = this.readWorker(job, child, mediaPids);
      this.processes.set(id, { child, mediaPids, done });
      void done.finally(() => this.processes.delete(id));
      return job;
    } finally {
      this.starting = false;
    }
  }
  private async readWorker(
    job: Job,
    child: ReturnType<typeof Bun.spawn>,
    mediaPids: Set<number>,
  ) {
    let stderr = "",
      final = false;
    let failureLogged = false;
    const recordFailure = () => {
      if (failureLogged || (job.status !== "cancelled" && job.status !== "failed")) return;
      failureLogged = true;
      finishStage(job, job.status);
      appendLog(job, { level: job.status === "failed" ? "error" : "warning",
        stage: job.status === "failed" ? "任务失败" : "任务取消",
        message: job.error || "任务已停止" });
    };
    const errors = (async () => {
      if (child.stderr && typeof child.stderr !== "number")
        for await (const bytes of child.stderr) {
          stderr = (stderr + new TextDecoder().decode(bytes)).slice(-8000);
          await appendFile(join(this.directory, job.id, "worker.stderr.log"), bytes);
        }
    })();
    try {
      let pending = "";
      const decoder = new TextDecoder();
      if (!child.stdout || typeof child.stdout === "number")
        throw new Error("工作进程未提供输出");
      for await (const bytes of child.stdout) {
        pending += decoder.decode(bytes, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const e: WorkerEvent = JSON.parse(line);
          let journalChanged = false;
          if (e.type === "progress") journalChanged = recordProgress(job, e.progress);
          if (e.type === "log") {
            appendLog(job, e.entry);
            journalChanged = true;
          }
          if (e.type === "pid") {
            if (e.active) mediaPids.add(e.pid);
            else mediaPids.delete(e.pid);
          }
          if (e.type === "analysis") {
            finishStage(job, "completed");
            appendLog(job, { level: "info", stage: "录像分析完成", source: e.analysis.name,
              message: `生成 ${e.analysis.clips.length} 个候选片段` });
            job.analyses.push(e.analysis);
            await atomicJSON(join(this.directory, job.id, "job.json"), job);
          }
          if (e.type === "export") {
            job.exports.push(e.file);
            await atomicJSON(join(this.directory, job.id, "job.json"), job);
          }
          if (e.type === "done") {
            final = true;
            job.status = "completed";
            job.progress = { stage: "完成", current: 1, total: 1 };
            finishStage(job, "completed");
            appendLog(job, { level: "info", stage: "任务完成", message: "所有录像已处理完成" });
          }
          if (e.type === "error") {
            final = true;
            job.status =
              e.cancelled || job.status === "cancelling"
                ? "cancelled"
                : "failed";
            job.error = job.status === "cancelled" ? "任务已取消" : e.error;
            recordFailure();
          }
          if (journalChanged)
            await atomicJSON(join(this.directory, job.id, "job.json"), job);
        }
      }
      const code = await child.exited;
      await errors;
      if (!final || (code !== 0 && job.status === "completed")) {
        job.status = job.status === "cancelling" ? "cancelled" : "failed";
        job.error = stderr.trim() || workerExitError(code, child.signalCode);
      }
    } catch (error) {
      job.status = "failed";
      job.error = String(error);
    } finally {
      recordFailure();
      for (const pid of mediaPids) {
        try {
          process.kill(pid);
        } catch {}
      }
      try {
        child.kill();
      } catch {}
      await child.exited;
      await errors.catch(() => {});
      await atomicJSON(join(this.directory, job.id, "job.json"), job);
    }
  }
  async cancel(id: string) {
    const job = this.items.get(id);
    if (!job) throw new Error("任务不存在");
    if (job.status !== "running") return;
    job.status = "cancelling";
    appendLog(job, { level: "warning", stage: "正在取消", message: "已请求取消，正在停止媒体处理" });
    await Bun.write(join(this.directory, id, "cancel"), "cancel");
    const processInfo = this.processes.get(id);
    // Interrupt FFmpeg immediately, including on Windows; the worker handles its cleanup.
    for (const pid of processInfo?.mediaPids ?? []) {
      try {
        process.kill(pid);
      } catch {}
    }
  }
  async close() {
    const active = [...this.processes.entries()];
    if (!active.length) return;
    for (const [id] of active) await this.cancel(id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(active.map(([, p]) => p.done)),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 10_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    for (const [id, p] of this.processes) {
      for (const pid of p.mediaPids) {
        try {
          process.kill(pid);
        } catch {}
      }
      try {
        p.child.kill();
      } catch {}
    }
    await Promise.all(active.map(([, p]) => p.done));
  }
}

export function workerExitError(code: number, signal: string | null): string {
  const reason = signal || (code === 133 ? "SIGTRAP" : code === 139 ? "SIGSEGV" : null);
  return reason
    ? `分析工作进程崩溃（${reason}，退出码 ${code}，Bun ${Bun.version}）；已保留任务日志和 OCR 调试图片。`
    : `工作进程提前退出（${code}，Bun ${Bun.version}）`;
}

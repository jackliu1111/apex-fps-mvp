import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, LoaderCircle, Minus, X } from "lucide-react";
import { analysisStageNames, type AnalysisPhase, type Job } from "../shared";

const preferenceKey = "apex.analysisLogsVisible";
const labels = { running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", pending: "待开始", skipped: "未执行", unrecorded: "无记录" };
const duration = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.floor(ms / 1000) % 60} 秒`;

export function TaskMonitor({ job, showStages = true }: { job: Job; showStages?: boolean }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(preferenceKey) !== "false"; } catch { return true; }
  });
  const [pageEnd, setPageEnd] = useState<number | null>(null);
  const [following, setFollowing] = useState(true);
  const [now, setNow] = useState(Date.now());
  const viewport = useRef<HTMLDivElement>(null), lastScroll = useRef(0), panelId = useId();
  const logs = job.logs ?? [], stages = job.stages ?? [];
  const running = job.status === "running" || job.status === "cancelling";
  const sourceKey = job.progress.sourceKey ?? stages.at(-1)?.sourceKey;
  const currentStages = stages.filter((s) => s.sourceKey === sourceKey);
  const source = currentStages.at(-1)?.source ?? job.progress.source;
  const phases: AnalysisPhase[] = job.mode === "audio" || stages.some((s) => s.phase === "audio")
    ? ["validate", "probe", "audio", "finalize"]
    : stages.some(s => s.phase === "global" || s.phase === "local") ||
      job.analyses.some(a => a.mode === "damage" && !a.damage_strategy)
      ? ["validate", "probe", "global", "local", "finalize"]
      : stages.some(s => s.phase === "sparse" || s.phase === "dense") || job.analyses.some(a => a.damage_strategy === "interval-v1")
        ? ["validate", "probe", "sparse", "dense", "finalize"]
        : ["validate", "probe", "keyframes", "finalize"];
  const entries = (pageEnd === null ? logs : logs.filter((e) => e.id <= pageEnd)).slice(-50);
  const lastId = logs.at(-1)?.id;
  const currentIndex = phases.indexOf(currentStages.at(-1)?.phase!);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const node = viewport.current;
    if (node && open) node.scrollTop = following && pageEnd === null ? node.scrollHeight : lastScroll.current;
  }, [open, lastId, pageEnd, following]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || !open || !following || pageEnd !== null) return;
    const observer = new ResizeObserver(() => { node.scrollTop = node.scrollHeight; });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, following, pageEnd]);
  function toggle() {
    setOpen(!open);
    try { localStorage.setItem(preferenceKey, String(!open)); } catch {}
  }
  function latest() { lastScroll.current = 0; setPageEnd(null); setFollowing(true); }
  return (
    <section className="task-monitor" aria-label="分析阶段与日志">
      {showStages && (
        <div className="stage-overview">
          <div className="stage-heading"><h3>阶段状态</h3>{source && <span>{source}</span>}</div>
          <ol className="stage-list">
            {phases.map((phase, index) => {
              const record = currentStages.find((s) => s.phase === phase);
              const state = record?.status ?? (!stages.length && !running ? "unrecorded" : index < currentIndex || !running ? "skipped" : "pending");
              const elapsed = record ? record.elapsedMs ?? Math.max(0, now - Date.parse(record.started)) : undefined;
              const Icon = state === "running" ? LoaderCircle : state === "completed" ? Check : state === "failed" || state === "cancelled" ? X : state === "skipped" ? Minus : Circle;
              return (
                <li key={phase} className={`stage-item ${state}`} aria-current={state === "running" ? "step" : undefined}>
                  <Icon size={16} className={state === "running" ? "spin" : undefined} aria-hidden="true" />
                  <span className="stage-name">{phase === "finalize" && phases.includes("audio") ? "生成声音轴与候选" : analysisStageNames[phase]}</span>
                  <span className="stage-state">{labels[state]}{elapsed !== undefined && ` · ${duration(elapsed)}`}</span>
                </li>
              );
            })}
          </ol>
          {!stages.length && !running && <p className="muted">此历史任务没有阶段记录。</p>}
        </div>
      )}
      <div className="log-heading">
        <button type="button" className="log-toggle" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
          {open ? <ChevronDown size={17} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
          <strong>分析日志</strong><span>{open ? "隐藏日志" : "显示日志"}</span>
        </button>
        <span className="log-count">{(job.logCount ?? logs.length) > logs.length ? `保留最近 ${logs.length} 条` : `${logs.length} 条记录`}</span>
      </div>
      <div id={panelId} hidden={!open}>
        <div className="log-tools">
          <span>{following && pageEnd === null ? "跟随最新" : "正在查看历史记录"} · 隐藏后仍会记录</span>
          <div>
            <button type="button" className="ghost" disabled={!entries.length || entries[0].id <= (logs[0]?.id ?? 0)} onClick={() => {
              lastScroll.current = 0; setPageEnd(entries[0].id - 1); setFollowing(false);
            }}>更早记录</button>
            <button type="button" className="ghost" disabled={following && pageEnd === null} onClick={latest}>回到最新</button>
          </div>
        </div>
        <div className="log-viewport" ref={viewport} role="log" aria-label="分析日志记录" aria-live="off" tabIndex={0} onScroll={(e) => {
          const node = e.currentTarget;
          lastScroll.current = node.scrollTop;
          if (pageEnd === null) setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
        }}>
          {!entries.length && <p className="log-empty">{logs.length ? "这部分记录已超出保留范围，请回到最新记录。" : running ? "等待第一条分析日志…" : "此历史任务没有详细日志，新分析的任务会自动记录。"}</p>}
          {entries.map((entry) => (
            <div className={`log-entry ${entry.level}`} key={entry.id}>
              <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
              <div><span className="log-stage">{entry.stage}</span>{entry.level !== "info" && <span className="log-level">{entry.level === "error" ? "错误" : "提示"}</span>}
                {entry.source && <span className="log-source">{entry.source}</span>}
                <p>{entry.message}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

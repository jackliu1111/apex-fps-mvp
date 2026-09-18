import { damageSegments } from "../core/damage-curve";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Download,
  FileVideo,
  Folder,
  FolderOpen,
  Gauge,
  History,
  LoaderCircle,
  Play,
  Plus,
  Power,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import {
  audioDefaults,
  damageDefaults,
  timecode,
  type Analysis,
  type Job,
  type Settings,
} from "../shared";
import "./style.css";
import { TaskMonitor } from "./TaskMonitor";
import { BrandMark } from "./BrandMark";

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("token")) {
  sessionStorage.setItem("apexToken", fragment.get("token")!);
  history.replaceState(null, "", location.pathname);
}
const token = sessionStorage.getItem("apexToken") || "";
async function api<T = any>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: {
      "x-apex-token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GB`
    : `${(n / 1024 ** 2).toFixed(1)} MB`;
const busy = (job: Job | null) =>
  job?.status === "running" || job?.status === "cancelling";
const statusNames = {
  running: "处理中",
  cancelling: "正在取消",
  completed: "已完成",
  cancelled: "已取消",
  failed: "未完成",
};
type Source = { name: string; path: string; size: number };
type BrowserEntry = Source & { directory: boolean };

function FileBrowser({
  initial,
  chosen,
  onAdd,
  onClose,
  onDirectory,
}: {
  initial: string;
  chosen: Source[];
  onAdd: (files: Source[]) => void;
  onClose: () => void;
  onDirectory?: (path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [path, setPath] = useState(initial),
    [query, setQuery] = useState(initial);
  const [listing, setListing] = useState<{
    path: string;
    parent: string;
    items: BrowserEntry[];
    roots: string[];
    truncated: boolean;
  }>();
  const [selected, setSelected] = useState<Source[]>(chosen),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api(
      "/api/browse?path=" + encodeURIComponent(query),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (data.file) {
          setSelected((previous) => [
            ...previous.filter((p) => p.path !== data.file.path),
            data.file,
          ]);
          setQuery(data.parent);
        } else {
          setListing(data);
          setPath(data.path);
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query]);
  const toggle = (entry: Source) =>
    setSelected((previous) =>
      previous.some((s) => s.path === entry.path)
        ? previous.filter((s) => s.path !== entry.path)
        : [...previous, entry],
    );
  return (
    <dialog
      className="file-dialog"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="browser-title"
    >
      <div className="dialog-head">
        <div>
          <span className="eyebrow">本地文件</span>
          <h2 id="browser-title">
            {onDirectory ? "选择输出目录" : "添加录像"}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭文件选择"
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      <form
        className="path-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(path);
        }}
      >
        <label className="sr-only" htmlFor="browse-path">
          目录或录像路径
        </label>
        <button
          type="button"
          className="icon-button"
          disabled={!listing || loading}
          aria-label="上一级目录"
          onClick={() => setQuery(listing!.parent)}
        >
          <ArrowLeft />
        </button>
        <input
          id="browse-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="粘贴目录或录像完整路径"
          autoFocus
        />
        <button className="secondary">前往</button>
      </form>
      <div className="root-links">
        {listing?.roots.map((root) => (
          <button key={root} onClick={() => setQuery(root)}>
            {root === initial ? "个人目录" : root}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="file-list" aria-busy={loading}>
        {loading ? (
          <div className="empty">
            <LoaderCircle className="spin" />
            正在读取目录
          </div>
        ) : listing?.items.length ? (
          listing.items.map((entry) => (
            <div
              key={entry.path}
              className={
                "browser-row " +
                (selected.some((s) => s.path === entry.path) ? "chosen" : "")
              }
            >
              {entry.directory ? (
                <button
                  className="directory-entry"
                  onClick={() => setQuery(entry.path)}
                >
                  <Folder />
                  <span>{entry.name}</span>
                  <ChevronRight />
                </button>
              ) : (
                !onDirectory && (
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.some((s) => s.path === entry.path)}
                      onChange={() => toggle(entry)}
                    />
                    <FileVideo />
                    <span>{entry.name}</span>
                    <small>{bytes(entry.size)}</small>
                  </label>
                )
              )}
            </div>
          ))
        ) : (
          <div className="empty">
            <FolderOpen />
            此目录没有可选录像或子目录
          </div>
        )}
      </div>
      {listing?.truncated && (
        <p className="muted">目录项目较多，请输入更具体的子目录。</p>
      )}
      <div className="dialog-foot">
        <span className="muted">
          {onDirectory
            ? "导出文件保存在你选择的目录中"
            : `已选择 ${selected.length} 个录像，可跨目录添加`}
        </span>
        <button
          className="primary"
          disabled={onDirectory ? !listing || loading : !selected.length}
          onClick={() => {
            if (onDirectory) onDirectory(listing!.path);
            else onAdd(selected);
            onClose();
          }}
        >
          <Check size={17} />
          {onDirectory ? "使用此目录" : "确认添加"}
        </button>
      </div>
    </dialog>
  );
}

function Timeline({
  analysis,
  selected,
  active,
  onPick,
}: {
  analysis: Analysis;
  selected: number[];
  active: number;
  onPick: (index: number) => void;
}) {
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(analysis.media.duration),
    [eventIndex, setEventIndex] = useState(-1);
  useEffect(() => {
    setStart(0);
    setEnd(analysis.media.duration);
    setEventIndex(-1);
  }, [analysis.id]);
  const a = Math.max(0, Math.min(start, analysis.media.duration - 0.001)),
    b = Math.min(analysis.media.duration, Math.max(a + 0.001, end));
  const W = 1000,
    L = 56,
    R = 980,
    top = 25,
    floor = 141;
  const x = (t: number) => L + ((t - a) / (b - a)) * (R - L),
    damage = analysis.mode === "damage";
  const values = damage
    ? analysis.readings.filter((r) => r.value !== null).map((r) => r.value!)
    : analysis.curve.map((p) => p.max);
  const max = damage
      ? values.reduce((m, v) => Math.max(m, v), 100) * 1.1
      : values.reduce((m, v) => Math.max(m, v), -1),
    min = damage ? 0 : -90;
  const y = (v: number) =>
    floor - Math.max(0, Math.min(1, (v - min) / (max - min))) * (floor - top);
  const paths: string[] = [];
  const estimates: string[] = [];
  const keyframes = analysis.damage_strategy === "keyframes-v1";
  const interval = keyframes || analysis.damage_strategy === "interval-v1";
  const growthWindows = (analysis.damageWindows ?? []).filter(w => w.highlighted);
  const growthCount = interval ? growthWindows.length : analysis.damageEvents.length;
  if (damage) {
    for (const segment of damageSegments(analysis)) {
      if (segment.end < a || segment.start > b) continue;
      const left = Math.max(a, segment.start), right = Math.min(b, segment.end);
      const value = (t: number) => segment.start === segment.end ? segment.to :
        segment.from + (segment.to - segment.from) * (t - segment.start) / (segment.end - segment.start);
      const d = segment.start === segment.end
        ? `M${x(left)},${y(segment.from)}L${x(right)},${y(segment.to)}`
        : `M${x(left)},${y(value(left))}L${x(right)},${y(value(right))}`;
      (segment.estimated ? estimates : paths).push(d);
    }
  } else {
    const data = analysis.curve.filter((p) => p.time >= a && p.time <= b);
    if (data.length)
      paths.push(
        data.map((p, i) => `${i ? "L" : "M"}${x(p.time)},${y(p.max)}`).join(""),
      );
  }
  const zoomClip = () => {
    const clip = analysis.clips[active];
    if (clip) {
      setStart(Math.max(0, clip.start - 2));
      setEnd(Math.min(analysis.media.duration, clip.end + 2));
    }
  };
  const gotoEvent = (direction: number) => {
    const index = Math.max(
      0,
      Math.min(growthCount - 1, eventIndex + direction),
    );
    setEventIndex(index);
    const window = growthWindows[index];
    if (interval && window) {
      setStart(Math.max(0, window.start - 2));
      setEnd(Math.min(analysis.media.duration, window.end + 2));
      return;
    }
    const e = analysis.damageEvents[index];
    if (e) {
      setStart(Math.max(0, e.time - 3));
      setEnd(Math.min(analysis.media.duration, e.time + 3));
    }
  };
  return (
    <section className="timeline panel" aria-labelledby="timeline-heading">
      <div className="section-head">
        <div>
          <span className="eyebrow">原录像时间轴</span>
          <h3 id="timeline-heading">
            {damage ? "伤害计数" : "音频能量"}
            <small>{damage ? "读数 · 点数" : "峰值 · dBFS"}</small>
          </h3>
        </div>
        <div className="toolbar">
          <button
            className="ghost"
            onClick={() => {
              setStart(0);
              setEnd(analysis.media.duration);
            }}
          >
            全片
          </button>
          <button
            className="secondary"
            onClick={zoomClip}
            disabled={!analysis.clips.length}
          >
            <ZoomIn size={16} />
            当前片段
          </button>
        </div>
      </div>
      <svg
        className="curve"
        viewBox={`0 0 ${W} 200`}
        role="img"
        aria-label={`${damage ? "累计伤害读数，未知区间不连线" : "音频峰值"}。显示 ${timecode(a)} 至 ${timecode(b)}；候选片段另有勾选列表。`}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={L}
              x2={R}
              y1={y(min + f * (max - min))}
              y2={y(min + f * (max - min))}
              className="grid-line"
            />
            <text x={L - 12} y={y(min + f * (max - min)) + 4} textAnchor="end">
              {Math.round(min + f * (max - min))}
            </text>
          </g>
        ))}
        {analysis.clips.map((clip, i) =>
          clip.end < a || clip.start > b ? null : (
            <rect
              key={i}
              x={x(Math.max(a, clip.start))}
              y={top}
              width={Math.max(
                2,
                x(Math.min(b, clip.end)) - x(Math.max(a, clip.start)),
              )}
              height={floor - top}
              className={
                selected.includes(i) ? "clip-range selected" : "clip-range"
              }
            >
              <title>
                候选 {i + 1}：{timecode(clip.start)} — {timecode(clip.end)}
              </title>
            </rect>
          ),
        )}
        {!damage && analysis.threshold !== undefined && (
          <line
            x1={L}
            x2={R}
            y1={y(analysis.threshold)}
            y2={y(analysis.threshold)}
            className="threshold"
          />
        )}
        <path d={paths.join(" ")} className="signal-line" strokeLinecap="round" />
        <path d={estimates.join(" ")} className="signal-line" strokeDasharray="6 4"><title>区间估算</title></path>
        {keyframes && analysis.readings.filter(r => r.value !== null && r.time >= a && r.time <= b).map(r => (
          <circle key={r.time} cx={x(r.time)} cy={y(r.value!)} r="3" className="event-dot">
            <title>{timecode(r.time)} · 关键帧读数 {r.value}</title>
          </circle>
        ))}
        {damage &&
          analysis.damageEvents
            .filter((e) => e.time >= a && e.time <= b)
            .map((e) => (
              <circle
                key={e.time}
                cx={x(e.time)}
                cy={y(e.value)}
                r="4"
                className="event-dot"
              >
                <title>
                  {timecode(e.time)} · {e.previous} → {e.value}（+{e.increase}）
                </title>
              </circle>
            ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text
            key={f}
            x={x(a + f * (b - a))}
            y="174"
            textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
          >
            {timecode(a + f * (b - a), false)}
          </text>
        ))}
      </svg>
      <div className="chart-legend">
        <span>
          <i className="legend-signal" />
          {keyframes ? "圆点：关键帧实际读数" : damage ? "实线：实际伤害读数" : "音频峰值"}
        </span>
        <span>
          <i className="legend-clip" />
          已选裁剪范围
        </span>
        {interval && <span>{keyframes ? "虚线 = 关键帧区间估算" : "虚线 = 区间估算（5 秒）"}</span>}
        {damage ? <span>{keyframes ? "断线 = 未知或计数下降" : "空白 = 未知读数"}</span> : <span>虚线 = 检测阈值</span>}
      </div>
      <div className="range-controls">
        <label>
          起点（秒）
          <input
            type="number"
            min="0"
            max={analysis.media.duration}
            step="0.1"
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
          />
        </label>
        <label>
          终点（秒）
          <input
            type="number"
            min="0"
            max={analysis.media.duration}
            step="0.1"
            value={end}
            onChange={(e) => setEnd(Number(e.target.value))}
          />
        </label>
        {damage && (
          <div className="event-controls">
            <button
              className="ghost"
              disabled={!growthCount || eventIndex <= 0}
              onClick={() => gotoEvent(-1)}
            >
              {interval ? "上次增长窗口" : "上次增长"}
            </button>
            <button
              className="ghost"
              disabled={
                !growthCount ||
                eventIndex >= growthCount - 1
              }
              onClick={() => gotoEvent(1)}
            >
              {interval ? "下次增长窗口" : "下次增长"}
            </button>
          </div>
        )}
      </div>
      {damage && (
        <details>
          <summary>{interval ? "查看增长窗口与实际读数" : "查看增长事件与原始读数"}</summary>
          <div className="evidence">
            <div>
              {interval && growthWindows.map(w => (
                <p key={w.start}>
                  <strong>{timecode(w.start)} — {timecode(w.end)}</strong>
                  <span>{w.source === "keyframes" ? "关键帧区间估算" : w.source === "endpoints" ? "区间估算" : "10 FPS 补查"} · 端点净变化 {w.net_increase === null ? "未知" : `${w.net_increase >= 0 ? "+" : ""}${w.net_increase}`}</span>
                  {w.source === "dense" && <b>已确认增长 +{w.confirmed_increase ?? 0}</b>}
                </p>
              ))}
              {!interval && analysis.damageEvents.map((e) => (
                <p key={e.time}>
                  <strong>{timecode(e.time)}</strong>
                  <span>
                    {e.previous} → {e.value}
                  </span>
                  <b>+{e.increase}</b>
                </p>
              ))}
              {!growthCount && <p>{interval ? "没有高亮窗口" : "没有确认的增长事件"}</p>}
            </div>
            <div>
              {analysis.readings
                .filter((r) => r.time >= a && r.time <= b)
                .slice(0, 200)
                .map((r) => (
                  <p key={r.time}>
                    <strong>{timecode(r.time)}</strong>
                    <span>{r.value === null ? "未知" : r.value}</span>
                  </p>
                ))}
              <small>
                显示当前时间范围内前 200 条实际读数；完整证据保存在任务结果中。
              </small>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

function App() {
  const [config, setConfig] = useState<{
      home: string;
      outputDir: string;
      toolError?: string;
    }>(),
    [error, setError] = useState("");
  const [sources, setSources] = useState<Source[]>([]),
    [outputDir, setOutputDir] = useState("");
  const [settings, setSettings] = useState<Settings>({
    mode: "damage",
    audio: { ...audioDefaults },
    damage: { ...damageDefaults },
  });
  const [phase, setPhase] = useState(1),
    [browser, setBrowser] = useState<"source" | "output" | null>(null),
    [job, setJob] = useState<Job | null>(null);
  const [analysisJob, setAnalysisJob] = useState<Job | null>(null),
    [analysisId, setAnalysisId] = useState(""),
    [activeClip, setActiveClip] = useState(0);
  const [selection, setSelection] = useState<Record<string, number[]>>({}),
    [requesting, setRequesting] = useState(false),
    [historyItems, setHistoryItems] = useState<any[]>([]);
  const [preview, setPreview] = useState<{
      url?: string;
      status: string;
      error?: string;
    }>({ status: "idle" }),
    [previewTarget, setPreviewTarget] = useState<{
      analysisId: string;
      index: number;
    } | null>(null);
  const [stopped, setStopped] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    api("/api/config")
      .then((c) => {
        setConfig(c);
        setOutputDir(c.outputDir);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    title.current?.focus();
  }, [phase]);
  useEffect(() => {
    if (!job || !busy(job)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const fresh: Job = await api(
          `/api/jobs/${job.id}`,
          undefined,
          controller.signal,
        );
        setJob(fresh);
        if (!busy(fresh)) {
          if (fresh.kind === "analyze") {
            setAnalysisJob(fresh);
            setAnalysisId(fresh.analyses[0]?.id || "");
            setActiveClip(0);
            setSelection(
              Object.fromEntries(
                fresh.analyses.map((a) => [a.id, a.clips.map((_, i) => i)]),
              ),
            );
            if (fresh.analyses.length) setPhase(3);
          }
          return;
        }
      } catch (e: any) {
        if (e.name !== "AbortError")
          setError("连接中断，请检查程序是否仍在运行。");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 600);
    };
    timer = setTimeout(poll, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!previewTarget) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setPreview({ status: "running" });
    const poll = async () => {
      try {
        const data = await api(
          "/api/preview",
          previewTarget,
          controller.signal,
        );
        setPreview(data);
        if (data.status === "running") timer = setTimeout(poll, 800);
      } catch (e: any) {
        if (e.name !== "AbortError")
          setPreview({ status: "failed", error: e.message });
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [previewTarget]);
  const analysis = analysisJob?.analyses.find((a) => a.id === analysisId),
    selected = selection[analysisId] ?? [];
  const selectedCount = Object.values(selection).reduce(
    (n, a) => n + a.length,
    0,
  );
  const selectedDuration = (analysisJob?.analyses ?? []).reduce(
    (sum, a) =>
      sum +
      (selection[a.id] ?? []).reduce(
        (s, i) => s + a.clips[i].end - a.clips[i].start,
        0,
      ),
    0,
  );
  async function action(fn: () => Promise<void>) {
    setError("");
    setRequesting(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRequesting(false);
    }
  }
  async function analyze() {
    await action(async () => {
      const next = await api<Job>("/api/analyze", {
        sources: sources.map((s) => s.path),
        settings,
        outputDir,
      });
      setJob(next);
      setPhase(2);
      setPreviewTarget(null);
    });
  }
  async function exportClips() {
    await action(async () => {
      const next = await api<Job>("/api/export", {
        outputDir,
        selections: Object.entries(selection).map(([analysisId, indices]) => ({
          analysisId,
          indices,
        })),
      });
      setJob(next);
      setPhase(4);
    });
  }
  function toggleClip(index: number) {
    setSelection((previous) => {
      const s = previous[analysisId] ?? [];
      return {
        ...previous,
        [analysisId]: s.includes(index)
          ? s.filter((i) => i !== index)
          : [...s, index].sort((a, b) => a - b),
      };
    });
  }
  function pick(index: number) {
    setActiveClip(index);
    setPreviewTarget({ analysisId, index });
  }
  function newTask() {
    setPhase(1);
    setJob(null);
    setAnalysisJob(null);
    setSelection({});
    setPreviewTarget(null);
    setError("");
  }
  const heading =
    phase === 1
      ? "把精彩片段，留在时间轴上。"
      : phase === 2
        ? busy(job) ? "正在分析你的录像" : job?.status === "completed" ? "录像分析完成" : "分析已停止"
        : phase === 3
          ? "检查候选，留下值得回看的瞬间。"
          : phase === 4
            ? "导出你的精选片段"
            : "最近的任务";
  const progress = job?.progress,
    percent = progress
      ? Math.min(
          100,
          Math.round((progress.current / Math.max(1, progress.total)) * 100),
        )
      : 0;
  if (stopped)
    return (
      <div className="stopped">
        <CheckCheck size={40} />
        <h1>程序已退出</h1>
        <p>现在可以关闭这个标签页。下次双击程序即可继续使用。</p>
      </div>
    );
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            <strong>APEX HIGHLIGHT</strong>
            <span>本地录像工作台</span>
          </div>
        </div>
        <button className="new-task" disabled={busy(job)} onClick={newTask}>
          <Plus size={18} />
          新建任务
        </button>
        <div className="nav-label">工作流程</div>
        <nav aria-label="工作流程">
          {[
            { n: 1, title: "选择录像", icon: FolderOpen },
            { n: 2, title: "分析录像", icon: ScanLine },
            { n: 3, title: "检查与选片", icon: SlidersHorizontal },
            { n: 4, title: "导出片段", icon: Download },
          ].map(({ n, title: text, icon: Icon }) => (
            <button
              key={n}
              className={phase === n ? "nav-item active" : "nav-item"}
              aria-current={phase === n ? "step" : undefined}
              disabled={
                n === 1
                  ? busy(job)
                  : n === 2
                    ? !job || job.kind !== "analyze"
                    : n === 3
                      ? !analysisJob
                      : !job || job.kind !== "export"
              }
              onClick={() => setPhase(n)}
            >
              <Icon size={18} />
              <span>{text}</span>
              <small>0{n}</small>
            </button>
          ))}
        </nav>
        <button
          className={"nav-item history-nav " + (phase === 5 ? "active" : "")}
          disabled={busy(job)}
          onClick={() =>
            void action(async () => {
              setHistoryItems(await api("/api/jobs"));
              setPhase(5);
            })
          }
        >
          <History size={18} />
          最近任务
        </button>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={17} />
            <span>视频始终留在本机</span>
          </div>
          <button
            className="nav-item"
            onClick={() =>
              void action(async () => {
                await api("/api/shutdown", {});
                setStopped(true);
              })
            }
          >
            <Power size={17} />
            {busy(job) ? "取消任务并退出" : "退出程序"}
          </button>
        </div>
      </aside>
      <main id="main">
        <header className="topbar">
          <span>
            工作台 <ChevronRight size={13} />{" "}
            {phase === 5
              ? "最近任务"
              : ["选择录像", "分析录像", "检查与选片", "导出片段"][phase - 1]}
          </span>
          <span className="local-badge">
            <i />
            本机运行
          </span>
        </header>
        <div className="workspace">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {phase === 5 ? "你的工作记录" : `STEP 0${phase} / 04`}
              </span>
              <h1 tabIndex={-1} ref={title}>
                {heading}
              </h1>
              <p>
                {phase === 1
                  ? "批量分析游戏录像，按伤害增长或音频能量发现候选片段。"
                  : phase === 3
                    ? "候选由程序生成，导出前请播放检查。"
                    : "处理结果会自动保存在本机，稍后可以从最近任务继续查看。"}
              </p>
            </div>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button aria-label="关闭提示" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {config?.toolError && (
            <div className="error" role="alert">
              {config.toolError}
            </div>
          )}
          {phase === 1 && (
            <div className="setup-grid">
              <section className="panel source-panel">
                <div className="section-head">
                  <h2>
                    录像列表{" "}
                    <small>
                      {sources.length
                        ? `${sources.length} 个文件`
                        : "支持批量选择"}
                    </small>
                  </h2>
                  <button
                    className="secondary"
                    disabled={!config}
                    onClick={() => setBrowser("source")}
                  >
                    <Plus size={16} />
                    添加录像
                  </button>
                </div>
                {!sources.length ? (
                  <button
                    className="import-area"
                    disabled={!config}
                    onClick={() => setBrowser("source")}
                  >
                    <div className="import-icon">
                      <FileVideo size={34} />
                    </div>
                    <strong>选择要分析的录像</strong>
                    <span>浏览本机目录，或粘贴文件路径</span>
                    <small>MP4 · MKV · MOV · WEBM · AVI</small>
                  </button>
                ) : (
                  <div className="source-list">
                    {sources.map((source, i) => (
                      <div className="source-row" key={source.path}>
                        <span className="file-number">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <FileVideo size={22} />
                        <div>
                          <strong>{source.name}</strong>
                          <span title={source.path}>{source.path}</span>
                        </div>
                        <small>{bytes(source.size)}</small>
                        <button
                          className="icon-button"
                          aria-label={`移除 ${source.name}`}
                          onClick={() =>
                            setSources((previous) =>
                              previous.filter((p) => p.path !== source.path),
                            )
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="panel-note">
                  <ShieldCheck size={16} />
                  <span>直接读取本地文件，无需上传或复制整段录像。</span>
                </div>
              </section>
              <section className="panel settings-panel">
                <div className="section-head">
                  <h2>分析方式</h2>
                  <SlidersHorizontal size={18} />
                </div>
                <button
                  className={
                    "mode-card " +
                    (settings.mode === "damage" ? "selected" : "")
                  }
                  aria-pressed={settings.mode === "damage"}
                  onClick={() => setSettings((s) => ({ ...s, mode: "damage" }))}
                >
                  <ScanLine />
                  <div>
                    <strong>伤害增长</strong>
                    <span>识别累计伤害变化，定位短促高能片段。</span>
                  </div>
                  <span className="radio-dot" />
                </button>
                <button
                  className={
                    "mode-card " + (settings.mode === "audio" ? "selected" : "")
                  }
                  aria-pressed={settings.mode === "audio"}
                  onClick={() => setSettings((s) => ({ ...s, mode: "audio" }))}
                >
                  <Activity />
                  <div>
                    <strong>音频能量</strong>
                    <span>根据声音强度，保留较完整的交战候选。</span>
                  </div>
                  <span className="radio-dot" />
                </button>
                {settings.mode === "damage" && <p className="muted">全程只识别关键帧，每帧读一次；按相邻关键帧构建高亮区间，候选基础区间至少 5 秒。</p>}
                <details className="advanced">
                  <summary>调整分析参数</summary>
                  {settings.mode === "damage" ? (
                    <div className="parameter-grid">
                      {[
                        ["gap_s", "增长合并间隔（秒）"],
                        ["before_s", "向前保留（秒）"],
                        ["after_s", "向后保留（秒）"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            min={0}
                            max={3600}
                            step={0.1}
                            value={
                              settings.damage[
                                key as keyof typeof settings.damage
                              ]
                            }
                            onChange={(e) =>
                              setSettings((s) => ({
                                ...s,
                                damage: {
                                  ...s.damage,
                                  [key]: Number(e.target.value),
                                },
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="parameter-grid">
                      {[
                        ["threshold_percentile", "能量分位数（%）"],
                        ["min_events", "最少声音事件"],
                        ["fight_gap_s", "事件合并间隔（秒）"],
                        ["before_s", "向前保留（秒）"],
                        ["after_s", "向后保留（秒）"],
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            min="0"
                            step={key === "min_events" ? 1 : 0.1}
                            value={
                              settings.audio[key as keyof typeof settings.audio]
                            }
                            onChange={(e) =>
                              setSettings((s) => ({
                                ...s,
                                audio: {
                                  ...s.audio,
                                  [key]: Number(e.target.value),
                                },
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </details>
                <div className="output-field">
                  <label htmlFor="output-dir">输出目录</label>
                  <div>
                    <input
                      id="output-dir"
                      value={outputDir}
                      onChange={(e) => setOutputDir(e.target.value)}
                    />
                    <button
                      className="icon-button"
                      aria-label="选择输出目录"
                      onClick={() => setBrowser("output")}
                    >
                      <FolderOpen size={18} />
                    </button>
                  </div>
                </div>
                <button
                  className="primary start-button"
                  disabled={
                    !sources.length || requesting || !!config?.toolError
                  }
                  onClick={() => void analyze()}
                >
                  {requesting ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <ScanLine size={18} />
                  )}
                  开始分析
                  {sources.length > 0 && <span>{sources.length} 个录像</span>}
                </button>
              </section>
              <div className="setup-caption">
                <span>01 选择录像</span>
                <i />
                <span>02 等待分析</span>
                <i />
                <span>03 播放并勾选</span>
                <i />
                <span>04 导出独立片段</span>
              </div>
            </div>
          )}
          {phase === 2 && job && (
            <section className="panel progress-panel">
              <div className="analysis-summary">
                <div className="progress-icon">
                  {busy(job) ? <ScanLine size={34} /> : job.status === "completed" ? <Check size={34} /> : <X size={34} />}
                </div>
                <div>
                  <span className="eyebrow">{statusNames[job.status]}</span>
                  <h2><span role="status">{busy(job) ? job.progress.stage : statusNames[job.status]}</span></h2>
                  <p>{job.progress.source || "正在准备录像"}</p>
                </div>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label={job.progress.stage}
                aria-valuenow={busy(job) && !["global", "local", "audio"].includes(job.progress.phase ?? "") ? undefined : percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div style={{ width: `${percent}%` }} />
              </div>
              <div className="progress-meta">
                <span>已分析 {job.analyses.length} 个录像</span>
                <strong>{["global", "local", "audio"].includes(job.progress.phase ?? "") ? `当前录像 ${percent}%` : busy(job) ? "处理中" : statusNames[job.status]}</strong>
              </div>
              {job.progress.detail && <p className="analysis-detail">{job.progress.detail}</p>}
              {job.error && (
                <p className="error" role="alert">
                  {job.error}
                </p>
              )}
              <p className="muted">
                {busy(job) ? "分析期间可以查看阶段进度、展开日志或取消任务。" : "日志和阶段耗时已保存在当前任务中。"}
              </p>
              {busy(job) ? (
                <button
                  className="secondary"
                  disabled={job.status === "cancelling"}
                  onClick={() =>
                    void action(async () => {
                      await api("/api/cancel", { id: job.id });
                      setJob({ ...job, status: "cancelling" });
                    })
                  }
                >
                  取消分析
                </button>
              ) : (
                <button
                  className="primary"
                  onClick={() =>
                    job.analyses.length ? setPhase(3) : setPhase(1)
                  }
                >
                  {job.analyses.length ? "查看已完成结果" : "返回设置"}
                </button>
              )}
              <TaskMonitor key={job.id} job={job} />
            </section>
          )}
          {phase === 3 && analysisJob && (
            <>
              {analysisJob.error && (
                <div className="notice">
                  {analysisJob.error} · 下方保留已完成录像的结果。
                </div>
              )}
              <div className="panel review-log-panel"><TaskMonitor key={analysisJob.id} job={analysisJob} showStages={false} /></div>
              <div className="review-toolbar">
                <div className="select-field">
                  <label htmlFor="review-source">当前录像</label>
                  <select
                    id="review-source"
                    value={analysisId}
                    onChange={(e) => {
                      setAnalysisId(e.target.value);
                      setActiveClip(0);
                      setPreviewTarget(null);
                      setPreview({ status: "idle" });
                    }}
                  >
                    {analysisJob.analyses.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.clips.length} 个候选
                      </option>
                    ))}
                  </select>
                </div>
                <span className="muted">
                  {analysis &&
                    `${analysis.media.width} × ${analysis.media.height} · ${timecode(analysis.media.duration, false)}`}
                </span>
              </div>
              {analysis && (
                <>
                  <div className="review-grid">
                    <section className="player-panel panel">
                      <div className="player-heading">
                        <span>
                          <Play size={14} />
                          候选预览
                        </span>
                        <span>
                          {analysis.clips[activeClip]
                            ? `片段 ${String(activeClip + 1).padStart(2, "0")}`
                            : "暂无候选"}
                        </span>
                      </div>
                      <div className="video-stage">
                        {previewTarget?.analysisId === analysis.id &&
                        preview.status === "completed" ? (
                          <video
                            key={preview.url}
                            src={preview.url}
                            controls
                            autoPlay
                            playsInline
                            aria-label={`候选片段 ${activeClip + 1} 预览`}
                          />
                        ) : (
                          <div className="video-empty">
                            {previewTarget && preview.status === "running" ? (
                              <>
                                <LoaderCircle className="spin" size={32} />
                                <strong>正在准备预览</strong>
                                <span>首次播放需要生成兼容浏览器的视频。</span>
                              </>
                            ) : preview.status === "failed" ? (
                              <>
                                <strong>预览生成失败</strong>
                                <p role="alert">{preview.error}</p>
                                <button
                                  className="secondary"
                                  onClick={() => pick(activeClip)}
                                >
                                  重试
                                </button>
                              </>
                            ) : (
                              <>
                                <div className="play-placeholder">
                                  <Play size={28} />
                                </div>
                                <strong>
                                  {analysis.clips.length
                                    ? "选一个片段，看看发生了什么"
                                    : "本次没有生成候选片段"}
                                </strong>
                                <span>
                                  {analysis.clips.length
                                    ? "点击右侧播放按钮，在这里检查片段。"
                                    : "可以检查下方原始信号，或返回调整分析参数。"}
                                </span>
                                {analysis.clips.length > 0 && (
                                  <button
                                    className="secondary"
                                    onClick={() => pick(activeClip)}
                                  >
                                    <Play size={15} />
                                    播放当前片段
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="player-footer">
                        <span>原录像区间</span>
                        <strong>
                          {analysis.clips[activeClip]
                            ? `${timecode(analysis.clips[activeClip].start)} — ${timecode(analysis.clips[activeClip].end)}`
                            : "—"}
                        </strong>
                      </div>
                    </section>
                    <section className="panel candidates">
                      <div className="section-head">
                        <h2>
                          候选片段 <small>{analysis.clips.length}</small>
                        </h2>
                        <button
                          className="ghost"
                          disabled={!analysis.clips.length}
                          onClick={() =>
                            setSelection((s) => ({
                              ...s,
                              [analysisId]:
                                selected.length === analysis.clips.length
                                  ? []
                                  : analysis.clips.map((_, i) => i),
                            }))
                          }
                        >
                          {selected.length === analysis.clips.length
                            ? "清空"
                            : "全选"}
                        </button>
                      </div>
                      <div className="candidate-list">
                        {analysis.clips.length ? (
                          analysis.clips.map((clip, i) => (
                            <div
                              key={i}
                              className={
                                "candidate " +
                                (i === activeClip ? "active" : "")
                              }
                            >
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selected.includes(i)}
                                  onChange={() => toggleClip(i)}
                                  aria-label={`选择片段 ${i + 1}`}
                                />
                                <div>
                                  <strong>
                                    片段 {String(i + 1).padStart(2, "0")}
                                    <small>
                                      {(clip.end - clip.start).toFixed(2)} 秒
                                    </small>
                                  </strong>
                                  <span>
                                    {timecode(clip.start)} —{" "}
                                    {timecode(clip.end)}
                                  </span>
                                  <small>
                                    {analysis.damage_strategy === "interval-v1" || analysis.damage_strategy === "keyframes-v1"
                                      ? `${clip.window_count ?? 0} 个高亮窗口`
                                      : `${clip.event_count} 次${analysis.mode === "damage" ? "伤害增长" : "声音事件"}`}
                                  </small>
                                </div>
                              </label>
                              <button
                                className="icon-button"
                                aria-label={`播放片段 ${i + 1}`}
                                onClick={() => pick(i)}
                              >
                                <Play size={17} />
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="empty">
                            <ScanLine />
                            没有候选片段
                          </div>
                        )}
                      </div>
                      <div className="candidate-summary">
                        当前录像已选 <strong>{selected.length}</strong> 个片段
                      </div>
                    </section>
                  </div>
                  <Timeline
                    analysis={analysis}
                    selected={selected}
                    active={activeClip}
                    onPick={pick}
                  />
                  <div className="analysis-note">
                    <ShieldCheck size={17} />
                    <div>
                      {analysis.warnings.map((w) => (
                        <p key={w}>{w}</p>
                      ))}
                      {analysis.mode === "damage" && (
                        <small>
                          已读出 {analysis.stats.readable_frames} /{" "}
                          {analysis.stats.sampled_frames} 帧 · 全局定位{" "}
                          {analysis.stats.global_searches} 次
                        </small>
                      )}
                    </div>
                  </div>
                </>
              )}
              <div className="export-bar">
                <div>
                  <strong>共选择 {selectedCount} 个片段</strong>
                  <span>
                    预计总时长 {timecode(selectedDuration)} · 每段单独导出
                  </span>
                </div>
                <button
                  className="primary"
                  disabled={!selectedCount || requesting || busy(job)}
                  onClick={() => void exportClips()}
                >
                  <Download size={18} />
                  导出已选片段
                  <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}
          {phase === 4 && job && (
            <section className="panel export-panel">
              <div className="export-heading">
                <div className="progress-icon">
                  {busy(job) ? (
                    <Download size={30} />
                  ) : (
                    <CheckCheck size={30} />
                  )}
                </div>
                <div>
                  <span className="eyebrow">{statusNames[job.status]}</span>
                  <h2>
                    {busy(job)
                      ? job.progress.stage
                      : job.status === "completed"
                        ? "片段已经准备好了"
                        : "导出已停止"}
                  </h2>
                  <p>
                    {busy(job)
                      ? job.progress.source
                      : `已保存 ${job.exports.length} 个片段`}
                  </p>
                </div>
              </div>
              {busy(job) && (
                <>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="导出进度"
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div style={{ width: `${percent}%` }} />
                  </div>
                  <p className="muted">
                    正在编码 H.264 / AAC 视频，保持原录像分辨率。
                  </p>
                </>
              )}
              {job.error && (
                <p role="alert" className="error">
                  {job.error}
                </p>
              )}
              <div className="destination">
                <FolderOpen size={20} />
                <div>
                  <small>输出目录</small>
                  <strong>{job.outputDir}</strong>
                </div>
              </div>
              <div className="export-files">
                {job.exports.map((file) => (
                  <div key={file.path}>
                    <FileVideo size={20} />
                    <span>{file.path}</span>
                    <Check size={17} />
                  </div>
                ))}
              </div>
              <div className="export-actions">
                {busy(job) ? (
                  <button
                    className="secondary"
                    disabled={job.status === "cancelling"}
                    onClick={() =>
                      void action(async () => {
                        await api("/api/cancel", { id: job.id });
                        setJob({ ...job, status: "cancelling" });
                      })
                    }
                  >
                    取消导出
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary"
                      onClick={() => (analysisJob ? setPhase(3) : newTask())}
                    >
                      {analysisJob ? "返回选片" : "新建任务"}
                    </button>
                    <button
                      className="primary"
                      disabled={!job.exports.length}
                      onClick={() =>
                        void action(async () => {
                          await api("/api/open-output", { id: job.id });
                        })
                      }
                    >
                      <FolderOpen size={18} />
                      打开输出目录
                    </button>
                  </>
                )}
              </div>
            </section>
          )}
          {phase === 5 && (
            <section className="panel history-panel">
              <div className="section-head">
                <h2>本机任务记录</h2>
                <span className="muted">{historyItems.length} 个任务</span>
              </div>
              {!historyItems.length ? (
                <div className="empty">
                  <History />
                  还没有任务，先添加一段录像吧。
                </div>
              ) : (
                historyItems.map((item) => (
                  <button
                    key={item.id}
                    className="history-row"
                    onClick={() =>
                      void action(async () => {
                        const loaded: Job = await api(`/api/jobs/${item.id}`);
                        setJob(loaded);
                        setOutputDir(loaded.outputDir);
                        if (loaded.kind === "analyze") {
                          setAnalysisJob(loaded);
                          setAnalysisId(loaded.analyses[0]?.id || "");
                          setSelection(
                            Object.fromEntries(
                              loaded.analyses.map((a) => [
                                a.id,
                                a.clips.map((_, i) => i),
                              ]),
                            ),
                          );
                          setActiveClip(0);
                          setPreviewTarget(null);
                          setPreview({ status: "idle" });
                          setPhase(loaded.analyses.length ? 3 : 2);
                        } else {
                          setAnalysisJob(null);
                          setPhase(4);
                        }
                      })
                    }
                  >
                    <span className="history-icon">
                      {item.kind === "analyze" ? (
                        <ScanLine size={21} />
                      ) : (
                        <Download size={21} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {item.kind === "analyze"
                          ? item.analyses.map((a: any) => a.name).join("、") ||
                            "录像分析"
                          : "片段导出"}
                      </strong>
                      <small>
                        {new Date(item.created).toLocaleString()} ·{" "}
                        {statusNames[item.status as keyof typeof statusNames]}
                      </small>
                    </div>
                    <ChevronRight size={18} />
                  </button>
                ))
              )}
            </section>
          )}
          <footer className="page-footer">
            <span>APEX HIGHLIGHT</span>
            <span>本地分析 · 手动检查 · 精确导出</span>
            <p className="affiliation-note">
              非官方玩家项目，与 EA 及其许可方无关联，亦未获其背书。
            </p>
          </footer>
        </div>
      </main>
      {browser && config && (
        <FileBrowser
          initial={config.home}
          chosen={sources}
          onAdd={setSources}
          onClose={() => setBrowser(null)}
          onDirectory={browser === "output" ? setOutputDir : undefined}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

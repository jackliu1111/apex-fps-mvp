export type Mode = "damage" | "audio";
export interface Clip {
  start: number;
  end: number;
  raw_start: number;
  raw_end: number;
  event_count: number;
  window_count?: number;
  peak_dbfs: number;
  exceeds_max_duration?: boolean;
}
export interface AudioEvent {
  start: number;
  end: number;
  peak_dbfs: number;
  active_frames: number;
}
export interface DamageEvent {
  time: number;
  previous: number;
  value: number;
  increase: number;
}
export interface Reading {
  time: number;
  value: number | null;
  source?: "probe" | "dense" | "keyframe";
}
export interface HudAnchor { x: number; y: number; scale: number; score: number }
export interface DamageProbe {
  time: number;
  frame_times: number[];
  value: number | null;
  anchor?: HudAnchor;
  ocr?: import("./paddleocr").OCRObservation;
}
export interface DamageWindow {
  start: number;
  end: number;
  start_value: number | null;
  end_value: number | null;
  net_increase: number | null;
  highlighted: boolean;
  source: "endpoints" | "dense" | "keyframes";
  reason: "increase" | "equal" | "decrease" | "unknown";
  confirmed_increase?: number;
}
export interface CurvePoint {
  time: number;
  min: number;
  max: number;
}
export interface AudioOptions {
  sample_rate: number;
  frame_ms: number;
  threshold_percentile: number;
  event_bridge_ms: number;
  fight_gap_s: number;
  min_events: number;
  before_s: number;
  after_s: number;
  max_clip_s: number;
}
export interface DamageOptions {
  gap_s: number;
  before_s: number;
  after_s: number;
}
export const audioDefaults: AudioOptions = {
  sample_rate: 16000,
  frame_ms: 25,
  threshold_percentile: 96,
  event_bridge_ms: 200,
  fight_gap_s: 4,
  min_events: 4,
  before_s: 5,
  after_s: 8,
  max_clip_s: 60,
};
export const damageDefaults: DamageOptions = {
  gap_s: 5,
  before_s: 1,
  after_s: 2,
};
export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
}
export interface Identity {
  path: string;
  size: number;
  mtimeMs: number;
  /** Legacy field; new results use path, size and mtimeMs. */
  sha256?: string;
}
export interface Analysis {
  id: string;
  source: Identity;
  name: string;
  mode: Mode;
  media: MediaInfo;
  clips: Clip[];
  audioEvents: AudioEvent[];
  damageEvents: DamageEvent[];
  damage_strategy?: "interval-v1" | "keyframes-v1";
  damageWindows?: DamageWindow[];
  damageProbes?: DamageProbe[];
  damage_parameters?: DamageOptions & ({ probe_interval_s: number; dense_fps: number } |
    { frame_selection: "keyframes"; confirmation_frames: 1; min_window_s: number });
  readings: Reading[];
  curve: CurvePoint[];
  threshold?: number;
  stats: Record<string, number | string>;
  warnings: string[];
}
export interface Progress {
  stage: string;
  current: number;
  total: number;
  source?: string;
  sourceKey?: string;
  phase?: AnalysisPhase;
  detail?: string;
}
export const analysisStageNames = {
  validate: "校验录像",
  probe: "读取视频信息",
  global: "全图定位",
  local: "局部匹配",
  sparse: "稀疏探测",
  dense: "异常补查",
  keyframes: "关键帧识别",
  audio: "音频分析",
  finalize: "生成伤害轴与候选",
} as const;
export type AnalysisPhase = keyof typeof analysisStageNames;
export interface TaskLog {
  id: number;
  at: string;
  level: "info" | "warning" | "error";
  stage: string;
  message: string;
  source?: string;
}
export interface StageRecord {
  phase: AnalysisPhase;
  label: string;
  source?: string;
  sourceKey?: string;
  status: "running" | "completed" | "cancelled" | "failed";
  started: string;
  ended?: string;
  elapsedMs?: number;
}
export type Status =
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";
export interface ExportFile {
  source: string;
  clip: Clip;
  path: string;
}
export interface Job {
  id: string;
  kind: "analyze" | "export";
  status: Status;
  created: string;
  progress: Progress;
  analyses: Analysis[];
  exports: ExportFile[];
  error?: string;
  outputDir: string;
  mode?: Mode;
  logs?: TaskLog[];
  logCount?: number;
  stages?: StageRecord[];
}
export interface Settings {
  mode: Mode;
  audio: AudioOptions;
  damage: DamageOptions;
}
export interface WorkerRequest {
  kind: "analyze" | "export";
  jobDir: string;
  toolsDir: string;
  outputDir: string;
  sources?: string[];
  settings?: Settings;
  selections?: { analysis: Analysis; indices: number[] }[];
}
export type WorkerEvent =
  | { type: "progress"; progress: Progress }
  | { type: "log"; entry: Omit<TaskLog, "id" | "at"> }
  | { type: "analysis"; analysis: Analysis }
  | { type: "export"; file: ExportFile }
  | { type: "done" }
  | { type: "error"; error: string; cancelled: boolean }
  | { type: "pid"; pid: number; active: boolean };
export function round(value: number, digits = 6) {
  return Number(value.toFixed(digits));
}
export function timecode(t: number, precise = true): string {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${Math.floor(ms / 3600000)
    .toString()
    .padStart(
      2,
      "0",
    )}:${Math.floor(ms / 60000) % 60 < 10 ? "0" : ""}${Math.floor(ms / 60000) % 60}:${(Math.floor(ms / 1000) % 60).toString().padStart(2, "0")}${precise ? "." + (ms % 1000).toString().padStart(3, "0") : ""}`;
}
export function validateSettings(s: Settings): void {
  if (!s || !["audio", "damage"].includes(s.mode))
    throw new Error("请选择音频或伤害模式");
  const finite = (o: object) =>
    Object.values(o).every((v) => typeof v === "number" && Number.isFinite(v));
  const a = s.audio;
  // Ignore obsolete sampling_fps even if invalid, retaining the time settings.
  const d = s.damage && { gap_s: s.damage.gap_s, before_s: s.damage.before_s, after_s: s.damage.after_s };
  if (!a || !d || !finite(a) || !finite(d))
    throw new Error("参数必须是有限数值");
  if (
    a.sample_rate !== 16000 ||
    a.frame_ms !== 25 ||
    a.threshold_percentile <= 0 ||
    a.threshold_percentile >= 100 ||
    a.min_events < 1 ||
    !Number.isInteger(a.min_events) ||
    a.max_clip_s <= 0 ||
    [a.event_bridge_ms, a.fight_gap_s, a.before_s, a.after_s].some(
      (v) => v < 0 || v > 3600,
    )
  )
    throw new Error("音频分析参数无效");
  if (
    [d.gap_s, d.before_s, d.after_s].some((v) => v < 0 || v > 3600)
  )
    throw new Error("伤害时间参数须为 0–3600 秒");
  s.damage = d;
}

#!/usr/bin/env python3
"""Audio-only FPS highlight detector and ffmpeg montage builder."""

from __future__ import annotations

import argparse
import json
import logging
import math
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np


LOG = logging.getLogger("apex-highlight")


@dataclass(frozen=True)
class Event:
    start: float
    end: float
    peak_dbfs: float
    active_frames: int


@dataclass
class Clip:
    start: float
    end: float
    raw_start: float
    raw_end: float
    event_count: int
    peak_dbfs: float
    exceeds_max_duration: bool = False

    @property
    def duration(self) -> float:
        return self.end - self.start


from media_runtime import run_command, media_process, tool_path


def require_tools() -> None:
    for name in ("ffmpeg", "ffprobe"):
        tool_path(name)


def probe_media(path: Path) -> dict:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,format_name,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    data = json.loads(result.stdout)
    duration = float(data.get("format", {}).get("duration", 0.0))
    if duration <= 0:
        raise RuntimeError("ffprobe did not return a positive media duration")
    if not any(stream.get("codec_type") == "audio" for stream in data.get("streams", [])):
        raise RuntimeError("Input has no audio stream")
    data["duration_seconds"] = duration
    return data


def stream_frame_rms_dbfs(path: Path, sample_rate: int, frame_ms: float, progress=None) -> np.ndarray:
    frame_samples = max(1, round(sample_rate * frame_ms / 1000.0))
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    LOG.info("Decoding audio to %d Hz mono and computing %.1f ms RMS frames", sample_rate, frame_ms)
    values: list[np.ndarray] = []
    carry = b""
    bytes_per_frame = frame_samples * 4
    read_size = bytes_per_frame * 256
    decoded_bytes = 0
    with media_process(command) as process:
        while True:
            chunk = process.stdout.read(read_size)
            if not chunk:
                break
            decoded_bytes += len(chunk)
            if progress:
                progress(decoded_bytes // 4)
            data = carry + chunk
            usable = len(data) - (len(data) % bytes_per_frame)
            if usable:
                samples = np.frombuffer(data[:usable], dtype="<f4").reshape(-1, frame_samples)
                rms = np.sqrt(np.mean(samples.astype(np.float64) ** 2, axis=1))
                values.append((20.0 * np.log10(np.maximum(rms, 1e-12))).astype(np.float32))
            carry = data[usable:]

    if not values:
        raise RuntimeError("No complete audio frames were decoded")
    return np.concatenate(values)


def detect_events(
    rms_dbfs: np.ndarray,
    *,
    frame_ms: float,
    threshold_percentile: float,
    event_bridge_ms: float,
) -> tuple[float, list[Event]]:
    if rms_dbfs.ndim != 1 or rms_dbfs.size == 0:
        raise ValueError("rms_dbfs must be a non-empty 1-D array")
    threshold = float(np.percentile(rms_dbfs, threshold_percentile))
    # A percentile can land exactly on a broad silence/noise-floor plateau.
    # Strict comparison prevents that entire plateau from becoming "active".
    active = np.flatnonzero(rms_dbfs > threshold)
    if active.size == 0:
        return threshold, []

    frame_seconds = frame_ms / 1000.0
    bridge_frames = max(0, math.floor(event_bridge_ms / frame_ms))
    groups: list[np.ndarray] = []
    start = 0
    for index in range(1, active.size):
        missing_frames = int(active[index] - active[index - 1] - 1)
        if missing_frames > bridge_frames:
            groups.append(active[start:index])
            start = index
    groups.append(active[start:])

    events = [
        Event(
            start=round(float(group[0]) * frame_seconds, 6),
            end=round(float(group[-1] + 1) * frame_seconds, 6),
            peak_dbfs=round(float(np.max(rms_dbfs[group[0] : group[-1] + 1])), 3),
            active_frames=int(group.size),
        )
        for group in groups
    ]
    return threshold, events


def cluster_events(
    events: Sequence[Event],
    *,
    duration: float,
    fight_gap_s: float,
    min_events: int,
    before_s: float,
    after_s: float,
    max_clip_s: float,
) -> list[Clip]:
    if not events:
        return []

    clusters: list[list[Event]] = [[events[0]]]
    for event in events[1:]:
        if event.start - clusters[-1][-1].end <= fight_gap_s:
            clusters[-1].append(event)
        else:
            clusters.append([event])

    clips: list[Clip] = []
    for cluster in clusters:
        if len(cluster) < min_events:
            continue
        raw_start = cluster[0].start
        raw_end = cluster[-1].end
        clips.append(
            Clip(
                start=max(0.0, raw_start - before_s),
                end=min(duration, raw_end + after_s),
                raw_start=raw_start,
                raw_end=raw_end,
                event_count=len(cluster),
                peak_dbfs=max(event.peak_dbfs for event in cluster),
            )
        )

    merged: list[Clip] = []
    for clip in clips:
        if merged and clip.start <= merged[-1].end:
            previous = merged[-1]
            previous.end = max(previous.end, clip.end)
            previous.raw_end = max(previous.raw_end, clip.raw_end)
            previous.event_count += clip.event_count
            previous.peak_dbfs = max(previous.peak_dbfs, clip.peak_dbfs)
        else:
            merged.append(clip)

    for clip in merged:
        clip.start = round(clip.start, 3)
        clip.end = round(clip.end, 3)
        clip.raw_start = round(clip.raw_start, 3)
        clip.raw_end = round(clip.raw_end, 3)
        clip.peak_dbfs = round(clip.peak_dbfs, 3)
        clip.exceeds_max_duration = clip.duration > max_clip_s
    return merged


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def concat_quote(path: Path) -> str:
    return "'" + str(path).replace("'", "'\\''") + "'"


def render_fast_montage(input_path: Path, clips: Sequence[Clip], output_path: Path, work_dir: Path, progress=None) -> None:
    if not clips:
        raise RuntimeError("No clips were detected; montage was not created")
    work_dir.mkdir(parents=True, exist_ok=True)
    segment_paths: list[Path] = []
    for index, clip in enumerate(clips, start=1):
        # NUT retains packet timestamps during stream-copy staging (MKV can lose DTS).
        segment = work_dir / f"clip_{index:03d}.nut"
        duration = clip.end - clip.start
        LOG.info("Cutting clip %03d: %.3f-%.3f (%.3fs)", index, clip.start, clip.end, duration)
        run_command(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{clip.start:.3f}",
                "-i",
                str(input_path),
                "-t",
                f"{duration:.3f}",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                str(segment),
            ]
        )
        segment_paths.append(segment)
        if progress:
            progress("裁剪", index, len(clips))

    concat_file = work_dir / "concat.txt"
    concat_file.write_text(
        "".join(f"file {concat_quote(path.resolve())}\n" for path in segment_paths), encoding="utf-8"
    )
    if progress:
        progress("合并", 0, None)
    LOG.info("Concatenating %d clips into %s", len(segment_paths), output_path)
    run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )


def configure_logging(log_path: Path, verbose: bool) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    LOG.setLevel(logging.DEBUG)
    for handler in LOG.handlers[:]:
        handler.close()
        LOG.removeHandler(handler)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logging.DEBUG)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    console_handler.setLevel(logging.DEBUG if verbose else logging.INFO)
    LOG.addHandler(file_handler)
    LOG.addHandler(console_handler)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create an FPS highlight montage using audio energy only.")
    parser.add_argument("input", type=Path, help="Input gameplay video")
    parser.add_argument("--output-dir", type=Path, default=Path("outputs"))
    parser.add_argument("--output-name", default="apex_montage.mp4")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--frame-ms", type=float, default=25.0)
    parser.add_argument("--threshold-percentile", type=float, default=96.0)
    parser.add_argument("--event-bridge-ms", type=float, default=200.0)
    parser.add_argument("--fight-gap-s", type=float, default=4.0)
    parser.add_argument("--min-events", type=int, default=4)
    parser.add_argument("--before-s", type=float, default=5.0)
    parser.add_argument("--after-s", type=float, default=8.0)
    parser.add_argument("--max-clip-s", type=float, default=60.0, help="Warn only; long fights are preserved")
    parser.add_argument("--analyze-only", action="store_true", help="Write JSON but do not render montage")
    parser.add_argument("--keep-work", action="store_true", help="Keep stream-copy intermediate clips")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing results")
    parser.add_argument("--verbose", action="store_true")
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if not args.input.is_file():
        raise ValueError(f"Input file does not exist: {args.input}")
    if args.sample_rate <= 0 or args.frame_ms <= 0:
        raise ValueError("sample-rate and frame-ms must be positive")
    if not 0 < args.threshold_percentile < 100:
        raise ValueError("threshold-percentile must be between 0 and 100")
    if args.event_bridge_ms < 0 or args.fight_gap_s < 0:
        raise ValueError("bridge and gap values cannot be negative")
    if args.min_events <= 0 or args.before_s < 0 or args.after_s < 0 or args.max_clip_s <= 0:
        raise ValueError("min-events/duration parameters are invalid")


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        from highlight_service import analyze, export_result, Parameters
        params = Parameters(**{key: getattr(args, key, field.default) for key,field in Parameters.__dataclass_fields__.items()})
        result = analyze(args.input, args.output_dir, params, overwrite=args.overwrite)
        if not args.analyze_only:
            export_result(result, output=args.output_dir / args.output_name,
                          overwrite=args.overwrite, keep_work=args.keep_work)
        return 0
    except KeyboardInterrupt:
        print("已取消。", file=sys.stderr)
        return 130
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        if LOG.handlers:
            LOG.error("%s", error)
        else:
            print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

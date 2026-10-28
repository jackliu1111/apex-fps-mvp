"""Create a bounded, one-minute browser demo from an existing local recording.

The caller selects a visually verified combat interval. This tool does not detect
combat or download footage. It leaves the original recording untouched.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess


DURATION = 60
MAX_BYTES = 90 * 1024 * 1024


def probe(path):
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of", "json", str(path),
    ], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, help="New .mp4 path; existing files are never overwritten")
    parser.add_argument("--start", type=float, required=True, help="Start time in original recording seconds")
    args = parser.parse_args()
    source, output = args.source.resolve(strict=True), args.output.resolve()
    manifest = output.with_suffix(".manifest.json")
    if not math.isfinite(args.start) or args.start < 0:
        parser.error("--start must be finite and non-negative")
    if output.suffix.lower() != ".mp4" or output.exists() or manifest.exists():
        parser.error("Choose a new .mp4 output and manifest path")
    metadata = probe(source)
    if args.start + DURATION > float(metadata["format"]["duration"]):
        parser.error("The source must contain the entire requested minute")
    if not all(any(s["codec_type"] == kind for s in metadata["streams"]) for kind in ("video", "audio")):
        parser.error("A source video stream and audio stream are required")
    # Fixed 60 s, max 5 Mbps H.264 + 192 kbps AAC: approximately 40 MiB.
    # The hard byte limit and decoded-duration validation prevent an oversized
    # local artifact being accepted. No full-source copy or decoded PCM is saved.
    existing_parent = output.parent
    while not existing_parent.exists():
        existing_parent = existing_parent.parent
    if shutil.disk_usage(existing_parent).free < 2 * MAX_BYTES:
        parser.error("Insufficient output space (180 MiB free required)")
    # Do not create a same-named local /Volumes directory for an absent mount.
    if output.is_relative_to(Path("/Volumes")):
        volume = Path(*output.parts[:3])
        if not volume.is_mount():
            parser.error(f"Output volume is not mounted: {volume}")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-ss", str(args.start), "-i", str(source), "-t", str(DURATION),
        "-map", "0:v:0", "-map", "0:a:0",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-maxrate", "5M", "-bufsize", "10M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-map_metadata", "-1", "-movflags", "+faststart", "-fs", str(MAX_BYTES), str(output),
    ]
    subprocess.run(command, check=True)
    result = probe(output)
    duration = float(result["format"]["duration"])
    if abs(duration - DURATION) > 0.1 or output.stat().st_size >= MAX_BYTES:
        raise SystemExit(f"Output failed bounded-duration validation; retained for inspection: {output}")
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-i", str(output),
        "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
    ], check=True)
    digest = hashlib.sha256()
    with output.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    report = {
        "purpose": "Real gameplay demo and workflow validation; not labeled model-quality ground truth",
        "source": {"path": str(source), "bytes": source.stat().st_size,
                   "mtimeNs": source.stat().st_mtime_ns, "media": metadata},
        "selection": {"startSeconds": args.start, "endSeconds": args.start + DURATION,
                      "audioStream": "0:a:0", "videoStream": "0:v:0"},
        "output": {"path": str(output), "bytes": output.stat().st_size,
                   "sha256": digest.hexdigest(), "media": result},
        "validation": {"fullAudioVideoDecodePassed": True, "durationSeconds": duration},
        "encoding": {"transcoded": True, "command": command},
    }
    with manifest.open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"output": str(output), "manifest": str(manifest),
                      "bytes": output.stat().st_size, "duration": duration}, ensure_ascii=False))


if __name__ == "__main__":
    main()

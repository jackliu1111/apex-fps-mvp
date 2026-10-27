#!/usr/bin/env python3
"""Compare saved browser audio analyses without reading the source media.

Accepts the app's single-analysis JSON or the standalone-audio harness JSON.
Every candidate harness round is compared with one chosen baseline round.
Exact equality is the default. Nonzero tolerances must be requested explicitly.
Exit codes: 0 = all comparisons pass, 2 = mismatch or CLI usage error,
1 = invalid report or I/O error.
The output is created exclusively: an existing output file is never replaced.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys


REQUIRED_SETTINGS = ("threshold", "videoDuration", "analysisDuration")
OPTIONAL_SETTINGS = ("sampleRate", "videoOrigin", "timestampShift")


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read_report(path):
    path = path.resolve()
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError(f"Report exceeds 32 MiB; expected summary/score JSON: {path}")
    raw = path.read_bytes()
    document = json.loads(raw)
    if not isinstance(document, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    provenance = {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    return document, provenance


def analyses(document):
    if "results" in document:
        records = document["results"]
        if not isinstance(records, list) or not records:
            raise ValueError("Harness report has no completed analysis records")
        if not all(isinstance(record, dict) for record in records):
            raise ValueError("Invalid analysis record")
        return records
    return [document]


def settings(document, record):
    options = document.get("options", {})
    source = document.get("source", {})
    audio = record.get("audio", {})
    windows = record.get("windowScores") or []
    # Historic app reports omit audioDuration. Window endpoints record the actual
    # analysed domain, including the final partial window, so recover it explicitly.
    derived_duration = None
    if windows and finite_number(windows[-1].get("end")) and finite_number(windows[0].get("start")):
        derived_duration = windows[-1]["end"] - windows[0]["start"]
    duration = audio.get("analysisDuration", audio.get("duration", derived_duration))
    return {
        "threshold": options.get("threshold", document.get("threshold")),
        "videoDuration": options.get("videoDuration", source.get("duration")),
        "analysisDuration": duration,
        "sampleRate": document.get("sampleRate"),
        "videoOrigin": options.get("videoOrigin"),
        "timestampShift": options.get("timestampShift"),
        "analysisDurationSource": "audio metadata" if "analysisDuration" in audio or "duration" in audio else "last window end minus first window start",
        "selectedAudioIndex": options.get("audioIndex", source.get("selectedAudioIndex")),
        "durationOverride": options.get("durationOverride"),
    }


def validate_record(document, record):
    errors = []
    sha = document.get("modelSha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", sha):
        errors.append("missing or invalid modelSha256")
    if record.get("status") not in ("complete", "完成"):
        errors.append(f"analysis status is {record.get('status')!r}")
    windows = record.get("windowScores")
    if not isinstance(windows, list) or not windows:
        errors.append("missing/non-list/empty windowScores")
        windows = []
    if record.get("windows") != len(windows):
        errors.append("reported windows count differs from windowScores length")
    previous_start = -math.inf
    for index, window in enumerate(windows):
        if not isinstance(window, dict):
            errors.append(f"window {index} is not an object")
            continue
        start, end, scores = window.get("start"), window.get("end"), window.get("scores")
        if not finite_number(start) or not finite_number(end) or end <= start or start < previous_start:
            errors.append(f"window {index} has invalid/non-monotonic boundaries")
        else:
            previous_start = start
        if not isinstance(scores, list) or len(scores) != 2 or not all(finite_number(v) and 0 <= v <= 1 for v in scores):
            errors.append(f"window {index} must contain two finite probabilities")
    clips = record.get("clips")
    if not isinstance(clips, list):
        errors.append("missing/non-list clips")
    else:
        for index, clip in enumerate(clips):
            if not isinstance(clip, dict) or not finite_number(clip.get("start")) or not finite_number(clip.get("end")) or clip["end"] <= clip["start"]:
                errors.append(f"candidate {index} has invalid boundaries")
            elif clip.get("provisional") is not False:
                errors.append(f"candidate {index} is not finalized")
    if not errors:
        for name in REQUIRED_SETTINGS:
            if not finite_number(settings(document, record)[name]):
                errors.append(f"required setting {name} unavailable or invalid")
    return errors


def compare(baseline_doc, baseline, candidate_doc, candidate, score_atol=0, time_atol=0):
    left, right = settings(baseline_doc, baseline), settings(candidate_doc, candidate)
    setting_checks, unverified = {}, []
    for name in REQUIRED_SETTINGS + OPTIONAL_SETTINGS:
        a, b = left[name], right[name]
        if a is None or b is None:
            unverified.append(name)
            continue
        tolerance = 0 if name in ("threshold", "sampleRate") else time_atol
        setting_checks[name] = {"baseline": a, "candidate": b, "matches": abs(a - b) <= tolerance}
    model_equal = baseline_doc["modelSha256"].lower() == candidate_doc["modelSha256"].lower()
    a_windows, b_windows = baseline["windowScores"], candidate["windowScores"]
    window_mismatches, score_mismatches = [], []
    max_score_diff, max_time_diff = 0.0, 0.0
    exact_scores, exact_times = True, True
    for index in range(max(len(a_windows), len(b_windows))):
        if index >= len(a_windows) or index >= len(b_windows):
            window_mismatches.append({"index": index, "reason": "missing window"})
            exact_scores = exact_times = False
            continue
        a, b = a_windows[index], b_windows[index]
        differences = {key: abs(a[key] - b[key]) for key in ("start", "end")}
        max_time_diff = max(max_time_diff, *differences.values())
        exact_times &= all(value == 0 for value in differences.values())
        if any(value > time_atol for value in differences.values()):
            window_mismatches.append({"index": index, "baseline": [a["start"], a["end"]], "candidate": [b["start"], b["end"]]})
        for class_index, (a_score, b_score) in enumerate(zip(a["scores"], b["scores"])):
            difference = abs(a_score - b_score)
            max_score_diff = max(max_score_diff, difference)
            exact_scores &= difference == 0
            if difference > score_atol:
                score_mismatches.append({"windowIndex": index, "classIndex": class_index,
                                         "baseline": a_score, "candidate": b_score, "absDifference": difference})
    clip_mismatches, exact_clips = [], baseline["clips"] == candidate["clips"]
    for index in range(max(len(baseline["clips"]), len(candidate["clips"]))):
        if index >= len(baseline["clips"]) or index >= len(candidate["clips"]):
            clip_mismatches.append({"index": index, "reason": "missing candidate"})
            continue
        a, b = baseline["clips"][index], candidate["clips"][index]
        keys = sorted(a.keys() | b.keys())
        differing = [key for key in keys if (
            abs(a[key] - b[key]) > time_atol if key in ("start", "end") and key in a and key in b
            else a.get(key) != b.get(key) or (key in a) != (key in b))]
        if differing:
            clip_mismatches.append({"index": index, "differingFields": differing, "baseline": a, "candidate": b})
    passed = model_equal and all(check["matches"] for check in setting_checks.values()) and not window_mismatches and not score_mismatches and not clip_mismatches
    return {
        "pass": passed, "baselineRound": baseline.get("round", 1), "candidateRound": candidate.get("round", 1),
        "modelSha256Matches": model_equal,
        "modelSha256": {"baseline": baseline_doc["modelSha256"], "candidate": candidate_doc["modelSha256"]},
        "settings": setting_checks, "unverifiedSettings": unverified,
        "settingProvenance": {"baseline": left, "candidate": right},
        "windows": {"baseline": len(a_windows), "candidate": len(b_windows), "exactBoundaries": exact_times,
                    "maxBoundaryAbsDifferenceSeconds": max_time_diff, "mismatches": window_mismatches},
        "scores": {"exact": exact_scores, "maxAbsDifference": max_score_diff,
                   "mismatchCount": len(score_mismatches), "mismatches": score_mismatches},
        "candidates": {"baseline": len(baseline["clips"]), "candidate": len(candidate["clips"]),
                       "exact": exact_clips, "mismatches": clip_mismatches},
        "environment": {"baselineUserAgent": baseline_doc.get("userAgent"), "candidateUserAgent": candidate_doc.get("userAgent"),
                        "sameUserAgent": baseline_doc.get("userAgent") == candidate_doc.get("userAgent")},
        "timings": {"baseline": baseline.get("timings"), "candidate": candidate.get("timings")},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidates", type=Path, nargs="+")
    parser.add_argument("--baseline-round", type=int, default=1, help="One-based baseline record position (default: 1)")
    parser.add_argument("--score-atol", type=float, default=0, help="Explicit allowed probability difference (default: exact)")
    parser.add_argument("--time-atol", type=float, default=0, help="Explicit allowed time difference in seconds (default: exact)")
    parser.add_argument("--output", type=Path, required=True, help="New JSON output path; never overwrite")
    args = parser.parse_args()
    if args.baseline_round < 1 or not all(math.isfinite(v) and v >= 0 for v in (args.score_atol, args.time_atol)):
        parser.error("Round must be positive; tolerances must be finite and nonnegative")
    if args.output.exists():
        parser.error(f"Output already exists; choose a new path: {args.output}")
    try:
        baseline_doc, baseline_provenance = read_report(args.baseline)
        records = analyses(baseline_doc)
        if args.baseline_round > len(records):
            raise ValueError("Requested baseline round is absent")
        baseline = records[args.baseline_round - 1]
        baseline_errors = validate_record(baseline_doc, baseline)
        if baseline_errors:
            raise ValueError("Invalid baseline: " + "; ".join(baseline_errors))
        report = {"schemaVersion": 1, "baseline": baseline_provenance, "baselineRound": args.baseline_round,
                  "tolerances": {"scoreAbsolute": args.score_atol, "timeAbsoluteSeconds": args.time_atol},
                  "notes": ["This verifies saved predictions and candidate state, not AAC payload identity or source-file identity.",
                            "Historical reports may omit sample rate/origin/shift; unverifiedSettings lists those omissions.",
                            "Audio track indices may change after streamcopy; selectedAudioIndex is informational.",
                            "User-agent differences are reported but do not invalidate numerical parity; performance claims require a same-environment control."],
                  "comparisons": []}
        invalid = False
        for path in args.candidates:
            document, provenance = read_report(path)
            for record in analyses(document):
                errors = validate_record(document, record)
                if errors:
                    invalid = True
                    result = {"pass": False, "candidateRound": record.get("round", 1), "validationErrors": errors}
                else:
                    result = compare(baseline_doc, baseline, document, record, args.score_atol, args.time_atol)
                result["sourceReport"] = provenance
                report["comparisons"].append(result)
        report["allPassed"] = all(item["pass"] for item in report["comparisons"])
        report["invalidInput"] = invalid
        serialized = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(serialized)
        print(json.dumps({"output": str(args.output.resolve()), "allPassed": report["allPassed"],
                          "comparisons": len(report["comparisons"]), "invalidInput": invalid}, ensure_ascii=False))
        return 1 if invalid else 0 if report["allPassed"] else 2
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

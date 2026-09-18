#!/usr/bin/env python3
"""Verify the native artifact alone, with an empty PATH and no adjacent tools."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile


def dependencies(executable):
    if platform.system() == "Darwin":
        text = subprocess.check_output(["/usr/bin/otool", "-L", executable], text=True)
        deps = [line.strip().split(" (", 1)[0] for line in text.splitlines()[1:]]
        bad = [d for d in deps if not d.startswith(("/usr/lib/", "/System/Library/"))]
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", executable], check=True)
    elif os.name == "nt":
        text = subprocess.check_output(["objdump", "-p", executable], text=True)
        deps = re.findall(r"DLL Name:\s*(\S+)", text)
        system = set("advapi32 avicap32 avrt bcrypt cfgmgr32 combase comdlg32 crypt32 d3d11 d3d12 ddraw dinput8 dwmapi dxgi gdi32 imm32 kernel32 mf mfplat mfreadwrite msvcrt ntdll ole32 oleaut32 powrprof psapi rpcrt4 secur32 setupapi shell32 shlwapi ucrtbase user32 userenv usp10 version vfw32 winmm ws2_32 wtsapi32".split())
        bad = [d for d in deps if Path(d).stem.lower() not in system and not d.lower().startswith(("api-ms-win-", "ext-ms-win-"))]
    else:
        raise RuntimeError("Run verification on the real target OS")
    if not deps or bad:
        raise RuntimeError(f"Unexpected runtime dependencies: {bad or 'empty dependency audit'}")
    return deps


def verify(executable):
    executable = executable.resolve()
    deps = dependencies(executable)
    report = {"platform": platform.platform(), "executable": str(executable), "dependencies": deps,
              "tests": [], "real_gui_preview": "not covered by headless verification",
              "gatekeeper_smartscreen": "not tested; downloaded-artifact testing still required"}
    with tempfile.TemporaryDirectory(prefix="apex-cgo-") as tmp:
        root = Path(tmp) / "独立 目录's test"
        root.mkdir()
        binary = root / executable.name
        shutil.copyfile(executable, binary)
        binary.chmod(0o755)
        empty_path = root / "empty-path"
        empty_path.mkdir()
        temporary = root / "temp"
        temporary.mkdir()
        env = os.environ | {"PATH": str(empty_path), "SDL_AUDIODRIVER": "dummy", "SDL_VIDEODRIVER": "dummy",
                            "TMPDIR": str(temporary), "TMP": str(temporary), "TEMP": str(temporary)}
        env.pop("SDL_DYNAMIC_API", None)
        def call(*args):
            p = subprocess.run([str(binary), *map(str, args)], cwd=root, env=env, capture_output=True, text=True, timeout=60)
            if p.returncode:
                raise RuntimeError(f"{args[0]} failed ({p.returncode}): {p.stderr[-4000:]}")
            return p.stdout
        doctor = json.loads(call("doctor"))
        if doctor.get("external_media_executables") is not False or doctor.get("backend") != "cgo-static":
            raise RuntimeError(f"Not a self-contained CGO build: {doctor}")
        report["tests"].append("doctor with only main executable and empty PATH")
        source = root / "测试 录像.mkv"
        call("--apex-media-worker", "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=sample_rate=16000:duration=2", "-c:v", "mpeg4", "-c:a", "pcm_s16le", source)
        if abs(json.loads(call("probe", source))["duration_seconds"] - 2) > .01:
            raise RuntimeError("wrong source duration")
        report["tests"].append("source generation and probe through embedded tools")
        audio = json.loads(call("analyze", "--mode", "audio", source))
        damage = json.loads(call("analyze", "--mode", "damage", source))
        if audio["frame_count"] != 80 or damage["damage_stats"]["sampled_frames"] != 60:
            raise RuntimeError("analysis sample counts changed")
        report["tests"].append("audio and HUD analysis, Chinese/space/apostrophe paths")
        intervals = root / "intervals.json"
        intervals.write_text(json.dumps({"clips": [{"start": .105, "end": .295}, {"start": 1.01, "end": 1.21}]}))
        for mode in ("precise", "fast"):
            result = root / f"{mode}.mp4"
            call("render", "--source", source, "--intervals", intervals, "--output", result, "--mode", mode)
            call("--apex-media-worker", "ffmpeg", "-v", "error", "-i", result, "-f", "null", "-")
            if json.loads(call("probe", result))["duration_seconds"] <= 0:
                raise RuntimeError("empty render")
        report["tests"].append("precise/fast render and full output decode")
        call("--apex-media-worker", "ffplay", "-nodisp", "-autoexit", "-loglevel", "error", "-t", "0.3", source)
        report["tests"].append("embedded ffplay audio playback with SDL dummy driver")
        # Media data and logs may be created; executable/library payloads may not.
        for item in root.rglob("*"):
            if not item.is_file() or item == binary:
                continue
            with item.open("rb") as f:
                magic = f.read(4)
            if magic[:2] == b"MZ" or magic in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe") or item.suffix.lower() in (".dll", ".dylib", ".exe"):
                raise RuntimeError(f"Unexpected extracted executable or library: {item}")
        report["tests"].append("no executable or shared-library payload extracted into working directory")
    report["passed"] = True
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = verify(args.executable)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    print(text)

#!/usr/bin/env python3
"""Build the single-executable CGO edition on macOS or Windows (MSYS2 UCRT64).

FFmpeg's private CLI entry points are pinned to 7.1.1. Their defined C symbols
are namespaced, while libav* and SDL are linked once. No generated tool EXEs are
copied into the release. Use --sdl-prefix for an existing static SDL installation.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
GO = ROOT / "go"
FF_VERSION = "7.1.1"
FF_SHA = "733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
SDL_VERSION = "2.32.6"
SDL_SHA = "6a7a40d6c2e00016791815e1a9f4042809210bdf10cc78d2c75b45c4f52f93ad"
LIBS = ["avdevice", "avfilter", "avformat", "avcodec", "swresample", "swscale", "avutil"]
TOOLS = ["ffmpeg", "ffprobe", "ffplay"]


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def output(args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, **kwargs).strip()


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def posix(path):
    if os.name == "nt":
        return output(["cygpath", "-u", path])
    return str(path)


def fetch(url, path):
    if not path.exists():
        print(f"Downloading {url}", flush=True)
        temp = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(url, temp)
        temp.replace(path)


def unpack(archive, directory):
    with tarfile.open(archive) as tar:
        tar.extractall(directory, filter="data")


def config_values(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines()
                if "=" in line and not line.startswith("#"))


def defined_symbols(objects, mac):
    symbols = set()
    for obj in objects:
        args = ["nm", "-g", "-U", obj] if mac else ["nm", "-g", "--defined-only", obj]
        for line in output(args).splitlines():
            match = re.match(r"^[0-9a-fA-F]+\s+[A-Z]\s+(\w+)$", line.strip())
            if match:
                name = match[1]
                if mac:
                    name = name.removeprefix("_")
                if re.fullmatch(r"[A-Za-z_]\w*", name):
                    symbols.add(name)
    if "main" not in symbols:
        raise RuntimeError("missing upstream CLI main symbol")
    return symbols


def normalize_flags(flags):
    result = []
    for flag in flags:
        # All selected Apple frameworks exist on our macOS 11+ deployment target.
        match = re.fullmatch(r"-Wl,-(?:weak_)?framework,(\w+)", flag)
        if match:
            result.extend(["-framework", match[1]])
        elif flag not in ("-lSDL2main", "-mwindows"):
            result.append(flag)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdl-prefix", type=Path)
    parser.add_argument("--test", action="store_true", help="run all tests including real media integration")
    parser.add_argument("--package", action="store_true", help="audit and produce the single-program ZIP")
    parser.add_argument("--rebuild-native", action="store_true", help="rebuild static dependencies, preserving extracted source edits")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 2, 8))
    args = parser.parse_args()
    mac = platform.system() == "Darwin"
    if not mac and os.name != "nt":
        raise SystemExit("Supported native hosts: macOS or Windows with MSYS2 UCRT64")
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(platform.machine().lower())
    if not arch or (not mac and arch != "amd64"):
        raise SystemExit("Supported targets: macOS arm64/amd64 and Windows amd64")
    target = f"{'darwin' if mac else 'windows'}-{arch}"
    native = GO / "native" / target
    stage = ROOT / "build" / "cgo" / target
    source_root = stage / "sources"
    downloads = ROOT / "build" / "cgo" / "downloads"
    for p in [native / "lib", source_root, downloads]:
        p.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["GOCACHE"] = str(ROOT / "build" / "go-cache")
    env.setdefault("GOMODCACHE", str(ROOT / "build" / "go-modcache"))
    env["CGO_ENABLED"] = "1"
    env["GOOS"], env["GOARCH"] = target.split("-")
    env.setdefault("CC", "clang" if mac else "gcc")
    if mac:
        env.setdefault("MACOSX_DEPLOYMENT_TARGET", "11.0")
    for tool in ["go", env["CC"], "make", "pkg-config", "nm", "ar", "sh"]:
        if not shutil.which(tool):
            raise SystemExit(f"Missing build tool: {tool}")

    ff_archive = ROOT / "build" / f"ffmpeg-{FF_VERSION}.tar.xz"
    fetch(f"https://ffmpeg.org/releases/ffmpeg-{FF_VERSION}.tar.xz", ff_archive)
    if digest(ff_archive) != FF_SHA:
        raise SystemExit("FFmpeg source SHA-256 mismatch")

    sdl = args.sdl_prefix.resolve() if args.sdl_prefix else stage / "sdl"
    if not (sdl / "lib" / "libSDL2.a").is_file() or (args.rebuild_native and not args.sdl_prefix):
        if args.sdl_prefix:
            raise SystemExit("--sdl-prefix must contain lib/libSDL2.a")
        archive = downloads / f"SDL2-{SDL_VERSION}.tar.gz"
        fetch(f"https://www.libsdl.org/release/SDL2-{SDL_VERSION}.tar.gz", archive)
        if digest(archive) != SDL_SHA:
            raise SystemExit("SDL source SHA-256 mismatch")
        sdl_source = source_root / f"SDL2-{SDL_VERSION}"
        if not sdl_source.exists():
            unpack(archive, source_root)
        sdl_build = stage / "sdl-build"
        sdl_build.mkdir(exist_ok=True)
        with (stage / "sdl-build.log").open("w") as log:
            run(["sh", posix(sdl_source / "configure"), f"--prefix={posix(sdl)}", "--disable-shared", "--enable-static", "--disable-joystick", "--disable-haptic", "--disable-sensor"], cwd=sdl_build, env=env, stdout=log, stderr=subprocess.STDOUT)
            run(["make", f"-j{args.jobs}"], cwd=sdl_build, env=env, stdout=log, stderr=subprocess.STDOUT)
            run(["make", "install"], cwd=sdl_build, env=env, stdout=log, stderr=subprocess.STDOUT)
    env["PKG_CONFIG_PATH"] = posix(sdl / "lib" / "pkgconfig")
    ff_source = source_root / f"ffmpeg-{FF_VERSION}"
    if not ff_source.exists():
        unpack(ff_archive, source_root)
    # Go already passes UTF-8 argv. On Windows the original implementation
    # reparses the whole OS command line, incorrectly restoring our worker flag.
    cmdutils = ff_source / "fftools" / "cmdutils.c"
    original = cmdutils.read_text()
    marker = "#if HAVE_COMMANDLINETOARGVW"
    replacement = "#if HAVE_COMMANDLINETOARGVW && !defined(APEX_EMBEDDED)"
    if replacement not in original:
        if original.count(marker) != 1:
            raise RuntimeError("upstream command-line patch no longer applies")
        cmdutils.write_text(original.replace(marker, replacement))
    ff_build = stage / "ffmpeg-build"
    ff_build.mkdir(exist_ok=True)
    configure = ["sh", posix(ff_source / "configure"), f"--cc={env['CC']}", "--disable-autodetect", "--disable-shared", "--enable-static", "--disable-doc", "--disable-debug", "--disable-network", "--disable-x86asm", "--disable-postproc", "--enable-sdl2", "--pkg-config-flags=--static", "--extra-cflags=-DSDL_MAIN_HANDLED"]
    if not mac:
        configure.append("--extra-ldflags=-static-libgcc")
    build_key = json.dumps([configure, str(sdl), digest(sdl / "lib" / "libSDL2.a")])
    stamp = ff_build / "apex-config.json"
    if args.rebuild_native or not stamp.exists() or stamp.read_text() != build_key:
        with (stage / "configure.log").open("w") as log:
            if stamp.exists():
                run(["make", "clean"], cwd=ff_build, env=env, stdout=log, stderr=subprocess.STDOUT)
            run(configure, cwd=ff_build, env=env, stdout=log, stderr=subprocess.STDOUT)
        stamp.write_text(build_key)
    print(f"Building FFmpeg/SDL static objects for {target}; logs: {stage}", flush=True)
    with (stage / "ffmpeg-build.log").open("w") as log:
        run(["make", f"-j{args.jobs}"], cwd=ff_build, env=env, stdout=log, stderr=subprocess.STDOUT)
    config = config_values(ff_build / "ffbuild" / "config.mak")
    manifest = {"target": target, "ffmpeg_version": FF_VERSION, "ffmpeg_source_sha256": FF_SHA,
                "sdl_version": output(["pkg-config", "--modversion", "sdl2"], env=env),
                "sdl_static_sha256": digest(sdl / "lib" / "libSDL2.a"),
                "configure": configure, "single_executable": True,
                "developer_signed": False, "notarized": False}
    all_objects = []
    for tool in TOOLS:
        query = ff_build / "apex-vars.mk"
        query.write_text(f"include Makefile\n.PHONY: apex-vars\napex-vars:\n\t@echo $(OBJS-{tool})\n")
        objects = [ff_build / p for p in output(["make", "-s", "-f", query.name, "V=1", "apex-vars"], cwd=ff_build, env=env).split() if p.endswith(".o")]
        # PE resources are for the standalone build-time tools, not our Go EXE.
        objects = [p for p in objects if p.name != "fftoolsres.o"]
        symbols = defined_symbols(objects, mac)
        folder = stage / "namespaced" / tool
        folder.mkdir(parents=True, exist_ok=True)
        header = folder / "namespace.h"
        header_text = "#define APEX_EMBEDDED 1\n#define SDL_MAIN_HANDLED 1\n" + "".join(f"#define {name} apex_{tool}_{name}\n" for name in sorted(symbols))
        header_text += f"int apex_{tool}_main(int argc, char **argv);\n"
        if not header.exists() or header.read_text() != header_text:
            header.write_text(header_text)
        flags = shlex.split(config["CFLAGS"]) + shlex.split(config.get("CPPFLAGS", "")) + shlex.split(config.get(f"CFLAGS-{tool}", ""))
        flags = [f.replace("$(SRC_PATH)", ff_source.as_posix()).replace("$(SRC_LINK)", ff_source.as_posix()) for f in flags]
        flags += shlex.split(output(["pkg-config", "--cflags", "sdl2"], env=env))
        def compile_obj(obj):
            dest = folder / obj.name
            source = ff_source / obj.relative_to(ff_build).with_suffix(".c")
            if not dest.exists() or dest.stat().st_mtime < max(obj.stat().st_mtime, header.stat().st_mtime, source.stat().st_mtime):
                run([env["CC"], *flags, "-I", ff_build, "-I", ff_source, "-include", header, "-c", source, "-o", dest], cwd=ff_build, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return dest
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            all_objects += list(pool.map(compile_obj, objects))
    archive = native / "lib" / "libapex_fftools.a"
    # Object basenames must be unique in the combined archive.
    flat = stage / "archive-objects"
    flat.mkdir(exist_ok=True)
    packed = []
    for obj in all_objects:
        dest = flat / (obj.parent.name + "_" + obj.name)
        shutil.copy2(obj, dest)
        packed.append(dest)
    archive.unlink(missing_ok=True)
    run(["ar", "rcs", archive, *packed], env=env)
    for lib in LIBS:
        shutil.copy2(ff_build / f"lib{lib}" / f"lib{lib}.a", native / "lib")
    (native / "lib" / "libSDL2.a").unlink(missing_ok=True)
    shutil.copy2(sdl / "lib" / "libSDL2.a", native / "lib")
    extra = []
    for lib in LIBS:
        extra += shlex.split(config.get(f"EXTRALIBS-{lib}", ""))
    extra += shlex.split(output(["pkg-config", "--static", "--libs", "sdl2"], env=env))
    extra = normalize_flags([f for f in extra if not f.startswith("-L") and f not in ("-lSDL2", "-lSDL2main")])
    # Keep framework/name pairs intact while eliminating duplicate libraries.
    groups, i = [], 0
    while i < len(extra):
        group = tuple(extra[i:i+2]) if extra[i] == "-framework" else (extra[i],)
        if group not in groups:
            groups.append(group)
        i += len(group)
    extra = [flag for group in groups for flag in group]
    if not mac:
        extra += ["-static", "-static-libgcc"]
    static_paths = [native / "lib" / f"lib{name}.a" for name in ["apex_fftools", *LIBS, "SDL2"]]
    link_flags = [p.as_posix() for p in static_paths] + extra
    build_id = hashlib.sha256("".join(digest(p) for p in static_paths).encode()).hexdigest()
    generated = GO / "internal" / "native" / f"link_{target.replace('-', '_')}.go"
    generated.write_text(f'// Code generated by build_native.py; DO NOT EDIT.\n//go:build {env["GOOS"]} && {arch} && cgo\n\npackage native\n\n/*\n#cgo LDFLAGS: ' + " ".join('"'+f+'"' if " " in f else f for f in link_flags) + f'\n*/\nimport "C"\n\nconst buildID = "{build_id}"\n')
    (native / "build-info.json").write_text(json.dumps(manifest, indent=2) + "\n")
    executable = ROOT / "dist" / "cgo" / target / ("apex-highlight" if mac else "apex-highlight.exe")
    executable.parent.mkdir(parents=True, exist_ok=True)
    with (stage / "go-build.log").open("w") as log:
        run(["go", "build", "-trimpath", "-o", executable, "./cmd/apex-highlight"], cwd=GO, env=env, stdout=log, stderr=subprocess.STDOUT)
    if args.test:
        run(["go", "test", "./...", "-count=1"], cwd=GO, env=env | {"APEX_MEDIA_TEST": "1"})
        run(["go", "vet", "./..."], cwd=GO, env=env)
    print(f"Built: {executable}", flush=True)
    if args.package:
        from package_native import package
        package(executable)
    return executable


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        if e.stderr:
            print(e.stderr.decode() if isinstance(e.stderr, bytes) else e.stderr)
        raise

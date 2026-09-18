#!/usr/bin/env python3
"""Audit and package a native build with exactly one runnable program."""
import argparse
import json
import os
from pathlib import Path
import shutil
import re
import subprocess
import tarfile
import tempfile
import zipfile

from build_native import ROOT, GO, FF_VERSION, SDL_VERSION, digest
from verify_native import verify


def package(executable):
    executable = executable.resolve()
    target = executable.parent.name
    native = GO / "native" / target
    info = json.loads((native / "build-info.json").read_text())
    report = verify(executable)
    directory = ROOT / "dist" / "cgo"
    archive = directory / f"apex-highlight-{target}.zip"
    with tempfile.TemporaryDirectory(dir=directory, prefix="package-") as tmp:
        bundle = Path(tmp) / f"apex-highlight-{target}"
        bundle.mkdir()
        shutil.copy2(executable, bundle / executable.name)
        shutil.copy2(GO / "RELEASE_README.txt", bundle / "README.txt")
        info["executable_sha256"] = digest(executable)
        info["validation"] = report
        (bundle / "build-info.json").write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
        licenses = bundle / "licenses"
        licenses.mkdir()
        ff_source = ROOT / "build" / "cgo" / target / "sources" / f"ffmpeg-{FF_VERSION}"
        shutil.copy2(ff_source / "COPYING.LGPLv2.1", licenses / "FFmpeg-LGPL-2.1.txt")
        shutil.copy2(ff_source / "LICENSE.md", licenses / "FFmpeg-LICENSE.md")
        shutil.copy2(ROOT / "build" / f"ffmpeg-{FF_VERSION}.tar.xz", licenses)
        sdl_archive = ROOT / "build" / "cgo" / "downloads" / f"SDL2-{SDL_VERSION}.tar.gz"
        if not sdl_archive.exists():
            raise RuntimeError("Default source build required before packaging SDL source materials")
        shutil.copy2(sdl_archive, licenses)
        goroot = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True).strip())
        go_license = goroot / "LICENSE"
        if not go_license.exists():
            go_license = goroot.parent / "LICENSE"
        shutil.copy2(go_license, licenses / "Go-LICENSE.txt")
        # Include the actual application source and adapter/build script so this
        # static edition can be rebuilt/relinked with modified LGPL libraries.
        with tarfile.open(licenses / "application-source.tar.gz", "w:gz") as tar:
            for item in sorted(GO.rglob("*")):
                relative = item.relative_to(GO)
                if not item.is_file() or relative.parts[0] == "native" or "__pycache__" in relative.parts or item.name.startswith("link_"):
                    continue
                tar.add(item, arcname=str(Path("go") / relative))
        modules = subprocess.check_output(["go", "version", "-m", executable], text=True)
        (licenses / "go-modules.txt").write_text(modules)
        cache = Path(os.environ.get("GOMODCACHE", ROOT / "build" / "go-modcache"))
        for line in modules.splitlines():
            fields = line.split()
            if len(fields) < 3 or fields[0] != "dep":
                continue
            module_path, version = fields[1:3]
            escaped = re.sub(r"[A-Z]", lambda m: "!" + m[0].lower(), module_path + "@" + version)
            module_dir = cache / escaped
            if not module_dir.is_dir():
                raise RuntimeError(f"Missing license source for linked Go module: {module_path}")
            for item in module_dir.iterdir():
                if item.is_file() and item.name.upper().startswith(("LICENSE", "COPYING", "NOTICE", "COPYRIGHT")):
                    dest = licenses / "go-modules" / module_path / item.name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(item, dest)
        (licenses / "REBUILD.txt").write_text(
            "FFmpeg 7.1.1: LGPL 2.1 or later. SDL 2.32.6: zlib license (in its source archive).\n"
            "The original FFmpeg/SDL sources, application source, module version list and build scripts are included.\n"
            "Extract application-source.tar.gz into a new folder. Put the FFmpeg archive in build/ and the SDL archive in build/cgo/downloads/.\n"
            "Run python3 go/scripts/build_native.py on macOS, or python go/scripts/build_native.py in Windows MSYS2 UCRT64.\n"
            "See go/README.md for build prerequisites and source modifications. The scripts generate namespaced CLI objects and link static libraries.\n"
            "For a modified FFmpeg/SDL source, edit build/cgo/<target>/sources/ then rebuild with --rebuild-native; extracted source edits are preserved.\n"
            "No --enable-gpl or --enable-nonfree is used. Third-party Go license notices are in go-modules/.\n", encoding="utf-8")
        temporary = archive.with_suffix(".zip.part")
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as z:
            for item in sorted(bundle.rglob("*")):
                if item.is_file():
                    z.write(item, item.relative_to(bundle.parent))
        temporary.replace(archive)
    archive.with_suffix(".zip.sha256").write_text(f"{digest(archive)}  {archive.name}\n")
    print(f"Packaged: {archive}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    package(parser.parse_args().executable)

"""Build standalone local launchers from the site/ directory or a release ZIP."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZipFile

DEFAULT_SITE = Path(__file__).resolve().parents[1] / "site"


def verify_asset(path, manifest):
    data = path.read_bytes()
    if len(data) != manifest["bytes"] or hashlib.sha256(data).hexdigest() != manifest["sha256"]:
        raise ValueError(f"Asset does not match its manifest: {path.name}")


def build(source, output):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        site = stage / "site"
        if source.is_dir():
            shutil.copytree(source, site, ignore=shutil.ignore_patterns("_headers", ".DS_Store"))
        else:
            with ZipFile(source) as package:
                for name in package.namelist():
                    if name != "_headers":
                        package.extract(name, site)
        for name in ("index.html", "app.js", "inference-worker.js", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            if not (site / name).is_file():
                raise ValueError(f"Missing release file: {name}")
        for model in ("efficientsed", "efficientat"):
            folder = site / "assets" / model
            manifest = json.loads((folder / "model.json").read_text())
            verify_asset(folder / manifest["modelFile"], manifest)
            json.loads((folder / "frontend.json").read_text())
        vendor = site / "assets/vendor"
        for record in json.loads((vendor / "manifest.json").read_text()):
            verify_asset(vendor / record["name"], record)
        shutil.copy(Path(__file__).parent / "local-launcher/main.go", stage)
        for system, arch, name in (
            ("windows", "amd64", "Apex-Local-Cut-Windows-x64.exe"),
            ("darwin", "arm64", "Apex-Local-Cut-macOS-arm64"),
        ):
            env = dict(os.environ, GOOS=system, GOARCH=arch, CGO_ENABLED="0", GOTOOLCHAIN="local")
            subprocess.run(["go", "build", "-trimpath", "-ldflags=-s -w", "-o",
                            str(output / name), "main.go"], cwd=stage, env=env, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_source", type=Path, nargs="?", default=DEFAULT_SITE,
                        help="Path to the self-contained site/ directory or release ZIP (defaults to ./site)")
    parser.add_argument("--output", type=Path, default=Path("dist/local"))
    args = parser.parse_args()
    build(args.release_source.resolve(), args.output.resolve())

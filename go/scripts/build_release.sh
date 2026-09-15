#!/bin/bash
# Package the Go application on macOS, including Windows cross-builds.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$ROOT/.." && pwd)
TARGET=${1:-darwin}
ARCH=${2:-arm64}
case "$TARGET/$ARCH" in
  darwin/arm64|darwin/amd64) TOOLS="$REPO/bin"; SUFFIX=""; LABEL="macos" ;;
  windows/amd64|windows/arm64) TOOLS="$REPO/bin/windows-$ARCH/bin"; SUFFIX=".exe"; LABEL="windows" ;;
  *) echo 'Usage: bash scripts/build_release.sh {darwin|windows} {arm64|amd64}' >&2; exit 1 ;;
esac
[ "$(uname -s)" = Darwin ] || { echo 'Run this script on macOS' >&2; exit 1; }
for name in ffmpeg ffprobe ffplay; do
  test -f "$TOOLS/$name$SUFFIX" || { echo "Missing $TOOLS/$name$SUFFIX" >&2; exit 1; }
done
mkdir -p "$REPO/build" "$REPO/dist/go"
STAGE=$(mktemp -d "$REPO/build/go-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
BUNDLE="$STAGE/$LABEL-$ARCH"
mkdir -p "$BUNDLE/bin" "$BUNDLE/licenses"
cd "$ROOT"
export GOCACHE=${GOCACHE:-"$REPO/build/go-cache"}
CGO_ENABLED=0 GOOS="$TARGET" GOARCH="$ARCH" go build -trimpath -o "$BUNDLE/apex-highlight$SUFFIX" ./cmd/apex-highlight
GO_LICENSE="$(go env GOROOT)/LICENSE"
if [ ! -f "$GO_LICENSE" ]; then GO_LICENSE="$(go env GOROOT)/../LICENSE"; fi
cp "$GO_LICENSE" "$BUNDLE/licenses/Go-LICENSE.txt"
cp "$ROOT/RELEASE_README.txt" "$BUNDLE/README.txt"
for name in ffmpeg ffprobe ffplay; do cp "$TOOLS/$name$SUFFIX" "$BUNDLE/bin/"; done
if [ "$TARGET" = windows ]; then
  for lib in "$TOOLS"/*.dll; do [ ! -f "$lib" ] || cp "$lib" "$BUNDLE/bin/"; done
  for notice in "$REPO/bin/windows-$ARCH"/LICENSE* "$REPO/bin/windows-$ARCH"/README*; do
    [ ! -f "$notice" ] || cp "$notice" "$BUNDLE/licenses/"
  done
else
  for name in ffmpeg ffprobe ffplay; do
    binary="$BUNDLE/bin/$name"
    lipo "$binary" -verify_arch "${ARCH/amd64/x86_64}"
    otool -L "$binary" | tail -n +2 | awk '{print $1}' | while IFS= read -r dep; do
      case "$dep" in /usr/lib/*|/System/Library/*) ;; *) echo "External dependency: $dep" >&2; exit 1 ;; esac
    done
  done
  if [ -d "$REPO/bin/licenses" ]; then cp -R "$REPO/bin/licenses/." "$BUNDLE/licenses/"; fi
fi
{
  go version
  echo "target=$TARGET/$ARCH"
  echo 'cgo_enabled=false; python_required=false; developer_signed=false; notarized=false'
  (cd "$BUNDLE" && shasum -a 256 "apex-highlight$SUFFIX" bin/*)
} > "$BUNDLE/build-info.txt"
if [ "$TARGET" = darwin ] && [ "$ARCH" = "$(go env GOHOSTARCH)" ]; then
  (cd "$STAGE"; PATH=/usr/bin:/bin "$BUNDLE/apex-highlight" --help; PATH=/usr/bin:/bin "$BUNDLE/apex-highlight" doctor)
  for name in ffmpeg ffprobe ffplay; do PATH=/usr/bin:/bin "$BUNDLE/bin/$name" -version >> "$BUNDLE/build-info.txt"; done
else
  echo 'Cross-build only: run --help, doctor and a recording/preview test on the target OS.'
fi
DEST="$REPO/dist/go/$LABEL-$ARCH"
# Preserve the previous release and any files the user may have created in it.
if [ -e "$DEST" ]; then
  BACKUP=$(mktemp -d "$REPO/build/previous-$LABEL-$ARCH.XXXXXX")
  mv "$DEST" "$BACKUP/"
fi
mv "$BUNDLE" "$DEST"
ARCHIVE="$REPO/dist/go/apex-highlight-$LABEL-$ARCH.zip"
ditto -c -k --sequesterRsrc --keepParent "$DEST" "$ARCHIVE"
echo "Built: $ARCHIVE"

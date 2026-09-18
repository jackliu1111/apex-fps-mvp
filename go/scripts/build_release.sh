#!/bin/bash
# Native CGO builds require the target platform's C toolchain and SDK.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
HOST=$(go env GOHOSTOS)
ARCH=$(go env GOHOSTARCH)
TARGET=${1:-$HOST}
TARGET_ARCH=${2:-$ARCH}
if [ "$TARGET/$TARGET_ARCH" != "$HOST/$ARCH" ]; then
  echo "Run the CGO build on $TARGET/$TARGET_ARCH or use .github/workflows/go-cgo.yml." >&2
  exit 1
fi
cd "$REPO"
exec python3 go/scripts/build_native.py --test --package

#!/bin/sh
set -eu
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
APEX_PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$APEX_PROJECT_ROOT/typescript"
exec bun run dev -- --no-open --port 8787 "$@"

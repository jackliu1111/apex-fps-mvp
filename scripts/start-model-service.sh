#!/bin/sh
set -eu
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
APEX_PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APEX_MODEL_WORKSPACE=${APEX_MODEL_WORKSPACE:-"$APEX_PROJECT_ROOT/../apex-voice-detect"}
APEX_ENGINE_PYTHON=${APEX_ENGINE_PYTHON:-"$APEX_MODEL_WORKSPACE/.venv-pretrainedsed/bin/python"}
if [ "$#" -lt 1 ]; then
  printf 'Usage: sh scripts/start-model-service.sh /path/to/video.mp4 [extra service options]\n' >&2
  exit 2
fi
if [ ! -x "$APEX_ENGINE_PYTHON" ]; then
  printf 'Missing inference Python: %s\n' "$APEX_ENGINE_PYTHON" >&2
  exit 1
fi
APEX_SOURCE_VIDEO=$1
shift
exec "$APEX_ENGINE_PYTHON" "$APEX_PROJECT_ROOT/scripts/model_service.prototype.py" \
  --model-workspace "$APEX_MODEL_WORKSPACE" --source "$APEX_SOURCE_VIDEO" \
  --output "$APEX_PROJECT_ROOT/outputs/model-service" --port 8769 "$@"

#!/bin/sh
set -eu
APEX_PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APEX_MODEL_WORKSPACE=${APEX_MODEL_WORKSPACE:-"$APEX_PROJECT_ROOT/../apex-voice-detect"}
APEX_ENGINE_PYTHON=${APEX_ENGINE_PYTHON:-"$APEX_MODEL_WORKSPACE/.venv-pretrainedsed/bin/python"}
if [ ! -x "$APEX_ENGINE_PYTHON" ]; then
  printf 'Missing inference Python: %s\n' "$APEX_ENGINE_PYTHON" >&2
  exit 1
fi
exec "$APEX_ENGINE_PYTHON" "$APEX_PROJECT_ROOT/model_web.py" \
  --model-workspace "$APEX_MODEL_WORKSPACE" \
  --data-dir "$APEX_PROJECT_ROOT/outputs/python-web" "$@"

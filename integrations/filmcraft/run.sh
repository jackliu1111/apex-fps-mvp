#!/bin/sh
set -eu

APEX_PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
APEX_FILMCRAFT_SOURCE=${APEX_FILMCRAFT_SOURCE:-"$APEX_PROJECT_ROOT/outputs/filmcraft-ai-prototype/filmcraft"}
APEX_FILMCRAFT_BINARY=${APEX_FILMCRAFT_BINARY:-"$APEX_FILMCRAFT_SOURCE/target/debug/filmcraft"}
APEX_FILMCRAFT_DATA_DIR=${APEX_FILMCRAFT_DATA_DIR:-"$APEX_PROJECT_ROOT/outputs/filmcraft-ai-prototype/app-data"}
export APEX_MODEL_WORKSPACE=${APEX_MODEL_WORKSPACE:-"$APEX_PROJECT_ROOT/../apex-voice-detect"}
export APEX_ENGINE_PYTHON=${APEX_ENGINE_PYTHON:-"$APEX_MODEL_WORKSPACE/.venv-pretrainedsed/bin/python"}
export APEX_AI_DATA_DIR=${APEX_AI_DATA_DIR:-"$APEX_PROJECT_ROOT/outputs/filmcraft-ai-prototype/model-data"}
export FILMCRAFT_APEX_PYTHON=${FILMCRAFT_APEX_PYTHON:-"$APEX_ENGINE_PYTHON"}
export FILMCRAFT_APEX_BRIDGE=${FILMCRAFT_APEX_BRIDGE:-"$APEX_PROJECT_ROOT/integrations/filmcraft/bridge.py"}

# Finder starts apps with a smaller PATH than an interactive terminal.
find_media_tool() {
  command -v "$1" 2>/dev/null && return 0
  for APEX_TOOL_PREFIX in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$APEX_TOOL_PREFIX/$1" ]; then
      printf '%s\n' "$APEX_TOOL_PREFIX/$1"
      return 0
    fi
  done
  return 1
}
export APEX_FFMPEG=${APEX_FFMPEG:-$(find_media_tool ffmpeg || true)}
export APEX_FFPROBE=${APEX_FFPROBE:-$(find_media_tool ffprobe || true)}

if [ ! -x "$APEX_FILMCRAFT_BINARY" ]; then
  printf 'Build the prototype first: sh integrations/filmcraft/build.sh\n' >&2
  exit 1
fi
if [ ! -x "$FILMCRAFT_APEX_PYTHON" ] || [ ! -f "$FILMCRAFT_APEX_BRIDGE" ]; then
  printf 'The existing AI runtime or bridge is unavailable. Check FILMCRAFT_APEX_PYTHON and FILMCRAFT_APEX_BRIDGE.\n' >&2
  exit 1
fi
exec "$APEX_FILMCRAFT_BINARY" --empty --data-dir "$APEX_FILMCRAFT_DATA_DIR" "$@"

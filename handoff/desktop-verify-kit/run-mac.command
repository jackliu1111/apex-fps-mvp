#!/bin/sh
set -eu

if [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
Usage: run-mac.command --app APP --source VIDEO --audio-stream INDEX --evidence DIR [--preflight]
  [--stage-timeout-s SECONDS] [--total-timeout-s SECONDS]

APP is the installed .app; VIDEO and DIR are existing paths.
Uses bundled Electron as the controller runtime; no system Node/Python/Bun is required.
--preflight checks the carrier, input and signed installation without a GUI or model.
Default budgets: 1200 seconds per stage, 7200 seconds total; not a waiting-time promise.
USAGE
  exit 0
fi

fail() { printf '%s\n' "$1" >&2; exit 2; }
APEX_KIT_APP=''
APEX_KIT_SOURCE=''
APEX_KIT_STREAM=''
APEX_KIT_EVIDENCE=''
APEX_KIT_PREFLIGHT_MODE='0'
APEX_KIT_STAGE_TIMEOUT='1200'
APEX_KIT_TOTAL_TIMEOUT='7200'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app|--source|--audio-stream|--evidence|--stage-timeout-s|--total-timeout-s)
      [ "$#" -ge 2 ] || fail 'Required: --app --source --audio-stream --evidence'
      case "$1" in
        --app) APEX_KIT_APP=$2 ;;
        --source) APEX_KIT_SOURCE=$2 ;;
        --audio-stream) APEX_KIT_STREAM=$2 ;;
        --evidence) APEX_KIT_EVIDENCE=$2 ;;
        --stage-timeout-s) APEX_KIT_STAGE_TIMEOUT=$2 ;;
        --total-timeout-s) APEX_KIT_TOTAL_TIMEOUT=$2 ;;
      esac
      shift 2 ;;
    --preflight) APEX_KIT_PREFLIGHT_MODE='1'; shift ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[ -n "$APEX_KIT_APP" ] && [ -n "$APEX_KIT_SOURCE" ] && [ -n "$APEX_KIT_STREAM" ] && [ -n "$APEX_KIT_EVIDENCE" ] \
  || fail 'Required: --app --source --audio-stream --evidence'
case "$APEX_KIT_STREAM" in
  *[!0-9]*|'') fail 'audio-stream must be a nonnegative integer' ;;
esac
[ -d "$APEX_KIT_APP" ] || fail 'app must be an existing .app directory'
APEX_KIT_APP=$(CDPATH= cd -- "$APEX_KIT_APP" && pwd -P)
APEX_KIT_BINARY="$APEX_KIT_APP/Contents/MacOS/Apex Model Review"
[ -x "$APEX_KIT_BINARY" ] || fail 'package Electron executable is missing or not executable'
[ -f "$APEX_KIT_SOURCE" ] || fail 'source must be an existing recording file'
case "$APEX_KIT_SOURCE" in
  /*) ;;
  *) fail 'source must use an absolute path' ;;
esac
[ -d "$APEX_KIT_EVIDENCE" ] && [ -w "$APEX_KIT_EVIDENCE" ] \
  || fail 'evidence must be an existing writable directory'
APEX_KIT_EVIDENCE=$(CDPATH= cd -- "$APEX_KIT_EVIDENCE" && pwd -P)
case "$APEX_KIT_EVIDENCE" in
  "$APEX_KIT_APP"|"$APEX_KIT_APP"/*) fail 'evidence directory must be outside the installed app' ;;
esac
APEX_KIT_DIRECTORY=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
[ -f "$APEX_KIT_DIRECTORY/controller.cjs" ] || fail 'kit controller is missing'
exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 \
  APEX_PACKAGED_APP="$APEX_KIT_APP" APEX_SAMPLE="$APEX_KIT_SOURCE" \
  APEX_SAMPLE_AUDIO_STREAM="$APEX_KIT_STREAM" APEX_VALIDATION_DIR="$APEX_KIT_EVIDENCE" \
  APEX_KIT_PREFLIGHT="$APEX_KIT_PREFLIGHT_MODE" \
  APEX_KIT_STAGE_TIMEOUT_S="$APEX_KIT_STAGE_TIMEOUT" APEX_KIT_TOTAL_TIMEOUT_S="$APEX_KIT_TOTAL_TIMEOUT" \
  "$APEX_KIT_BINARY" "$APEX_KIT_DIRECTORY/controller.cjs"

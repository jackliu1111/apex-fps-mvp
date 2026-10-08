#!/bin/sh
# Target-Mac evidence collection. Uses only bundled media tools and macOS built-ins.
# It does not change networking, quarantine, trust settings, or application state.
set -u
if [ "$#" -lt 3 ]; then
  printf '%s\n' 'Usage: /bin/sh verify_model_desktop_mac_handoff.sh APP EVIDENCE_DIR preflight|before-quit|after-quit|decode [ZIP_OR_MEDIA ...]' >&2
  exit 2
fi
app=$1
evidence=$2
phase=$3
shift 3
if [ ! -d "$app/Contents" ]; then printf '%s\n' 'APP must be a complete .app directory' >&2; exit 2; fi
/bin/mkdir -p "$evidence"
case "$phase" in
  preflight)
    {
      /bin/date -u '+observed_at=%Y-%m-%dT%H:%M:%SZ'
      /usr/bin/id
      /usr/bin/uname -m
      /usr/bin/sw_vers
      /usr/sbin/sysctl -n hw.model hw.ncpu hw.memsize
      printf 'app=%s\n' "$app"
      printf 'home=%s\n' "${HOME:-unavailable}"
      for program in python python3 node bun ffmpeg ffprobe; do
        printf 'developer_command_%s=' "$program"
        command -v "$program" || printf '%s\n' 'not_found'
      done
      printf '%s\n' 'scope=metadata only; command absence does not prove a clean machine or offline state'
    } > "$evidence/environment.txt" 2>&1
    /usr/bin/plutil -p "$app/Contents/Info.plist" > "$evidence/info-plist.txt" 2>&1
    /usr/bin/plutil -p "$app/Contents/Resources/runtime/manifest.json" > "$evidence/runtime-manifest.txt" 2>&1
    /usr/bin/codesign -dv --verbose=4 "$app" > "$evidence/codesign-display.txt" 2>&1
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$app" > "$evidence/codesign-verify.txt" 2>&1
    printf 'codesign_verify_exit=%s\n' "$?" > "$evidence/trust-status.txt"
    /usr/sbin/spctl --assess --type execute --verbose=2 "$app" > "$evidence/gatekeeper.txt" 2>&1
    printf 'gatekeeper_exit=%s\n' "$?" >> "$evidence/trust-status.txt"
    /usr/bin/xattr -p com.apple.quarantine "$app" > "$evidence/quarantine.txt" 2>&1
    printf 'quarantine_query_exit=%s\n' "$?" >> "$evidence/trust-status.txt"
    for archive in "$@"; do /usr/bin/shasum -a 256 "$archive"; done > "$evidence/archive-sha256.txt" 2>&1
    printf '%s\n' 'Recorded preflight. A human must record machine provenance, offline state, first-open prompts and actual actions.'
    ;;
  before-quit)
    /bin/ps -axo pid=,ppid=,stat=,command= | /usr/bin/awk -v app="$app/" '
      {
        rows[$1]=$0; parents[$1]=$2
        command=$0
        sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+/, "", command)
        if (index(command,app)==1) owned[$1]=1
      }
      END {
        changed=1
        while (changed) {
          changed=0
          for (pid in rows) if (!owned[pid] && owned[parents[pid]]) { owned[pid]=1; changed=1 }
        }
        for (pid in rows) if (owned[pid]) print rows[pid]
      }
    ' > "$evidence/owned-before-quit.txt"
    if [ ! -s "$evidence/owned-before-quit.txt" ]; then
      printf '%s\n' 'No owned process captured: this is not a valid before-quit sample.' >&2
      exit 1
    fi
    printf '%s\n' 'Captured live app/resource-path PIDs. Now quit normally in the app, then run after-quit.'
    ;;
  after-quit)
    if [ ! -s "$evidence/owned-before-quit.txt" ]; then printf '%s\n' 'Missing nonempty before-quit PID record' >&2; exit 2; fi
    /bin/sleep 5
    /bin/ps -axo pid=,ppid=,stat=,command= | /usr/bin/awk -v app="$app/" '
      NR==FNR { owned[$1]=1; next }
      {
        command=$0
        sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+/, "", command)
        if (owned[$1] || index(command,app)==1) print
      }
    ' "$evidence/owned-before-quit.txt" - > "$evidence/owned-after-quit.txt"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$app" > "$evidence/codesign-after-quit.txt" 2>&1
    seal=$?
    if [ -s "$evidence/owned-after-quit.txt" ] || [ "$seal" -ne 0 ]; then
      printf '%s\n' 'FAIL: owned PID remains or installed resource seal changed; see evidence.' >&2
      exit 1
    fi
    printf '%s\n' 'Recorded captured PIDs gone and unchanged public resource seal. This does not assess media or human sync.'
    ;;
  decode)
    if [ "$#" -eq 0 ]; then printf '%s\n' 'Pass every actual preview/export media path' >&2; exit 2; fi
    ffmpeg="$app/Contents/Resources/runtime/apex-model-service/_internal/bin/ffmpeg"
    ffprobe="$app/Contents/Resources/runtime/apex-model-service/_internal/bin/ffprobe"
    index=0
    failed=0
    for media in "$@"; do
      index=$((index + 1))
      printf '%s\n' "$media" > "$evidence/media-$index-path.txt"
      "$ffprobe" -v error -show_streams -show_format -of json "$media" > "$evidence/media-$index-probe.json" 2> "$evidence/media-$index-probe.log"
      probe=$?
      "$ffmpeg" -nostdin -v error -xerror -i "$media" -map 0:v -map 0:a -f null - > "$evidence/media-$index-decode.log" 2>&1
      code=$?
      printf 'probe_exit=%s\ndecode_exit=%s\n' "$probe" "$code" > "$evidence/media-$index-status.txt"
      if [ "$probe" -ne 0 ] || [ "$code" -ne 0 ]; then failed=1; fi
    done
    printf 'tested_file_count=%s\n' "$index" > "$evidence/media-count.txt"
    exit "$failed"
    ;;
  *) printf '%s\n' 'Unknown phase' >&2; exit 2 ;;
esac

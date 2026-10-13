#!/bin/sh
set -eu

APEX_PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
APEX_FILMCRAFT_SOURCE=${APEX_FILMCRAFT_SOURCE:-"$APEX_PROJECT_ROOT/outputs/filmcraft-ai-prototype/filmcraft"}
APEX_FILMCRAFT_REV=71438c627b5cbcfb550526c3971f4d0037733c5c
APEX_FILMCRAFT_PATCH="$APEX_PROJECT_ROOT/integrations/filmcraft/apex-ai.patch"
APEX_CARGO=${APEX_CARGO:-cargo}

if [ ! -f "$APEX_FILMCRAFT_PATCH" ]; then
  printf 'Missing FilmCraft integration patch: %s\n' "$APEX_FILMCRAFT_PATCH" >&2
  exit 1
fi
if [ ! -d "$APEX_FILMCRAFT_SOURCE/.git" ]; then
  mkdir -p "$(dirname -- "$APEX_FILMCRAFT_SOURCE")"
  git clone --depth 1 --branch v0.7.2 https://github.com/storytold/filmcraft.git "$APEX_FILMCRAFT_SOURCE"
fi
APEX_FILMCRAFT_ACTUAL=$(git -C "$APEX_FILMCRAFT_SOURCE" rev-parse HEAD)
if [ "$APEX_FILMCRAFT_ACTUAL" != "$APEX_FILMCRAFT_REV" ]; then
  printf 'Unexpected FilmCraft revision: %s; expected %s. No reset performed.\n' "$APEX_FILMCRAFT_ACTUAL" "$APEX_FILMCRAFT_REV" >&2
  exit 1
fi
if git -C "$APEX_FILMCRAFT_SOURCE" apply --check "$APEX_FILMCRAFT_PATCH" 2>/dev/null; then
  git -C "$APEX_FILMCRAFT_SOURCE" apply "$APEX_FILMCRAFT_PATCH"
elif ! git -C "$APEX_FILMCRAFT_SOURCE" apply --reverse --check "$APEX_FILMCRAFT_PATCH" 2>/dev/null; then
  printf 'Source changes conflict with the integration patch. No files were reset.\n' >&2
  exit 1
fi
cd "$APEX_FILMCRAFT_SOURCE"
exec "$APEX_CARGO" build --locked -p filmcraft "$@"

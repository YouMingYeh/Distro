#!/usr/bin/env bash
# Optional bulk uploader for self-hosters who already have a folder of footage.
# The normal path is dropping files into the agent chat; see the README.
#
# Usage:
#   DISTRO_URL=https://<worker>.workers.dev scripts/upload-assets.sh ./footage
#
# Optional:
#   DISTRO_BEARER_TOKEN=...   sent as "Authorization: Bearer ..." if set
#
# Requires: curl, jq.
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 1 ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

DIR="$1"
: "${DISTRO_URL:?Set DISTRO_URL to your Worker origin, e.g. https://<worker>.workers.dev}"
BASE="${DISTRO_URL%/}"
BASE="${BASE%/mcp}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[[ -d "$DIR" ]] || { echo "not a directory: $DIR" >&2; exit 1; }

AUTH=()
if [[ -n "${DISTRO_BEARER_TOKEN:-}" ]]; then
  AUTH=(-H "Authorization: Bearer ${DISTRO_BEARER_TOKEN}")
fi

content_type() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *.mp4) echo "video/mp4" ;;
    *.mov) echo "video/quicktime" ;;
    *.webm) echo "video/webm" ;;
    *.m4v) echo "video/x-m4v" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.png) echo "image/png" ;;
    *.webp) echo "image/webp" ;;
    *) echo "" ;;
  esac
}

ASSET_IDS=()
FAILED=0

while IFS= read -r -d '' FILE; do
  NAME="$(basename "$FILE")"
  TYPE="$(content_type "$NAME")"
  if [[ -z "$TYPE" ]]; then
    echo "skip (unsupported type): $NAME" >&2
    continue
  fi
  SIZE="$(wc -c < "$FILE" | tr -d ' ')"

  SLOT="$(jq -n --arg f "$NAME" --arg t "$TYPE" --argjson s "$SIZE" \
      '{filename:$f, size_bytes:$s, content_type:$t}' \
    | curl -sS -X POST "$BASE/api/uploads" "${AUTH[@]+"${AUTH[@]}"}" \
        -H "Content-Type: application/json" --data-binary @-)"

  URL="$(printf '%s' "$SLOT" | jq -r '.upload_url // empty')"
  ASSET="$(printf '%s' "$SLOT" | jq -r '.asset_id // empty')"
  MODE="$(printf '%s' "$SLOT" | jq -r '.mode // empty')"
  if [[ -z "$URL" || -z "$ASSET" ]]; then
    echo "create upload failed: $NAME: $SLOT" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  # Presigned URLs go straight to object storage and must not carry our bearer.
  PUT_AUTH=()
  if [[ "$MODE" != "presigned" && ${#AUTH[@]} -gt 0 ]]; then
    PUT_AUTH=("${AUTH[@]}")
  fi

  CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$URL" \
      "${PUT_AUTH[@]+"${PUT_AUTH[@]}"}" \
      -H "Content-Type: $TYPE" --data-binary @"$FILE")"
  if [[ "$CODE" =~ ^2 ]]; then
    echo "uploaded: $NAME -> $ASSET" >&2
    ASSET_IDS+=("$ASSET")
  else
    echo "PUT failed ($CODE): $NAME" >&2
    FAILED=$((FAILED + 1))
  fi
done < <(find "$DIR" -maxdepth 1 -type f -print0 | sort -z)

if [[ ${#ASSET_IDS[@]} -eq 0 ]]; then
  echo "nothing uploaded" >&2
  exit 1
fi

printf '%s\n' "${ASSET_IDS[@]}" | jq -R . | jq -s '{asset_ids: .}' \
  | curl -sS -X POST "$BASE/api/analyze" "${AUTH[@]+"${AUTH[@]}"}" \
      -H "Content-Type: application/json" --data-binary @-
echo

[[ "$FAILED" -eq 0 ]] || exit 1

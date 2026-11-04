#!/usr/bin/env bash
# Duration STT load test with portal API key (ebma_sk_…, must include `stt` scope).
# Wraps scripts/load-stt-upload-duration.sh
#
# Usage:
#   API_KEY="ebma_sk_..." CONCURRENCY=4 DURATION_SEC=3600 \
#     ./scripts/load-stt-upload-duration-apikey.sh
#
# Env:
#   API_KEY   required — raw ebma_sk_… or "Bearer ebma_sk_…"
#   TOKEN     optional alternative to API_KEY
#   OUT_DIR   default ./scripts/.stt-load-results-duration-apikey/<timestamp>
#   (+ all vars accepted by load-stt-upload-duration.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DURATION_SCRIPT="${SCRIPT_DIR}/load-stt-upload-duration.sh"

if [[ ! -f "$DURATION_SCRIPT" ]]; then
  echo "ERROR: missing duration script: $DURATION_SCRIPT" >&2
  exit 1
fi

API_KEY_PREFIX="ebma_sk_"

resolve_token() {
  local raw="${API_KEY:-${TOKEN:-}}"
  if [[ -z "$raw" ]]; then
    echo "ERROR: Set API_KEY (or TOKEN) to a portal key, e.g. API_KEY='ebma_sk_...'" >&2
    exit 1
  fi

  if [[ "$raw" == Bearer\ * ]]; then
    raw="${raw#Bearer }"
  fi
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"

  if [[ "$raw" != ${API_KEY_PREFIX}* ]]; then
    echo "ERROR: API key must start with ${API_KEY_PREFIX}" >&2
    echo "       Create a key in the portal with the 'stt' scope." >&2
    exit 1
  fi

  printf 'Bearer %s' "$raw"
}

export TOKEN
TOKEN="$(resolve_token)"
export OUT_DIR="${OUT_DIR:-./scripts/.stt-load-results-duration-apikey/$(date +%Y%m%d-%H%M%S)}"

echo "STT duration load test (API key auth)"
echo "  key_prefix=${TOKEN:0:18}…"
echo "  OUT_DIR=$OUT_DIR"
echo

exec bash "$DURATION_SCRIPT"

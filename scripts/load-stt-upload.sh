#!/usr/bin/env bash
# Load-test STT file upload: POST /api/v1/stt/transcriptions (Indic languages only).
#
# Usage (Git Bash / WSL / Linux / macOS):
#   chmod +x scripts/load-stt-upload.sh
#   TOKEN="Bearer eyJ..." FILE=./sample.wav ./scripts/load-stt-upload.sh
#
# Env:
#   BASE_URL      default http://localhost:5002
#   TOKEN         required — "Bearer <jwt>" or API key as sent by the client
#   FILE          path to audio (wav/mp3/…)
#   LANGUAGE      default hi  (do not use ar — multipart Arabic is rejected)
#   DIARIZE       default false
#   CONCURRENCY   default 5
#   TOTAL         default 20
#   POLL          default 1 — set 0 to skip status polling
#   POLL_INTERVAL default 2 (seconds)
#   POLL_MAX      default 60 (attempts per job)
#   TIMEOUT       default 120 (curl max-time for upload, seconds)
#   OUT_DIR       default ./scripts/.stt-load-results/<timestamp>

set -euo pipefail

# BASE_URL="${BASE_URL:-https://api.ebma.ai}"
# TOKEN="${TOKEN:?Set TOKEN, e.g. TOKEN='Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImEwMmE5NDYwLWQyMDgtNDAxYi04ZTRhLTM1ZmM3MTc5M2Q0YiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzkzMjY5Njg3LCJleHAiOjE3OTU4NjE2ODd9.E3obLAJhY35BfPRtOkjO0BdxUNWlAFuMtvAGYzEfxFQ' }"
# FILE="${FILE:?Set FILE to an audio path, e.g. FILE=./sample.wav}"
# LANGUAGE="${LANGUAGE:-hi}"
# DIARIZE="${DIARIZE:-false}"
# CONCURRENCY="${CONCURRENCY:-5}"
# TOTAL="${TOTAL:-20}"
# POLL="${POLL:-1}"
# POLL_INTERVAL="${POLL_INTERVAL:-2}"
# POLL_MAX="${POLL_MAX:-60}"
# TIMEOUT="${TIMEOUT:-120}"
export BASE_URL="https://api.ebma.ai"
export TOKEN="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."   # paste your real token
export FILE="docs/ebma-asr/docs/sample_hi.wav"
export LANGUAGE="hi"
export DIARIZE="false"
export TOTAL="1"
export CONCURRENCY="1"
export POLL="1"
export POLL_INTERVAL="2"
export POLL_MAX="60"
export TIMEOUT="120"
OUT_DIR="${OUT_DIR:-./scripts/.stt-load-results/$(date +%Y%m%d-%H%M%S)}"

if [[ ! -f "$FILE" ]]; then
  echo "ERROR: FILE not found: $FILE" >&2
  exit 1
fi

if [[ "$LANGUAGE" == "ar" ]]; then
  echo "ERROR: language=ar cannot use multipart upload. Use an Indic language (hi, en, …)." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2
  exit 1
fi

HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=1
fi

mkdir -p "$OUT_DIR/meta"
SUMMARY="$OUT_DIR/summary.txt"
RESULTS="$OUT_DIR/results.tsv"

echo "STT upload load test"
echo "  BASE_URL=$BASE_URL"
echo "  FILE=$FILE ($(wc -c < "$FILE" | tr -d ' ') bytes)"
echo "  LANGUAGE=$LANGUAGE DIARIZE=$DIARIZE"
echo "  TOTAL=$TOTAL CONCURRENCY=$CONCURRENCY POLL=$POLL"
echo "  OUT_DIR=$OUT_DIR"
echo

json_get() {
  # json_get <json> <jq-path> — falls back to python if jq missing
  local json="$1"
  local path="$2"
  if [[ "$HAS_JQ" -eq 1 ]]; then
    echo "$json" | jq -r "$path // empty" 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    local py=python3
    command -v python3 >/dev/null 2>&1 || py=python
    "$py" - "$json" "$path" <<'PY' 2>/dev/null || true
import json, sys
raw, path = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
except Exception:
    sys.exit(0)
# Support simple paths like .data.transcriptionUuid
cur = data
for part in path.lstrip(".").split("."):
    if part == "":
        continue
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        cur = None
        break
if cur is None or cur is False:
    pass
elif isinstance(cur, (dict, list)):
    print(json.dumps(cur))
else:
    print(cur)
PY
  fi
}

upload_and_maybe_poll() {
  local i="$1"
  local body_file="$OUT_DIR/req-${i}.body.json"
  local meta_file="$OUT_DIR/req-${i}.meta"
  local start end upload_sec code body uuid final_status poll_sec ok

  start=$(date +%s.%N 2>/dev/null || date +%s)

  code=$(curl -sS -o "$body_file" -w "%{http_code}" \
    --max-time "$TIMEOUT" \
    -X POST "${BASE_URL}/api/v1/stt/transcriptions" \
    -H "Authorization: ${TOKEN}" \
    -F "file=@${FILE}" \
    -F "language=${LANGUAGE}" \
    -F "diarize=${DIARIZE}" \
    || echo "000")

  end=$(date +%s.%N 2>/dev/null || date +%s)
  if command -v bc >/dev/null 2>&1; then
    upload_sec=$(echo "$end - $start" | bc)
  else
    upload_sec="$end"
  fi

  body=$(cat "$body_file" 2>/dev/null || echo "")
  uuid=$(json_get "$body" ".data.transcriptionUuid")
  final_status=""
  poll_sec="0"
  ok="0"

  if [[ "$code" == "202" || "$code" == "200" ]] && [[ -n "$uuid" ]]; then
    ok="1"
    final_status=$(json_get "$body" ".data.status")
    final_status="${final_status:-queued}"

    if [[ "$POLL" == "1" ]]; then
      local pstart pend attempt=0 status="$final_status"
      pstart=$(date +%s.%N 2>/dev/null || date +%s)
      while [[ "$attempt" -lt "$POLL_MAX" ]]; do
        if [[ "$status" == "completed" || "$status" == "failed" ]]; then
          break
        fi
        sleep "$POLL_INTERVAL"
        attempt=$((attempt + 1))
        local poll_body
        poll_body=$(curl -sS --max-time 30 \
          -H "Authorization: ${TOKEN}" \
          "${BASE_URL}/api/v1/stt/transcriptions/${uuid}" || echo "")
        status=$(json_get "$poll_body" ".data.status")
        status="${status:-unknown}"
      done
      pend=$(date +%s.%N 2>/dev/null || date +%s)
      if command -v bc >/dev/null 2>&1; then
        poll_sec=$(echo "$pend - $pstart" | bc)
      else
        poll_sec="$pend"
      fi
      final_status="$status"
      if [[ "$final_status" != "completed" ]]; then
        ok="0"
      fi
    fi
  fi

  {
    echo "index=$i"
    echo "http_code=$code"
    echo "upload_sec=$upload_sec"
    echo "uuid=$uuid"
    echo "final_status=$final_status"
    echo "poll_sec=$poll_sec"
    echo "ok=$ok"
  } > "$meta_file"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$i" "$code" "$upload_sec" "${uuid:-}" "${final_status:-}" "$poll_sec" "$ok" \
    > "$OUT_DIR/meta/req-${i}.tsv"

  echo "[$i/$TOTAL] http=$code upload=${upload_sec}s uuid=${uuid:--} status=${final_status:--} ok=$ok"
}

export -f upload_and_maybe_poll json_get
export BASE_URL TOKEN FILE LANGUAGE DIARIZE TOTAL POLL POLL_INTERVAL POLL_MAX TIMEOUT OUT_DIR HAS_JQ

WALL_START=$(date +%s)

# Prefer GNU/xargs parallel; fall back to background jobs with a simple semaphore.
if xargs --help 2>&1 | grep -q -- '-P'; then
  seq 1 "$TOTAL" | xargs -P "$CONCURRENCY" -I{} bash -c 'upload_and_maybe_poll "$@"' _ {}
else
  running=0
  for i in $(seq 1 "$TOTAL"); do
    upload_and_maybe_poll "$i" &
    running=$((running + 1))
    if [[ "$running" -ge "$CONCURRENCY" ]]; then
      wait -n 2>/dev/null || wait
      running=$((running - 1))
    fi
  done
  wait
fi

WALL_END=$(date +%s)
WALL_SEC=$((WALL_END - WALL_START))

{
  echo -e "index\thttp_code\tupload_sec\tuuid\tfinal_status\tpoll_sec\tok"
  for i in $(seq 1 "$TOTAL"); do
    [[ -f "$OUT_DIR/meta/req-${i}.tsv" ]] && cat "$OUT_DIR/meta/req-${i}.tsv"
  done
} > "$RESULTS"

OK_COUNT=$(awk -F'\t' 'NR>1 && $7=="1" {c++} END{print c+0}' "$RESULTS")
FAIL_COUNT=$((TOTAL - OK_COUNT))
HTTP_OK=$(awk -F'\t' 'NR>1 && ($2=="200" || $2=="202") {c++} END{print c+0}' "$RESULTS")

{
  echo "wall_seconds=$WALL_SEC"
  echo "total=$TOTAL"
  echo "http_accepted=$HTTP_OK"
  echo "ok=$OK_COUNT"
  echo "fail=$FAIL_COUNT"
  echo "concurrency=$CONCURRENCY"
  echo "language=$LANGUAGE"
  echo "file=$FILE"
  echo "results=$RESULTS"
} | tee "$SUMMARY"

echo
echo "Done. Summary: $SUMMARY"
echo "Per-request TSV: $RESULTS"

#!/usr/bin/env bash
# Load-test STT file upload: POST /api/v1/stt/transcriptions (Indic languages only).
#
# Usage (Git Bash / WSL / Linux / macOS / CMD via bash):
#   TOKEN="Bearer eyJ..." FILE=docs/ebma-asr/docs/sample_hi.wav ./scripts/load-stt-upload.sh
#
# Env:
#   BASE_URL      default https://api.ebma.ai
#   TOKEN         required — "Bearer <jwt>" or API key
#   FILE          path to audio (default docs/ebma-asr/docs/sample_hi.wav)
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

BASE_URL="${BASE_URL:-https://api.ebma.ai}"
TOKEN="${TOKEN:?Set TOKEN, e.g. TOKEN='Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImEwMmE5NDYwLWQyMDgtNDAxYi04ZTRhLTM1ZmM3MTc5M2Q0YiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzkzMjY5Njg3LCJleHAiOjE3OTU4NjE2ODd9.E3obLAJhY35BfPRtOkjO0BdxUNWlAFuMtvAGYzEfxFQ' }"
FILE="${FILE:-docs/ebma-asr/docs/sample_hi.wav}"
LANGUAGE="${LANGUAGE:-hi}"
DIARIZE="${DIARIZE:-false}"
CONCURRENCY="${CONCURRENCY:-5}"
TOTAL="${TOTAL:-20}"
POLL="${POLL:-1}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
POLL_MAX="${POLL_MAX:-60}"
TIMEOUT="${TIMEOUT:-120}"
# export BASE_URL="https://api.ebma.ai"
# export TOKEN="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImEwMmE5NDYwLWQyMDgtNDAxYi04ZTRhLTM1ZmM3MTc5M2Q0YiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzkzMjY5Njg3LCJleHAiOjE3OTU4NjE2ODd9.E3obLAJhY35BfPRtOkjO0BdxUNWlAFuMtvAGYzEfxFQ"   # paste your real token
# export FILE="docs/ebma-asr/docs/sample_hi.wav"
# export LANGUAGE="hi"
# export DIARIZE="false"
# export TOTAL="1"
# export CONCURRENCY="1"
# export POLL="1"
# export POLL_INTERVAL="2"
# export POLL_MAX="60"
# export TIMEOUT="120"
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

mkdir -p "$OUT_DIR/meta" "$OUT_DIR/logs"
SUMMARY="$OUT_DIR/summary.txt"
RESULTS="$OUT_DIR/results.tsv"
RUN_LOG="$OUT_DIR/run.log"

now_epoch() {
  # Prefer fractional seconds; fall back to integer (Git Bash often lacks %N).
  date +%s.%N 2>/dev/null | grep -Eq '^[0-9]+\.[0-9]+$' && date +%s.%N && return
  date +%s
}

elapsed_sec() {
  local start="$1" end
  end=$(now_epoch)
  if command -v awk >/dev/null 2>&1; then
    awk -v s="$start" -v e="$end" 'BEGIN { printf "%.3f", e - s }'
  elif command -v bc >/dev/null 2>&1; then
    echo "$end - $start" | bc
  else
    echo "$(( ${end%.*} - ${start%.*} ))"
  fi
}

http_indication() {
  case "$1" in
    000) echo "Curl failed — network/DNS/timeout/TLS" ;;
    200) echo "OK" ;;
    201) echo "Created" ;;
    202) echo "Accepted — transcription job queued/started" ;;
    400) echo "Bad request — validation / missing file / Arabic upload rejected" ;;
    401) echo "Unauthorized — missing or wrong credentials" ;;
    403) echo "Forbidden — disabled user / unverified email / no access" ;;
    404) echo "Not found — wrong BASE_URL or path" ;;
    413) echo "Payload too large — file exceeds size limit" ;;
    415) echo "Unsupported media type" ;;
    422) echo "Unprocessable entity" ;;
    429) echo "Too many requests — rate limit / too_many_jobs" ;;
    500) echo "Internal server error" ;;
    502) echo "Bad gateway — upstream ASR issue" ;;
    503) echo "Service unavailable — ASR/model down or misconfigured" ;;
    504) echo "Gateway timeout — ASR took too long" ;;
    601) echo "Restricted — invalid / missing / expired token (EBMA)" ;;
    *)   echo "HTTP $1" ;;
  esac
}

job_status_indication() {
  case "$1" in
    queued)     echo "Waiting in ASR queue" ;;
    processing) echo "ASR is transcribing" ;;
    completed)  echo "Finished successfully" ;;
    failed)     echo "Job failed" ;;
    cancelled)  echo "Job cancelled" ;;
    unknown|"") echo "Status unknown / not parsed" ;;
    *)          echo "$1" ;;
  esac
}

log_line() {
  # Timestamped line to console + run.log
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date)
  local line="[$ts] $*"
  echo "$line" | tee -a "$RUN_LOG"
}

json_get() {
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
  local meta_file="$OUT_DIR/meta/req-${i}.meta"
  local req_log="$OUT_DIR/logs/req-${i}.log"
  local start upload_sec code body uuid final_status poll_sec ok
  local api_msg http_label status_label err_code err_msg

  : > "$req_log"

  start=$(now_epoch)
  code=$(curl -sS -o "$body_file" -w "%{http_code}" \
    --max-time "$TIMEOUT" \
    -X POST "${BASE_URL}/api/v1/stt/transcriptions" \
    -H "Authorization: ${TOKEN}" \
    -F "file=@${FILE}" \
    -F "language=${LANGUAGE}" \
    -F "diarize=${DIARIZE}" \
    || echo "000")
  upload_sec=$(elapsed_sec "$start")

  body=$(cat "$body_file" 2>/dev/null || echo "")
  uuid=$(json_get "$body" ".data.transcriptionUuid")
  api_msg=$(json_get "$body" ".message")
  err_code=$(json_get "$body" ".data.error.code")
  err_msg=$(json_get "$body" ".data.error.message")
  final_status=$(json_get "$body" ".data.status")
  final_status="${final_status:-}"
  poll_sec="0"
  ok="0"
  http_label=$(http_indication "$code")

  {
    echo "[$i/$TOTAL] UPLOAD http=$code ($http_label) ${upload_sec}s"
    echo "         msg=${api_msg:--}"
    [[ -n "$err_code" || -n "$err_msg" ]] && echo "         error=${err_code:--}: ${err_msg:--}"
  } | tee -a "$req_log" "$RUN_LOG"

  if [[ "$code" == "202" || "$code" == "200" ]] && [[ -n "$uuid" ]]; then
    ok="1"
    final_status="${final_status:-queued}"
    status_label=$(job_status_indication "$final_status")
    echo "[$i/$TOTAL] QUEUED uuid=$uuid status=$final_status ($status_label)" | tee -a "$req_log" "$RUN_LOG"

    if [[ "$POLL" == "1" ]]; then
      local pstart attempt=0 status="$final_status" poll_code poll_body poll_msg
      pstart=$(now_epoch)
      while [[ "$attempt" -lt "$POLL_MAX" ]]; do
        if [[ "$status" == "completed" || "$status" == "failed" || "$status" == "cancelled" ]]; then
          break
        fi
        sleep "$POLL_INTERVAL"
        attempt=$((attempt + 1))
        poll_code=$(curl -sS -o "$OUT_DIR/meta/req-${i}.poll.json" -w "%{http_code}" \
          --max-time 30 \
          -H "Authorization: ${TOKEN}" \
          "${BASE_URL}/api/v1/stt/transcriptions/${uuid}" \
          || echo "000")
        poll_body=$(cat "$OUT_DIR/meta/req-${i}.poll.json" 2>/dev/null || echo "")
        status=$(json_get "$poll_body" ".data.status")
        status="${status:-unknown}"
        poll_msg=$(json_get "$poll_body" ".message")
        err_code=$(json_get "$poll_body" ".data.error.code")
        err_msg=$(json_get "$poll_body" ".data.error.message")
        status_label=$(job_status_indication "$status")
        echo "[$i/$TOTAL] POLL   attempt=$attempt/$POLL_MAX http=$poll_code status=$status ($status_label)" \
          | tee -a "$req_log" "$RUN_LOG"
        if [[ -n "$err_code" || -n "$err_msg" ]]; then
          echo "         error=${err_code:--}: ${err_msg:--}" | tee -a "$req_log" "$RUN_LOG"
        fi
      done
      poll_sec=$(elapsed_sec "$pstart")
      final_status="$status"
      if [[ "$final_status" != "completed" ]]; then
        ok="0"
      fi
    fi
  else
    if [[ -z "$uuid" && ( "$code" == "202" || "$code" == "200" ) ]]; then
      echo "[$i/$TOTAL] WARN   Accepted but transcriptionUuid missing — check JSON path / body" \
        | tee -a "$req_log" "$RUN_LOG"
    fi
  fi

  status_label=$(job_status_indication "$final_status")
  if [[ "$ok" == "1" ]]; then
    echo "[$i/$TOTAL] DONE   ok=1 status=$final_status ($status_label) upload=${upload_sec}s poll=${poll_sec}s uuid=${uuid:--}" \
      | tee -a "$req_log" "$RUN_LOG"
  else
    echo "[$i/$TOTAL] FAIL   ok=0 http=$code ($http_label) status=${final_status:--} ($status_label) uuid=${uuid:--}" \
      | tee -a "$req_log" "$RUN_LOG"
  fi
  echo | tee -a "$req_log" "$RUN_LOG"

  {
    echo "index=$i"
    echo "http_code=$code"
    echo "http_indication=$http_label"
    echo "api_message=${api_msg:-}"
    echo "upload_sec=$upload_sec"
    echo "uuid=${uuid:-}"
    echo "final_status=${final_status:-}"
    echo "final_status_indication=$status_label"
    echo "poll_sec=$poll_sec"
    echo "error_code=${err_code:-}"
    echo "error_message=${err_msg:-}"
    echo "ok=$ok"
  } > "$meta_file"

  # index http_code http_indication upload_sec uuid final_status status_indication poll_sec ok
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$i" "$code" "$http_label" "$upload_sec" "${uuid:-}" \
    "${final_status:-}" "$status_label" "$poll_sec" "$ok" \
    > "$OUT_DIR/meta/req-${i}.tsv"
}

export -f upload_and_maybe_poll json_get http_indication job_status_indication \
  now_epoch elapsed_sec log_line
export BASE_URL TOKEN FILE LANGUAGE DIARIZE TOTAL POLL POLL_INTERVAL POLL_MAX TIMEOUT
export OUT_DIR HAS_JQ RUN_LOG

: > "$RUN_LOG"
log_line "STT upload load test starting"
log_line "  BASE_URL=$BASE_URL"
log_line "  FILE=$FILE ($(wc -c < "$FILE" | tr -d ' ') bytes)"
log_line "  LANGUAGE=$LANGUAGE DIARIZE=$DIARIZE"
log_line "  TOTAL=$TOTAL CONCURRENCY=$CONCURRENCY POLL=$POLL"
log_line "  OUT_DIR=$OUT_DIR"
log_line "-----"

WALL_START=$(date +%s)

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
  echo -e "index\thttp_code\thttp_indication\tupload_sec\tuuid\tfinal_status\tstatus_indication\tpoll_sec\tok"
  for i in $(seq 1 "$TOTAL"); do
    [[ -f "$OUT_DIR/meta/req-${i}.tsv" ]] && cat "$OUT_DIR/meta/req-${i}.tsv"
  done
} > "$RESULTS"

OK_COUNT=$(awk -F'\t' 'NR>1 && $9=="1" {c++} END{print c+0}' "$RESULTS")
FAIL_COUNT=$((TOTAL - OK_COUNT))
HTTP_OK=$(awk -F'\t' 'NR>1 && ($2=="200" || $2=="202") {c++} END{print c+0}' "$RESULTS")

{
  echo "======== STT LOAD TEST SUMMARY ========"
  echo "wall_seconds=$WALL_SEC"
  echo "total=$TOTAL"
  echo "concurrency=$CONCURRENCY"
  echo "language=$LANGUAGE"
  echo "file=$FILE"
  echo "base_url=$BASE_URL"
  echo
  echo "http_accepted (200/202)=$HTTP_OK"
  echo "ok (completed)=$OK_COUNT"
  echo "fail=$FAIL_COUNT"
  echo
  echo "---- HTTP status counts ----"
  awk -F'\t' 'NR>1 { c[$2]++ } END { for (k in c) printf "  %s x %s\n", k, c[k] }' "$RESULTS" | sort
  echo
  echo "---- Job status counts ----"
  awk -F'\t' 'NR>1 { s=$6; if (s=="") s="(none)"; c[s]++ } END { for (k in c) printf "  %s x %s\n", k, c[k] }' "$RESULTS" | sort
  echo
  echo "---- Legend (HTTP) ----"
  echo "  000 = Curl failed (network/timeout)"
  echo "  202 = Accepted — job started"
  echo "  400 = Bad request"
  echo "  403 = Forbidden"
  echo "  413 = File too large"
  echo "  429 = Rate limited / too_many_jobs"
  echo "  503 = ASR unavailable"
  echo "  601 = Invalid/expired token (EBMA)"
  echo
  echo "---- Legend (job status) ----"
  echo "  queued     = Waiting in ASR queue"
  echo "  processing = ASR running"
  echo "  completed  = Success"
  echo "  failed     = Job failed"
  echo
  echo "results=$RESULTS"
  echo "run_log=$RUN_LOG"
  echo "======================================="
} | tee "$SUMMARY" | tee -a "$RUN_LOG"

echo
echo "Done. Summary: $SUMMARY"
echo "Full log:     $RUN_LOG"
echo "Per-request:  $RESULTS"

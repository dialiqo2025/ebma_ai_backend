#!/usr/bin/env bash
# Duration-based STT upload load test with interval reports.
# Leaves scripts/load-stt-upload.sh unchanged (fixed TOTAL runs).
#
# Usage:
#   TOKEN="Bearer eyJ..." CONCURRENCY=4 DURATION_SEC=3600 ./scripts/load-stt-upload-duration.sh
#
# Env:
#   BASE_URL           default https://api.ebma.ai
#   TOKEN              required
#   FILE               default docs/ebma-asr/docs/sample_hi.wav  (single file)
#   LANGUAGE           default hi
#   DIARIZE            default false
#   CONCURRENCY        default 4
#   DURATION_SEC       default 3600 (1 hour)
#   REPORT_EVERY_SEC   default 60
#   POLL               default 1 (wait for completed/failed)
#   POLL_INTERVAL      default 2
#   POLL_MAX           default 60
#   TIMEOUT            default 120
#   OUT_DIR            default ./scripts/.stt-load-results-duration/<timestamp>

set -euo pipefail

BASE_URL="${BASE_URL:-https://api.ebma.ai}"
TOKEN="${TOKEN:?Set TOKEN, e.g. TOKEN='Bearer eyJ...' }"
FILE="${FILE:-docs/ebma-asr/docs/sample_hi.wav}"
LANGUAGE="${LANGUAGE:-hi}"
DIARIZE="${DIARIZE:-false}"
CONCURRENCY="${CONCURRENCY:-4}"
DURATION_SEC="${DURATION_SEC:-3600}"
REPORT_EVERY_SEC="${REPORT_EVERY_SEC:-60}"
POLL="${POLL:-1}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
POLL_MAX="${POLL_MAX:-60}"
TIMEOUT="${TIMEOUT:-120}"
OUT_DIR="${OUT_DIR:-./scripts/.stt-load-results-duration/$(date +%Y%m%d-%H%M%S)}"

if [[ ! -f "$FILE" ]]; then
  echo "ERROR: FILE not found: $FILE" >&2
  exit 1
fi
if [[ "$LANGUAGE" == "ar" ]]; then
  echo "ERROR: language=ar cannot use multipart upload." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2
  exit 1
fi
if ! command -v awk >/dev/null 2>&1; then
  echo "ERROR: awk is required" >&2
  exit 1
fi

HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

mkdir -p "$OUT_DIR/rows" "$OUT_DIR/inflight" "$OUT_DIR/bodies" "$OUT_DIR/logs"
SUMMARY="$OUT_DIR/summary.txt"
RESULTS="$OUT_DIR/results.tsv"
INTERVALS="$OUT_DIR/intervals.tsv"
RUN_LOG="$OUT_DIR/run.log"
STOP_FLAG="$OUT_DIR/STOP"

FILE_BYTES=$(wc -c < "$FILE" | tr -d ' ')
FILE_BASE=$(basename "$FILE")

now_epoch() {
  local d
  d=$(date +%s.%N 2>/dev/null || true)
  if echo "$d" | grep -Eq '^[0-9]+\.[0-9]+$'; then
    echo "$d"
  else
    date +%s
  fi
}

elapsed_sec() {
  awk -v s="$1" -v e="$(now_epoch)" 'BEGIN { printf "%.3f", e - s }'
}

fmt_mmss() {
  local s="$1"
  printf "%02d:%02d" $((s / 60)) $((s % 60))
}

http_indication() {
  case "$1" in
    000) echo "Curl failed — network/DNS/timeout/TLS" ;;
    200) echo "OK" ;;
    202) echo "Accepted — job queued/started" ;;
    400) echo "Bad request" ;;
    401) echo "Unauthorized" ;;
    403) echo "Forbidden" ;;
    404) echo "Not found" ;;
    413) echo "File too large" ;;
    429) echo "Rate limited / too_many_jobs" ;;
    500) echo "Internal server error" ;;
    502) echo "Bad gateway" ;;
    503) echo "ASR unavailable" ;;
    504) echo "Gateway timeout" ;;
    601) echo "Restricted — invalid/expired token" ;;
    *)   echo "HTTP $1" ;;
  esac
}

log_line() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date)
  echo "[$ts] $*" | tee -a "$RUN_LOG"
}

json_get() {
  local json="$1" path="$2"
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
    if not part:
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

# Write one completed request row (atomic via unique file).
# cols: end_epoch worker seq http_code upload_sec poll_sec e2e_sec uuid status ok err_code
write_row() {
  local end_epoch="$1" worker="$2" seq="$3" code="$4" upload_sec="$5"
  local poll_sec="$6" e2e_sec="$7" uuid="$8" status="$9" ok="$10" err_code="${11:-}"
  local row_file="$OUT_DIR/rows/w${worker}-$(printf '%06d' "$seq").tsv"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$end_epoch" "$worker" "$seq" "$code" "$upload_sec" "$poll_sec" \
    "$e2e_sec" "${uuid:-}" "${status:-}" "$ok" "${err_code:-}" \
    > "$row_file"
}

worker_loop() {
  local worker="$1"
  local seq=0
  local e2e_start upload_start code body uuid status ok
  local upload_sec poll_sec e2e_sec api_msg err_code err_msg
  local body_file poll_body poll_code attempt pstart inflight_id

  while [[ ! -f "$STOP_FLAG" ]]; do
    # Stop starting new work after duration; in-flight may finish after.
    if awk -v now="$(now_epoch)" -v end="$END_EPOCH" 'BEGIN { exit (now + 0 >= end + 0) }'; then
      break
    fi

    seq=$((seq + 1))
    inflight_id="w${worker}_${seq}"
    : > "$OUT_DIR/inflight/$inflight_id"
    body_file="$OUT_DIR/bodies/${inflight_id}.json"
    e2e_start=$(now_epoch)

    upload_start=$(now_epoch)
    code=$(curl -sS -o "$body_file" -w "%{http_code}" \
      --max-time "$TIMEOUT" \
      -X POST "${BASE_URL}/api/v1/stt/transcriptions" \
      -H "Authorization: ${TOKEN}" \
      -F "file=@${FILE}" \
      -F "language=${LANGUAGE}" \
      -F "diarize=${DIARIZE}" \
      || echo "000")
    upload_sec=$(elapsed_sec "$upload_start")

    body=$(cat "$body_file" 2>/dev/null || echo "")
    uuid=$(json_get "$body" ".data.transcriptionUuid")
    api_msg=$(json_get "$body" ".message")
    err_code=$(json_get "$body" ".data.error.code")
    err_msg=$(json_get "$body" ".data.error.message")
    status=$(json_get "$body" ".data.status")
    status="${status:-}"
    poll_sec="0"
    ok="0"

    echo "[w$worker #$seq] UPLOAD http=$code ($(http_indication "$code")) ${upload_sec}s msg=${api_msg:--}" \
      >> "$OUT_DIR/logs/worker-${worker}.log"

    if [[ "$code" == "202" || "$code" == "200" ]] && [[ -n "$uuid" ]]; then
      ok="1"
      status="${status:-queued}"
      if [[ "$POLL" == "1" ]]; then
        attempt=0
        pstart=$(now_epoch)
        while [[ "$attempt" -lt "$POLL_MAX" ]]; do
          if [[ "$status" == "completed" || "$status" == "failed" || "$status" == "cancelled" ]]; then
            break
          fi
          sleep "$POLL_INTERVAL"
          attempt=$((attempt + 1))
          poll_code=$(curl -sS -o "$OUT_DIR/bodies/${inflight_id}.poll.json" -w "%{http_code}" \
            --max-time 30 \
            -H "Authorization: ${TOKEN}" \
            "${BASE_URL}/api/v1/stt/transcriptions/${uuid}" \
            || echo "000")
          poll_body=$(cat "$OUT_DIR/bodies/${inflight_id}.poll.json" 2>/dev/null || echo "")
          status=$(json_get "$poll_body" ".data.status")
          status="${status:-unknown}"
          err_code=$(json_get "$poll_body" ".data.error.code")
          echo "[w$worker #$seq] POLL $attempt/$POLL_MAX http=$poll_code status=$status" \
            >> "$OUT_DIR/logs/worker-${worker}.log"
        done
        poll_sec=$(elapsed_sec "$pstart")
        [[ "$status" == "completed" ]] || ok="0"
      fi
    fi

    e2e_sec=$(elapsed_sec "$e2e_start")
    write_row "$(now_epoch)" "$worker" "$seq" "$code" "$upload_sec" \
      "$poll_sec" "$e2e_sec" "${uuid:-}" "${status:-}" "$ok" "${err_code:-}"
    rm -f "$OUT_DIR/inflight/$inflight_id"

    if [[ "$ok" == "1" ]]; then
      echo "[w$worker #$seq] DONE ok=1 status=$status e2e=${e2e_sec}s uuid=${uuid:--}" \
        >> "$OUT_DIR/logs/worker-${worker}.log"
    else
      echo "[w$worker #$seq] FAIL ok=0 http=$code status=${status:--} err=${err_code:--} ${err_msg:--}" \
        >> "$OUT_DIR/logs/worker-${worker}.log"
    fi
  done
}

# Aggregate stats from rows finished at/before cutoff_epoch (empty = all).
# Prints a multi-line report; also appends one TSV line to INTERVALS when label given.
emit_report() {
  local elapsed_s="$1"
  local label="$2"   # e.g. t=05:00 or FINAL
  local cutoff="${3:-}"
  local milestone="${4:-0}"
  local inflight
  inflight=$(find "$OUT_DIR/inflight" -type f 2>/dev/null | wc -l | tr -d ' ')

  local tmp_all="$OUT_DIR/.rows_all.tsv"
  cat "$OUT_DIR/rows"/*.tsv 2>/dev/null > "$tmp_all" || true

  local report
  report=$(CUTOFF="$cutoff" WINDOW_SEC="$REPORT_EVERY_SEC" ELAPSED="$elapsed_s" INFLIGHT="$inflight" \
    awk -F'\t' '
    function pct(a, n, p,    i) {
      if (n < 1) return 0
      i = int((p/100.0)*(n-1)) + 1
      if (i < 1) i = 1
      if (i > n) i = n
      return a[i]
    }
    function avg(sum, n) { return n ? sum/n : 0 }
    function rate(n, d) { return d ? (100.0*n)/d : 0 }
    BEGIN {
      cutoff = ENVIRON["CUTOFF"] + 0
      window = ENVIRON["WINDOW_SEC"] + 0
      elapsed = ENVIRON["ELAPSED"] + 0
      inflight = ENVIRON["INFLIGHT"] + 0
      has_cutoff = (ENVIRON["CUTOFF"] != "")
    }
    {
      te = $1 + 0
      if (has_cutoff && te > cutoff) next
      hits++
      code = $4
      up = $5 + 0
      po = $6 + 0
      e2e = $7 + 0
      st = $9
      ok = $10
      err = $11
      http[code]++
      if (st == "") st = "(none)"
      job[st]++
      if (ok == "1") oks++; else fails++
      ups[hits] = up; up_sum += up
      e2es[hits] = e2e; e2e_sum += e2e
      if (po > 0) { polls[++pn] = po; poll_sum += po }
      if (err != "") errc[err]++
      if (window > 0 && elapsed > 0) {
        # window = last REPORT_EVERY_SEC of elapsed wall time (approx by end_epoch)
        # Use relative: keep rows with te >= (max_te - window) after scan — second pass needed.
      }
      rows[hits] = $0
      te_list[hits] = te
    }
    END {
      # Determine window using max end epoch among included rows
      max_te = 0
      for (i = 1; i <= hits; i++) if (te_list[i] > max_te) max_te = te_list[i]
      win_start = max_te - window
      wh = wo = wf = 0
      for (i = 1; i <= hits; i++) {
        split(rows[i], f, "\t")
        if (f[1]+0 >= win_start) {
          wh++
          if (f[10] == "1") wo++; else wf++
        }
      }

      # sort ups / e2es for percentiles (insertion sort — fine for load-test sizes)
      n = hits
      for (i = 2; i <= n; i++) {
        v = ups[i]; j = i - 1
        while (j >= 1 && ups[j] > v) { ups[j+1] = ups[j]; j-- }
        ups[j+1] = v
      }
      for (i = 2; i <= n; i++) {
        v = e2es[i]; j = i - 1
        while (j >= 1 && e2es[j] > v) { e2es[j+1] = e2es[j]; j-- }
        e2es[j+1] = v
      }
      for (i = 2; i <= pn; i++) {
        v = polls[i]; j = i - 1
        while (j >= 1 && polls[j] > v) { polls[j+1] = polls[j]; j-- }
        polls[j+1] = v
      }

      sr = rate(oks, hits)
      fr = rate(fails, hits)
      rpm = elapsed > 0 ? (hits * 60.0)/elapsed : 0
      rps = elapsed > 0 ? hits / elapsed : 0

      printf "hits=%d ok=%d fail=%d success_rate=%.1f%% fail_rate=%.1f%% in_flight=%d rps=%.3f rpm=%.2f\n", \
        hits+0, oks+0, fails+0, sr, fr, inflight, rps, rpm
      printf "win(last_%ds): hits=%d ok=%d fail=%d\n", window, wh, wo, wf
      printf "lat_upload: avg=%.3fs p50=%.3fs p95=%.3fs\n", avg(up_sum,n), pct(ups,n,50), pct(ups,n,95)
      printf "lat_e2e:    avg=%.3fs p50=%.3fs p95=%.3fs\n", avg(e2e_sum,n), pct(e2es,n,50), pct(e2es,n,95)
      if (pn > 0)
        printf "lat_poll:   avg=%.3fs p50=%.3fs p95=%.3fs\n", avg(poll_sum,pn), pct(polls,pn,50), pct(polls,pn,95)
      printf "http:"
      for (c in http) printf " %s=%d", c, http[c]
      printf "\njob:"
      for (s in job) printf " %s=%d", s, job[s]
      printf "\n"
      # top errors
      ec = 0
      for (e in errc) {
        ec++
        en[ec] = e
        ev[ec] = errc[e]
      }
      if (ec > 0) {
        printf "errors:"
        # print up to 5 by count (simple)
        for (pass = 1; pass <= 5 && pass <= ec; pass++) {
          best = 0; bi = 0
          for (i = 1; i <= ec; i++) if (ev[i] > best) { best = ev[i]; bi = i }
          if (bi == 0) break
          printf " %s=%d", en[bi], ev[bi]
          ev[bi] = 0
        }
        printf "\n"
      }

      # machine-readable one-liner for intervals.tsv (printed to stderr marker via special prefix)
      printf "TSV\t%d\t%d\t%d\t%d\t%.2f\t%.2f\t%d\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f\n", \
        elapsed, hits+0, oks+0, fails+0, sr, fr, inflight, \
        avg(up_sum,n), pct(ups,n,50), pct(ups,n,95), \
        avg(e2e_sum,n), pct(e2es,n,50), pct(e2es,n,95)
    }
  ' "$tmp_all")

  local pretty tsv_line
  pretty=$(echo "$report" | grep -v '^TSV' || true)
  tsv_line=$(echo "$report" | grep '^TSV' | sed 's/^TSV\t//' || true)

  {
    echo
    if [[ "$milestone" == "1" ]]; then
      echo "======== MILESTONE $label ========"
    else
      echo "-------- REPORT $label --------"
    fi
    echo "$pretty"
  } | tee -a "$RUN_LOG"

  if [[ -n "$tsv_line" ]]; then
    echo -e "${label}\t${tsv_line}" >> "$INTERVALS"
  fi
}

is_milestone() {
  case "$1" in
    60|300|600|900|1800|3600) return 0 ;;
    *) return 1 ;;
  esac
}

export -f worker_loop write_row json_get http_indication elapsed_sec now_epoch
export BASE_URL TOKEN FILE LANGUAGE DIARIZE POLL POLL_INTERVAL POLL_MAX TIMEOUT
export OUT_DIR HAS_JQ STOP_FLAG END_EPOCH

: > "$RUN_LOG"
echo -e "label\telapsed_s\thits\tok\tfail\tsuccess_rate\tfail_rate\tin_flight\tupload_avg\tupload_p50\tupload_p95\te2e_avg\te2e_p50\te2e_p95" \
  > "$INTERVALS"

START_EPOCH=$(now_epoch)
START_EPOCH_INT=${START_EPOCH%.*}
END_EPOCH=$(awk -v s="$START_EPOCH" -v d="$DURATION_SEC" 'BEGIN { printf "%.3f", s + d }')
export END_EPOCH

HOST=$(hostname 2>/dev/null || echo unknown)

log_line "STT duration load test starting"
log_line "  BASE_URL=$BASE_URL"
log_line "  FILE=$FILE ($FILE_BYTES bytes)"
log_line "  LANGUAGE=$LANGUAGE DIARIZE=$DIARIZE POLL=$POLL"
log_line "  CONCURRENCY=$CONCURRENCY DURATION_SEC=$DURATION_SEC REPORT_EVERY_SEC=$REPORT_EVERY_SEC"
log_line "  host=$HOST"
log_line "  OUT_DIR=$OUT_DIR"
log_line "  ends_at_epoch=$END_EPOCH"
log_line "-----"

# Start workers
WORKER_PIDS=()
for w in $(seq 1 "$CONCURRENCY"); do
  worker_loop "$w" &
  WORKER_PIDS+=("$!")
done

# Reporter loop
next_report=$REPORT_EVERY_SEC
while true; do
  now=$(now_epoch)
  elapsed=$(awk -v s="$START_EPOCH" -v n="$now" 'BEGIN { printf "%d", n - s }')

  if [[ "$elapsed" -ge "$DURATION_SEC" ]]; then
    break
  fi

  # Sleep until next report or end
  sleep_for=$(( next_report - elapsed ))
  [[ "$sleep_for" -lt 1 ]] && sleep_for=1
  remaining=$(( DURATION_SEC - elapsed ))
  [[ "$sleep_for" -gt "$remaining" ]] && sleep_for=$remaining
  sleep "$sleep_for"

  now=$(now_epoch)
  elapsed=$(awk -v s="$START_EPOCH" -v n="$now" 'BEGIN { printf "%d", n - s }')
  [[ "$elapsed" -gt "$DURATION_SEC" ]] && elapsed=$DURATION_SEC

  # Emit reports for each crossed tick
  while [[ "$next_report" -le "$elapsed" && "$next_report" -le "$DURATION_SEC" ]]; do
    label="t=$(fmt_mmss "$next_report")"
    ms=0
    is_milestone "$next_report" && ms=1
    cutoff=$(awk -v s="$START_EPOCH" -v e="$next_report" 'BEGIN { printf "%.3f", s + e }')
    emit_report "$next_report" "$label" "$cutoff" "$ms"
    next_report=$(( next_report + REPORT_EVERY_SEC ))
  done

  if [[ "$elapsed" -ge "$DURATION_SEC" ]]; then
    break
  fi
done

# Stop new work; wait for in-flight to finish (with grace)
log_line "Duration reached — stopping new uploads (waiting for in-flight)..."
touch "$STOP_FLAG"

GRACE_SEC=$(( POLL_MAX * POLL_INTERVAL + TIMEOUT + 60 ))
grace_deadline=$(( $(date +%s) + GRACE_SEC ))
while true; do
  inflight=$(find "$OUT_DIR/inflight" -type f 2>/dev/null | wc -l | tr -d ' ')
  alive=0
  for p in "${WORKER_PIDS[@]}"; do
    kill -0 "$p" 2>/dev/null && alive=1 && break
  done
  [[ "$inflight" == "0" && "$alive" == "0" ]] && break
  if [[ "$(date +%s)" -ge "$grace_deadline" ]]; then
    log_line "Grace period expired — killing remaining workers (inflight=$inflight)"
    for p in "${WORKER_PIDS[@]}"; do
      kill "$p" 2>/dev/null || true
    done
    break
  fi
  sleep 2
done
wait 2>/dev/null || true

# Final report
FINAL_ELAPSED=$DURATION_SEC
emit_report "$FINAL_ELAPSED" "FINAL" "" 1

# Merge results
{
  echo -e "end_epoch\tworker\tseq\thttp_code\tupload_sec\tpoll_sec\te2e_sec\tuuid\tstatus\tok\terr_code"
  cat "$OUT_DIR/rows"/*.tsv 2>/dev/null || true
} > "$RESULTS"

# Summary
{
  echo "======== STT DURATION LOAD TEST SUMMARY ========"
  echo "started=$(date -d "@$START_EPOCH_INT" -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$START_EPOCH_INT" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo "$START_EPOCH_INT")"
  echo "duration_sec=$DURATION_SEC"
  echo "concurrency=$CONCURRENCY"
  echo "report_every_sec=$REPORT_EVERY_SEC"
  echo "base_url=$BASE_URL"
  echo "file=$FILE ($FILE_BYTES bytes)"
  echo "language=$LANGUAGE diarize=$DIARIZE poll=$POLL"
  echo "host=$HOST"
  echo
  echo "---- Interval table (see also intervals.tsv) ----"
  if [[ -f "$INTERVALS" ]]; then
    column -t -s $'\t' "$INTERVALS" 2>/dev/null || cat "$INTERVALS"
  fi
  echo
  echo "---- Legend ----"
  echo "  hits          = upload attempts finished"
  echo "  ok            = success (completed if POLL=1, else HTTP 200/202 + uuid)"
  echo "  fail          = non-success"
  echo "  in_flight     = uploads started but not finished at report time"
  echo "  win           = counts in last REPORT_EVERY_SEC window"
  echo "  202           = Accepted job"
  echo "  429           = Rate limited / too_many_jobs"
  echo "  601           = Invalid/expired token"
  echo "  503           = ASR unavailable"
  echo
  echo "results=$RESULTS"
  echo "intervals=$INTERVALS"
  echo "run_log=$RUN_LOG"
  echo "==============================================="
} | tee "$SUMMARY" | tee -a "$RUN_LOG"

log_line "Done. Summary: $SUMMARY"
echo "Intervals: $INTERVALS"
echo "Results:   $RESULTS"

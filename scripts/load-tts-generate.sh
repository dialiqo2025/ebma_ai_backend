#!/usr/bin/env bash
# Load-test TTS: create generation + synthesize (generate or stream).
#
# Usage (Git Bash / WSL / Linux / macOS):
#   chmod +x scripts/load-tts-generate.sh
#   TOKEN="Bearer eyJ..." ./scripts/load-tts-generate.sh
#
# Env:
#   BASE_URL      default http://localhost:5002
#   TOKEN         required — "Bearer <jwt>" or API key as sent by the client
#   TEXT          default short sample sentence (max 1500 chars)
#   LANGUAGE      default auto
#   VOICE_MODE    default default  (default | clone)
#   VOICE_ID      optional saved voice UUID (clone mode)
#   VOICE_SAMPLE  optional path to reference audio (clone mode)
#   SAMPLE_TRANSCRIPT  optional transcript for clone sample
#   SPEED         default 1
#   PITCH         default 1
#   OUTPUT_FORMAT default wav  (wav | mp3 | ogg)
#   MODE          default generate
#                   generate — POST /generations then POST …/generate
#                   stream   — POST /generations then POST …/stream (PCM body)
#                   create   — POST /generations only (no synthesis)
#   CONCURRENCY   default 5
#   TOTAL         default 20
#   POLL          default 1 — poll GET until completed/failed when status is processing
#   POLL_INTERVAL default 2 (seconds)
#   POLL_MAX      default 60
#   TIMEOUT       default 180 (curl max-time for generate/stream, seconds)
#   DOWNLOAD      default 0 — set 1 to GET …/audio after completed (generate mode)
#   OUT_DIR       default ./scripts/.tts-load-results/<timestamp>

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5002}"
TOKEN="${TOKEN:?Set TOKEN, e.g. TOKEN='Bearer eyJ...' }"
TEXT="${TEXT:-Hello, this is an EBMA text to speech load test.}"
LANGUAGE="${LANGUAGE:-auto}"
VOICE_MODE="${VOICE_MODE:-default}"
VOICE_ID="${VOICE_ID:-}"
VOICE_SAMPLE="${VOICE_SAMPLE:-}"
SAMPLE_TRANSCRIPT="${SAMPLE_TRANSCRIPT:-}"
SPEED="${SPEED:-1}"
PITCH="${PITCH:-1}"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-wav}"
MODE="${MODE:-generate}"
CONCURRENCY="${CONCURRENCY:-5}"
TOTAL="${TOTAL:-20}"
POLL="${POLL:-1}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
POLL_MAX="${POLL_MAX:-60}"
TIMEOUT="${TIMEOUT:-180}"
DOWNLOAD="${DOWNLOAD:-0}"
OUT_DIR="${OUT_DIR:-./scripts/.tts-load-results/$(date +%Y%m%d-%H%M%S)}"

case "$MODE" in
  generate|stream|create) ;;
  *)
    echo "ERROR: MODE must be generate, stream, or create (got: $MODE)" >&2
    exit 1
    ;;
esac

if [[ "$VOICE_MODE" == "clone" ]]; then
  if [[ -z "$VOICE_ID" && -z "$VOICE_SAMPLE" ]]; then
    echo "ERROR: clone mode needs VOICE_ID or VOICE_SAMPLE" >&2
    exit 1
  fi
  if [[ -n "$VOICE_SAMPLE" && ! -f "$VOICE_SAMPLE" ]]; then
    echo "ERROR: VOICE_SAMPLE not found: $VOICE_SAMPLE" >&2
    exit 1
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2
  exit 1
fi

HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=1
fi

mkdir -p "$OUT_DIR/meta" "$OUT_DIR/audio"
SUMMARY="$OUT_DIR/summary.txt"
RESULTS="$OUT_DIR/results.tsv"

echo "TTS generate load test"
echo "  BASE_URL=$BASE_URL"
echo "  MODE=$MODE LANGUAGE=$LANGUAGE VOICE_MODE=$VOICE_MODE"
echo "  TEXT_LEN=${#TEXT} OUTPUT_FORMAT=$OUTPUT_FORMAT"
echo "  TOTAL=$TOTAL CONCURRENCY=$CONCURRENCY POLL=$POLL DOWNLOAD=$DOWNLOAD"
echo "  OUT_DIR=$OUT_DIR"
echo

elapsed() {
  local start="$1" end
  end=$(date +%s.%N 2>/dev/null || date +%s)
  if command -v bc >/dev/null 2>&1; then
    echo "$end - $start" | bc
  else
    echo "$end"
  fi
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

create_generation() {
  local body_file="$1"
  local code

  if [[ "$VOICE_MODE" == "clone" && -n "$VOICE_SAMPLE" ]]; then
    local -a form=(
      -F "text=${TEXT}"
      -F "language=${LANGUAGE}"
      -F "voiceMode=clone"
      -F "speed=${SPEED}"
      -F "pitch=${PITCH}"
      -F "outputFormat=${OUTPUT_FORMAT}"
      -F "voiceSample=@${VOICE_SAMPLE}"
    )
    if [[ -n "$SAMPLE_TRANSCRIPT" ]]; then
      form+=(-F "sampleTranscript=${SAMPLE_TRANSCRIPT}")
    fi
    code=$(curl -sS -o "$body_file" -w "%{http_code}" \
      --max-time "$TIMEOUT" \
      -X POST "${BASE_URL}/api/v1/tts/generations" \
      -H "Authorization: ${TOKEN}" \
      "${form[@]}" \
      || echo "000")
  else
    local payload py=python3
    command -v python3 >/dev/null 2>&1 || py=python
    if [[ "$HAS_JQ" -eq 1 ]]; then
      payload=$(jq -n \
        --arg text "$TEXT" \
        --arg language "$LANGUAGE" \
        --arg voiceMode "$VOICE_MODE" \
        --arg voiceId "$VOICE_ID" \
        --argjson speed "$SPEED" \
        --argjson pitch "$PITCH" \
        --arg outputFormat "$OUTPUT_FORMAT" \
        '{
          text: $text,
          language: $language,
          voiceMode: $voiceMode,
          speed: $speed,
          pitch: $pitch,
          outputFormat: $outputFormat
        } + (if $voiceMode == "clone" and ($voiceId | length) > 0 then {voiceId: $voiceId} else {} end)')
    else
      payload=$(TEXT="$TEXT" LANGUAGE="$LANGUAGE" VOICE_MODE="$VOICE_MODE" VOICE_ID="$VOICE_ID" \
        SPEED="$SPEED" PITCH="$PITCH" OUTPUT_FORMAT="$OUTPUT_FORMAT" \
        "$py" - <<'PY'
import json, os
payload = {
  "text": os.environ["TEXT"],
  "language": os.environ["LANGUAGE"],
  "voiceMode": os.environ["VOICE_MODE"],
  "speed": float(os.environ["SPEED"]),
  "pitch": float(os.environ["PITCH"]),
  "outputFormat": os.environ["OUTPUT_FORMAT"],
}
if os.environ["VOICE_MODE"] == "clone" and os.environ.get("VOICE_ID"):
  payload["voiceId"] = os.environ["VOICE_ID"]
print(json.dumps(payload))
PY
)
    fi

    code=$(curl -sS -o "$body_file" -w "%{http_code}" \
      --max-time "$TIMEOUT" \
      -X POST "${BASE_URL}/api/v1/tts/generations" \
      -H "Authorization: ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      || echo "000")
  fi

  echo "$code"
}

poll_until_settled() {
  local uuid="$1"
  local status="${2:-queued}"
  local attempt=0
  local poll_body

  while [[ "$attempt" -lt "$POLL_MAX" ]]; do
    if [[ "$status" == "completed" || "$status" == "failed" ]]; then
      echo "$status"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    attempt=$((attempt + 1))
    poll_body=$(curl -sS --max-time 30 \
      -H "Authorization: ${TOKEN}" \
      "${BASE_URL}/api/v1/tts/generations/${uuid}" || echo "")
    status=$(json_get "$poll_body" ".data.data.status")
    status="${status:-unknown}"
  done
  echo "$status"
}

run_one() {
  local i="$1"
  local create_body="$OUT_DIR/req-${i}.create.json"
  local synth_body="$OUT_DIR/req-${i}.synth.json"
  local stream_file="$OUT_DIR/audio/req-${i}.pcm"
  local meta_file="$OUT_DIR/meta/req-${i}.meta"
  local start create_code create_sec uuid status synth_code synth_sec final_status ok audio_bytes

  start=$(date +%s.%N 2>/dev/null || date +%s)
  create_code=$(create_generation "$create_body")
  create_sec=$(elapsed "$start")

  uuid=$(json_get "$(cat "$create_body" 2>/dev/null || echo "")" ".data.data.generationUuid")
  status=$(json_get "$(cat "$create_body" 2>/dev/null || echo "")" ".data.data.status")
  status="${status:-}"
  synth_code=""
  synth_sec="0"
  final_status="$status"
  ok="0"
  audio_bytes="0"

  if [[ ! "$create_code" =~ ^(200|201|202)$ ]] || [[ -z "$uuid" ]]; then
    {
      echo "index=$i"
      echo "create_code=$create_code"
      echo "create_sec=$create_sec"
      echo "uuid="
      echo "synth_code="
      echo "synth_sec=0"
      echo "final_status="
      echo "audio_bytes=0"
      echo "ok=0"
    } > "$meta_file"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$i" "$create_code" "$create_sec" "" "" "0" "" "0" "0" \
      > "$OUT_DIR/meta/req-${i}.tsv"
    echo "[$i/$TOTAL] create_http=$create_code create=${create_sec}s FAIL"
    return 0
  fi

  if [[ "$MODE" == "create" ]]; then
    ok="1"
    final_status="${status:-queued}"
  elif [[ "$status" == "completed" ]]; then
    # TTS_AUTO_PROCESS=true already synthesized on create
    ok="1"
    final_status="completed"
  elif [[ "$MODE" == "generate" ]]; then
    local s0
    s0=$(date +%s.%N 2>/dev/null || date +%s)
    synth_code=$(curl -sS -o "$synth_body" -w "%{http_code}" \
      --max-time "$TIMEOUT" \
      -X POST "${BASE_URL}/api/v1/tts/generations/${uuid}/generate" \
      -H "Authorization: ${TOKEN}" \
      || echo "000")
    synth_sec=$(elapsed "$s0")
    final_status=$(json_get "$(cat "$synth_body" 2>/dev/null || echo "")" ".data.data.status")
    final_status="${final_status:-unknown}"

    if [[ "$POLL" == "1" && "$final_status" == "processing" ]]; then
      final_status=$(poll_until_settled "$uuid" "$final_status")
    fi

    if [[ "$synth_code" =~ ^(200|201|202)$ && "$final_status" == "completed" ]]; then
      ok="1"
    fi
  elif [[ "$MODE" == "stream" ]]; then
    local s0
    s0=$(date +%s.%N 2>/dev/null || date +%s)
    synth_code=$(curl -sS -o "$stream_file" -w "%{http_code}" \
      --max-time "$TIMEOUT" \
      -X POST "${BASE_URL}/api/v1/tts/generations/${uuid}/stream" \
      -H "Authorization: ${TOKEN}" \
      || echo "000")
    synth_sec=$(elapsed "$s0")
    if [[ -f "$stream_file" ]]; then
      audio_bytes=$(wc -c < "$stream_file" | tr -d ' ')
    fi

    if [[ "$POLL" == "1" ]]; then
      final_status=$(poll_until_settled "$uuid" "processing")
    else
      final_status=$(json_get "$(curl -sS --max-time 30 \
        -H "Authorization: ${TOKEN}" \
        "${BASE_URL}/api/v1/tts/generations/${uuid}" || echo "")" ".data.data.status")
      final_status="${final_status:-unknown}"
    fi

    if [[ "$synth_code" == "200" && "$audio_bytes" -gt 0 && "$final_status" == "completed" ]]; then
      ok="1"
    elif [[ "$synth_code" == "200" && "$audio_bytes" -gt 0 && "$POLL" != "1" ]]; then
      ok="1"
      final_status="${final_status:-streamed}"
    fi
  fi

  if [[ "$DOWNLOAD" == "1" && "$ok" == "1" && "$MODE" != "stream" ]]; then
    local audio_out="$OUT_DIR/audio/req-${i}.${OUTPUT_FORMAT}"
    local dl_code
    dl_code=$(curl -sS -o "$audio_out" -w "%{http_code}" \
      --max-time 60 \
      -H "Authorization: ${TOKEN}" \
      "${BASE_URL}/api/v1/tts/generations/${uuid}/audio" \
      || echo "000")
    if [[ "$dl_code" == "200" && -f "$audio_out" ]]; then
      audio_bytes=$(wc -c < "$audio_out" | tr -d ' ')
    fi
  fi

  {
    echo "index=$i"
    echo "create_code=$create_code"
    echo "create_sec=$create_sec"
    echo "uuid=$uuid"
    echo "synth_code=$synth_code"
    echo "synth_sec=$synth_sec"
    echo "final_status=$final_status"
    echo "audio_bytes=$audio_bytes"
    echo "ok=$ok"
  } > "$meta_file"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$i" "$create_code" "$create_sec" "$uuid" "${synth_code:-}" "$synth_sec" \
    "${final_status:-}" "$audio_bytes" "$ok" \
    > "$OUT_DIR/meta/req-${i}.tsv"

  echo "[$i/$TOTAL] create=$create_code/${create_sec}s synth=${synth_code:--}/${synth_sec}s uuid=${uuid:--} status=${final_status:--} ok=$ok"
}

export -f run_one create_generation poll_until_settled json_get elapsed
export BASE_URL TOKEN TEXT LANGUAGE VOICE_MODE VOICE_ID VOICE_SAMPLE SAMPLE_TRANSCRIPT
export SPEED PITCH OUTPUT_FORMAT MODE TOTAL POLL POLL_INTERVAL POLL_MAX TIMEOUT DOWNLOAD
export OUT_DIR HAS_JQ

WALL_START=$(date +%s)

if xargs --help 2>&1 | grep -q -- '-P'; then
  seq 1 "$TOTAL" | xargs -P "$CONCURRENCY" -I{} bash -c 'run_one "$@"' _ {}
else
  running=0
  for i in $(seq 1 "$TOTAL"); do
    run_one "$i" &
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
  echo -e "index\tcreate_code\tcreate_sec\tuuid\tsynth_code\tsynth_sec\tfinal_status\taudio_bytes\tok"
  for i in $(seq 1 "$TOTAL"); do
    [[ -f "$OUT_DIR/meta/req-${i}.tsv" ]] && cat "$OUT_DIR/meta/req-${i}.tsv"
  done
} > "$RESULTS"

OK_COUNT=$(awk -F'\t' 'NR>1 && $9=="1" {c++} END{print c+0}' "$RESULTS")
FAIL_COUNT=$((TOTAL - OK_COUNT))
CREATE_OK=$(awk -F'\t' 'NR>1 && ($2=="200" || $2=="201" || $2=="202") {c++} END{print c+0}' "$RESULTS")

{
  echo "wall_seconds=$WALL_SEC"
  echo "total=$TOTAL"
  echo "mode=$MODE"
  echo "create_accepted=$CREATE_OK"
  echo "ok=$OK_COUNT"
  echo "fail=$FAIL_COUNT"
  echo "concurrency=$CONCURRENCY"
  echo "language=$LANGUAGE"
  echo "voice_mode=$VOICE_MODE"
  echo "results=$RESULTS"
} | tee "$SUMMARY"

echo
echo "Done. Summary: $SUMMARY"
echo "Per-request TSV: $RESULTS"

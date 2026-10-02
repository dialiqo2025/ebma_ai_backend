# Testing API keys with curl

Every STT, TTS and LLM endpoint below can be called with an EBMA API key. Run the commands in **Git Bash**. In PowerShell, type `curl.exe`, because plain `curl` there is a different command.

## Setup

1. Apply the migration once: `npm run migrate` (in `ebma_ai_backend`).
2. Start the backend (`npm run dev`, port 5002) and the frontend.
3. Log in to the portal and open **API keys**. Create these two keys:
   - `test-all` with all three scopes
   - `tts-only` with only **Text to speech** ticked
4. Copy each key when it is shown. It is only shown once.

```bash
export BASE=http://localhost:5002/api/v1
export KEY=ebma_sk_...        # the test-all key
export TTSKEY=ebma_sk_...     # the tts-only key
export AUTH="Authorization: Bearer $KEY"
```

Use the UUIDs returned by one call in the calls that follow it (`GEN`, `TR`, `SES`).

---

## TTS (scope `tts`)

```bash
# Limits and availability
curl -s $BASE/tts/options -H "$AUTH"

# Create a generation request
curl -s -X POST $BASE/tts/generations -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is a test from my API key.","language":"en","voiceMode":"default","speed":1,"pitch":1,"outputFormat":"wav"}'
export GEN=<generation_uuid from response>

# Generate (or retry) the audio. Skip this if TTS_AUTO_PROCESS=true.
curl -s -X POST $BASE/tts/generations/$GEN/generate -H "$AUTH"

# Get one request / list history (filters: page, page_size<=100, status, language, search)
curl -s $BASE/tts/generations/$GEN -H "$AUTH"
curl -s "$BASE/tts/generations?page=1&page_size=10&status=completed" -H "$AUTH"

# Download the audio
curl -s -o tts.wav $BASE/tts/generations/$GEN/audio -H "$AUTH"

# Edit a queued or failed request
curl -s -X PATCH $BASE/tts/generations/$GEN -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text":"Edited text","speed":1.2}'

# Delete a request and its audio
curl -s -X DELETE $BASE/tts/generations/$GEN -H "$AUTH"
```

Cloned voice: send `"voiceMode":"clone","voiceId":"<voice id>"`.

---

## STT (scope `stt`)

### File transcription

```bash
# Limits / GPU backend health
curl -s $BASE/stt/options -H "$AUTH"
curl -s $BASE/stt/health  -H "$AUTH"

# Upload a file (multipart field "file"); diarize and speakers are optional
curl -s -X POST $BASE/stt/transcriptions -H "$AUTH" \
  -F "file=@../EBMA ASR docs/docs/sample_hi.wav" -F "language=hi" -F "diarize=false"
export TR=<transcription_uuid from response>

# Status / list (filters: page, page_size, status, language, search)
curl -s $BASE/stt/transcriptions/$TR -H "$AUTH"
curl -s "$BASE/stt/transcriptions?page=1&page_size=10" -H "$AUTH"

# Download the result as txt, srt or vtt
curl -s -o transcript.srt "$BASE/stt/transcriptions/$TR/download?format=srt" -H "$AUTH"

# Delete
curl -s -X DELETE $BASE/stt/transcriptions/$TR -H "$AUTH"
```

Compare the output of `sample_hi.wav` with `EBMA ASR docs/docs/sample_hi.txt`.

### Live sessions

The audio itself streams over a WebSocket straight to the GPU host, so curl can't send it. These calls test the session lifecycle that runs before and after the stream.

```bash
# Create a session (language, mode native|mixed|romanized, sampleRate, endSilenceMs, partials)
curl -s -X POST $BASE/stt/sessions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"language":"hi","mode":"native","sampleRate":16000,"endSilenceMs":700,"partials":true}'
export SES=<session_uuid from response>

# Get / list / update
curl -s $BASE/stt/sessions/$SES -H "$AUTH"
curl -s "$BASE/stt/sessions?page=1&page_size=10" -H "$AUTH"
curl -s -X PATCH $BASE/stt/sessions/$SES -H "$AUTH" -H "Content-Type: application/json" -d '{"mode":"mixed"}'

# Short-lived streaming token for the GPU WebSocket (rate-limited; ttlSeconds 10-900)
curl -s -X POST $BASE/stt/sessions/$SES/token -H "$AUTH" -H "Content-Type: application/json" -d '{"ttlSeconds":300}'

# Mark streaming started, save a final segment, finish
curl -s -X POST $BASE/stt/sessions/$SES/start -H "$AUTH"
curl -s -X POST $BASE/stt/sessions/$SES/segments -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"final","seg":1,"text":"namaste aap kaise hain","lang":"hi","t0":0,"t1":2.5,"audio_s":2.5,"decode_ms":120,"latency_ms":300,"reason":"pause"}'
curl -s -X POST $BASE/stt/sessions/$SES/finish -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"completed"}'

# Delete
curl -s -X DELETE $BASE/stt/sessions/$SES -H "$AUTH"
```

---

## LLM / Chat (scope `llm`)

The user's own LLM configuration (Settings → LLM) or a platform model must be set up first.

```bash
# Chat options (languages, limits)
curl -s $BASE/chat/options -H "$AUTH"

# Send a message (language and replyLanguage default to "auto"; history is optional, max 20 items)
curl -s -X POST $BASE/chat/messages -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"message":"What is the capital of India? Answer in Hindi.","language":"en","replyLanguage":"hi","source":"text","history":[]}'

# Speak an assistant reply (same body as a TTS request; returns audio bytes)
curl -s -o reply.wav -X POST $BASE/chat/speech -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text":"Hello! How can I help you today?","language":"en","outputFormat":"wav"}'

# Process a transcript with the LLM (style and systemPrompt are optional)
curl -s -X POST $BASE/llm/process -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text":"um so basically i want to uh book a ticket to delhi tomorrow","language":"en","style":"natural"}'
```

---

## Checks that must fail

| Call | Expected |
|---|---|
| `curl -s $BASE/billing/summary -H "$AUTH"` | 403 `API keys cannot access this route` |
| `curl -s $BASE/api-keys -H "$AUTH"` | 403, so a key can't create other keys |
| `curl -s $BASE/llm/config -H "$AUTH"` | 403 |
| `curl -s $BASE/billing/admin/plans -H "Authorization: Bearer <superAdmin key>"` | 403 |
| `curl -s $BASE/stt/options -H "Authorization: Bearer $TTSKEY"` | 403 `does not have the stt scope` |
| `curl -s $BASE/chat/options -H "Authorization: Bearer $TTSKEY"` | 403 `does not have the llm scope` |
| `curl -s $BASE/tts/options -H "Authorization: Bearer $TTSKEY"` | 200 |
| `curl -s $BASE/tts/options -H "Authorization: Bearer ebma_sk_wrong"` | 401 `API key is invalid or revoked` |
| Revoke `test-all` in the portal, then repeat any call with `$KEY` | 401 `API key is invalid or revoked` |
| Disable the user in Admin → Users, then call with `$TTSKEY` | 403 `Your account is not active` |

Expiry test: run `UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE name = 'tts-only';`. After that, calls with `$TTSKEY` return 401 `API key has expired`, and the portal shows the key as **Expired**.

## What to confirm afterwards

- **Last used** on the key updates. Refresh the API keys page to see it.
- TTS generations and transcriptions made with the key appear in the user's history in the portal.
- Each charge appears on the **Usage** page and in `billing_usage_ledger` for that user, and the wallet balance drops.
- `SELECT name, key_prefix, length(key_hash), scopes, last_used_at, revoked_at FROM api_keys;` returns a 64-character `key_hash` for each key. The raw key is never stored.

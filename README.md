# ebma_ai_backend

Express and PostgreSQL management API for the EBMA AI web application.

## TTS API

All TTS routes require the JWT access token returned by the auth flow:

```text
Authorization: Bearer <access-token>
```

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/tts/options` | Frontend limits and runtime availability |
| `POST` | `/api/v1/tts/generations` | Create a generation request |
| `GET` | `/api/v1/tts/generations` | List the signed-in user's history |
| `GET` | `/api/v1/tts/generations/:generation_uuid` | Get one request |
| `PATCH` | `/api/v1/tts/generations/:generation_uuid` | Edit a queued or failed request |
| `DELETE` | `/api/v1/tts/generations/:generation_uuid` | Delete a request and its audio |
| `POST` | `/api/v1/tts/generations/:generation_uuid/generate` | Generate or retry audio (buffered) |
| `POST` | `/api/v1/tts/generations/:generation_uuid/stream` | Stream PCM while synthesizing (play as it arrives) |
| `GET` | `/api/v1/tts/generations/:generation_uuid/audio` | Stream generated audio securely |

Create payload:

```json
{
  "text": "नमस्ते, आप कैसे हैं?",
  "language": "hi",
  "voiceMode": "default",
  "speed": 1,
  "pitch": 1,
  "outputFormat": "wav"
}
```

For cloned voices, send `"voiceMode": "clone"` and a non-empty `voiceId`.
Text is limited to 1,500 characters; speed and pitch accept values from 0.5 to 1.5.

List query parameters are `page`, `page_size` (maximum 100), `status`, `language`, and
`search`.

## TTS model adapter

EBMA TTS is served on the same GPU host under a different path than ASR:

```text
POST https://<host>/tts/v1/audio/speech
Authorization: Bearer <API key>
Content-Type: application/json
```

Set `TTS_MODEL_ENDPOINT` to that full URL (not `/tts` or `/tts/?key=`).

The adapter in `src/services/tts/tts.model.ts` sends:

```json
{
  "input": "...",
  "stream": false,
  "temperature": 0.8,
  "top_k": 50,
  "language": "en",
  "voice_mode": "default",
  "speed": 1,
  "pitch": 1,
  "output_format": "wav"
}
```

With `stream: false` the model returns a complete `audio/wav` body, which is stored under
`TTS_AUDIO_DIRECTORY`.

For live playback, call `POST /tts/generations/:uuid/stream`. The management API sets
`stream: true` on the GPU, pipes raw `audio/pcm` (s16le) to the client with headers
`X-Audio-Sample-Rate` / `X-Audio-Channels`, and still saves a WAV for history after the
stream ends. Configure `TTS_STREAM_SAMPLE_RATE` (default 24000) if pitch sounds wrong.

ASR docs under `docs/ebma-asr/` cover speech-to-text only (`/health`, `/v1/tokens`, `/ws`).

Keep `TTS_AUTO_PROCESS=false` while iterating; call the generate endpoint explicitly, or set
it to `true` to process during creation.

## STT API

The STT integration follows the EBMA ASR documentation: this API keeps the long-lived API
key private and mints a short-lived browser token. The browser then sends microphone audio
directly to the GPU WebSocket. Raw audio does not pass through or get stored by this server.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/stt/options` | Languages, modes, limits, and audio requirements |
| `GET` | `/api/v1/stt/health` | Authenticated GPU health and load check |
| `POST` | `/api/v1/stt/sessions` | Create a transcription session |
| `GET` | `/api/v1/stt/sessions` | List the signed-in user's transcription history |
| `GET` | `/api/v1/stt/sessions/:session_uuid` | Get a session and its final segments |
| `PATCH` | `/api/v1/stt/sessions/:session_uuid` | Edit a created or failed session |
| `DELETE` | `/api/v1/stt/sessions/:session_uuid` | Delete a session and its segments |
| `POST` | `/api/v1/stt/sessions/:session_uuid/token` | Mint a short-lived WebSocket token |
| `POST` | `/api/v1/stt/sessions/:session_uuid/start` | Mark the session streaming after `ready` |
| `POST` | `/api/v1/stt/sessions/:session_uuid/segments` | Save an idempotent WebSocket `final` event |
| `POST` | `/api/v1/stt/sessions/:session_uuid/finish` | Mark the session completed or failed |
| `POST` | `/api/v1/stt/transcriptions` | Upload a recording (multipart `file`) and start a job |
| `GET` | `/api/v1/stt/transcriptions` | List file transcription jobs |
| `GET` | `/api/v1/stt/transcriptions/:transcription_uuid` | Poll job status / read transcript |
| `GET` | `/api/v1/stt/transcriptions/:transcription_uuid/download` | Download `txt` / `srt` / `vtt` |
| `DELETE` | `/api/v1/stt/transcriptions/:transcription_uuid` | Cancel or delete a job |

Create a session:

```json
{
  "language": "hi",
  "mode": "native",
  "sampleRate": 48000,
  "endSilenceMs": 700,
  "partials": true
}
```

The create and token responses include the exact WebSocket `startMessage`. After receiving
the token, connect to `connection.wsUrl + "?token=" + connection.token`, send the supplied
`startMessage` as soon as the socket opens, wait for `ready`, then send 16-bit signed
little-endian mono PCM frames. (The GPU replies with `ready` only after it receives `start`.)

When a `final` event arrives, send the event unchanged to the segments endpoint:

```json
{
  "type": "final",
  "seg": 1,
  "text": "भूमि अधिग्रहण",
  "lang": "hi",
  "t0": 1.09,
  "t1": 2.4,
  "audio_s": 1.31,
  "decode_ms": 620,
  "latency_ms": 1330,
  "reason": "pause"
}
```

Segment writes are idempotent on session plus `seg`, so retrying the same event does not
duplicate transcript text. Partial events are intentionally not persisted because the model
may revise them.

The model supports `native`, `mixed`, and `romanized` output. The current frontend option
called “English translation” is not supported by the supplied ASR contract and must not be
sent as a mode.

## STT file transcription (upload → transcript)

Besides live WebSocket STT, this API proxies EBMA long-form file jobs. The GPU API key stays
on the server. The browser uploads to this management API only.

```text
POST multipart file  ->  202 transcription  ->  poll GET until completed  ->  read text / download
```

Upload (`multipart/form-data`):

- field `file` (required): audio or video
- fields/query: `language` (default `hi`), `diarize` (`true`/`1`), `speakers` (1–20, optional)

This server forwards the raw bytes to `POST {EBMA_ASR_BACKEND_URL}/v1/transcriptions` and
stores ownership + cached results in `stt_transcriptions`. Poll
`GET /api/v1/stt/transcriptions/:id` every ~1.5s while `status` is `queued` or `processing`.
When `completed`, `transcript` and `result` (segments/speakers) are available. Download with
`?format=txt|srt|vtt`.

## Billing (Stripe + Razorpay)

Checkout supports two payment providers. Omit `provider` (or send `"stripe"`) for the
existing Stripe Checkout flow. Send `"razorpay"` to create a Razorpay Payment Link instead.

| Env | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe Checkout + webhook |
| `STRIPE_CURRENCY` | Stripe amount currency (default `INR`) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Payment Links |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC for `POST /api/v1/billing/webhook/razorpay` |
| `RAZORPAY_CURRENCY` | Razorpay amount currency (default `INR`) |
| `FRONTEND_URL` | Success / cancel redirect base for both providers |

Webhooks (raw body, mounted separately so signatures never collide):

- `POST /api/v1/billing/webhook/stripe`
- `POST /api/v1/billing/webhook/razorpay`

Razorpay v1 is one-time Payment Links only (wallet top-up and plan purchase). Monthly or
yearly plans paid via Razorpay activate a local service subscription without Razorpay
auto-renew; true auto-renew remains on Stripe.

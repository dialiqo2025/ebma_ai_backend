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
| `POST` | `/api/v1/tts/generations/:generation_uuid/generate` | Generate or retry audio |
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

The supplied project documentation currently specifies only the EBMA ASR/STT service; it
does not define a TTS GPU endpoint. The management API therefore isolates the model call in
`src/services/tts/tts.model.ts` and uses the full URL from `TTS_MODEL_ENDPOINT`.

The adapter sends this server-to-server JSON payload:

```json
{
  "text": "...",
  "language": "hi",
  "voice_mode": "default",
  "speed": 1,
  "pitch": 1,
  "output_format": "wav"
}
```

It accepts either an `audio/*` response or JSON containing base64 audio in
`audio_base64`, `audioBase64`, `audio`, or the first item of `audios`. Update this one adapter
when the EBMA TTS model contract is supplied.

Keep `TTS_AUTO_PROCESS=false` while the GPU is offline. Creation then returns `202` with a
queued record. Set it to `true` to process during creation, or call the generate endpoint
explicitly. Generated audio is private and stored under `TTS_AUDIO_DIRECTORY`; use persistent
storage in production.

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
the token, connect to `connection.wsUrl + "?token=" + connection.token`, wait for `ready`,
send the supplied `startMessage`, and then send 16-bit signed little-endian mono PCM frames.

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

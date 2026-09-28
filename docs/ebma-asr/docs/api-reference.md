# EBMA ASR: API reference

Version 1. The backend does live speech-to-text for 27 Indian languages. This page describes every endpoint, message and
error. New to the API? Read the [integration guide](integration-guide.md) first; it walks through a working setup.

**Rules that keep your integration working as the API grows**

- Ignore fields and event types you do not recognise. We add fields; we do not change the meaning of existing ones.
- Breaking changes go to a new path (`/v2/...`). Version 1 stays as it is.

---

## 1. Overview

| Endpoint | Who calls it | Purpose |
|---|---|---|
| `POST /v1/tokens` | **Your server** (never a browser) | Trade your API key for a short-lived token |
| `WS  /ws` | A browser (with a token) or your server (with the API key) | The streaming API: send audio, get text |
| `GET /health` | Anyone; monitors | Is the backend up? Load figures if you send your API key |

There is no REST call that transcribes a file. Audio goes over the WebSocket, in real time or faster.

### Credentials

| Credential | Looks like | Lives in | Lifetime | Use it for |
|---|---|---|---|---|
| **API key** | a random string of 32 characters | Your server only | Until revoked | Calling `POST /v1/tokens`; server-side streaming |
| **Token** | `ebma1.eyJ...` | Sent to one browser session | 5 minutes by default, 15 at most | Opening `/ws` from a browser |

Never put an API key in JavaScript, HTML, a mobile app, or a git repository. Browsers only ever see tokens. If a token
leaks, it stops working when it expires; if an API key leaks, ask the operator to revoke it.

A token is only checked **when the connection opens**. A session that is already running is not cut off when its token
expires.

---

## 2. `POST /v1/tokens`

Called by your server. Returns a token for one browser session.

```http
POST /v1/tokens
Authorization: Bearer <API key>
Content-Type: application/json

{ "subject": "user-42", "ttl_seconds": 300, "lang": "hi" }
```

All body fields are optional (you may send no body at all).

| Field | Type | Meaning |
|---|---|---|
| `subject` | string, 1-64 characters from `A-Z a-z 0-9 _ . : @ -` | Your own id for the end user. It is logged next to usage, and limits each user to 2 simultaneous sessions. Use a stable id, never an email or phone number. |
| `ttl_seconds` | integer | How long the token can open connections. Clamped to 10-900. Default 300. |
| `lang` | one of the [language codes](#8-languages-and-output-modes) | Locks the token to that language. The browser cannot pick another. |

**200 response**

```json
{
  "token": "ebma1.eyJraWQiOiJ1aS1kZXYiLC...",
  "expires_in": 300,
  "expires_at": 1790000000,
  "ws_url": "wss://<backend host>/ws"
}
```

Pass `token` and `ws_url` to the browser; it connects to `ws_url + "?token=" + token`. Use the `ws_url` you are given: it is
the address the operator has configured for browsers.

**Errors** (JSON body `{"error": {"code": "...", "message": "..."}}`)

| HTTP | `code` | Cause |
|---|---|---|
| 401 | `unauthorized` | Missing or wrong API key. The response has `WWW-Authenticate: Bearer`. |
| 400 | `bad_request` | Body is not a JSON object, or a field is invalid (message says which). |
| 503 | `no_api_keys` | The backend has no keys configured. Tell the operator. |

This endpoint deliberately sends no CORS headers, so a browser cannot call it. That is a safety feature: if it worked
from a browser, the API key would have to be in the browser.

---

## 3. `WS /ws`: streaming

### Connecting

```
wss://<backend host>/ws?token=<token>                       # a browser
wss://<backend host>/ws       + header  Authorization: Bearer <API key>     # a server
```

Browsers cannot set headers on a WebSocket, which is why they use `?token=`. Servers may use the API key directly.
(`?key=<API key>` also works but puts the key in URLs and logs; prefer the header.)

Connection checks, in this order. A refusal is one `error` message followed by the server closing the connection:

| # | Check | Error `code` | Close code |
|---|---|---|---|
| 1 | Token or API key is valid and not expired | `unauthorized` | 4401 |
| 2 | If the request comes from a browser: its `Origin` is on the allowed list | `origin_not_allowed` | 4403 |
| 3 | Fewer than the maximum number of sessions are running | `busy` | 1013 |
| 4 | This `subject` has fewer than 2 sessions running | `too_many_sessions` | 4429 |

Requests with no `Origin` header (servers, scripts) skip check 2. Browsers always send it and cannot fake it.

### One stream per connection

1. Open the connection.
2. Send a `start` message. Wait for `ready`.
3. Send audio; receive `partial` and `final` events.
4. Send `stop`. Wait for `stopped`. Close the connection.

To transcribe again, open a new connection. A second `start` on the same connection is ignored.

### Messages you send

**`start`** (once, first)

```json
{ "type": "start", "sample_rate": 48000, "lang": "hi", "mode": "native", "end_silence_ms": 700, "partials": true }
```

| Field | Default | Meaning |
|---|---|---|
| `sample_rate` | 16000 | Sample rate of the audio you will send, 8000-96000 Hz. The server resamples; send what your source gives you. |
| `lang` | `"hi"` | A language code, or `"auto"` (see [section 8](#8-languages-and-output-modes)) |
| `mode` | `"native"` | `native`, `mixed` or `romanized` |
| `end_silence_ms` | 700 | A pause this long ends a phrase and triggers the final text. 250-3000. |
| `partials` | `true` | Send live previews while a phrase is being spoken |

**Audio** (many, after `ready`): binary WebSocket frames.

- 16-bit signed integers, little-endian, **mono**, at the `sample_rate` you declared.
- An even number of bytes per frame (whole samples). A frame with an odd byte count is ignored and you get one
  `bad_request` error: it would shift every later sample by a byte and turn the audio to noise.
- 20-100 ms per frame is ideal (50 ms at 48 kHz is 4800 bytes). Send them at the pace of real time. Sending faster works, but
  live previews then arrive in bursts.
- Frames sent before `start` are dropped.

**`config`** (any time after `ready`): change settings mid-stream. Any of `lang`, `mode`, `end_silence_ms`, `partials`.
Applies from the next phrase.

**`stop`**: no more audio. The server finishes the phrase in progress, sends its `final`, then sends `stopped`.

### Messages you receive

**`ready`**: the server accepted `start`. Send audio from now on.

```json
{ "type": "ready", "sample_rate": 48000 }
```

**`vad`**: the voice detector heard speech start or stop. Handy for a "listening" indicator.

```json
{ "type": "vad", "speaking": true, "seg": 3 }
```

**`partial`**: a live preview of the phrase being spoken. It is re-decoded about once a second and **can change**, including
words already shown. Replace the previous preview with each new one.

```json
{ "type": "partial", "seg": 3, "text": "भूमि अधिग्रहण", "lang": "hi", "t0": 1.09, "t1": 2.4 }
```

**`final`**: the finished phrase. It does not change afterwards. Append it to your transcript and clear the preview.

```json
{
  "type": "final", "seg": 3, "text": "भूमि अधिग्रहण कानून जस्टिस अरुण मिश्रा की अध्यक्षता वाली संविधान पीठ ही करेगी सुनवाई",
  "lang": "hi", "t0": 1.09, "t1": 9.95, "audio_s": 8.86, "decode_ms": 620, "latency_ms": 1330, "reason": "pause"
}
```

| Field | Meaning |
|---|---|
| `seg` | Phrase number, counting up from 1. A `partial` and its `final` share it. |
| `text` | The transcript. May be empty only if nothing was recognised; empty phrases are not sent. |
| `lang` | The language used. With `"auto"`, the detected one. |
| `t0`, `t1` | Start and end of the phrase, in seconds of audio since the stream began (not wall-clock). |
| `audio_s` | Length of the phrase's audio. |
| `decode_ms` | GPU time spent on this phrase. |
| `latency_ms` | From the moment the speaker stopped to the moment the text was ready on the server. It includes the `end_silence_ms` pause. Your users also feel the network round trip on top. |
| `reason` | Why the phrase ended: `pause` (normal), `max_len` (someone spoke for 25 s without a pause; the phrase was split), `flush` (you sent `stop`). |

**`stopped`**: everything is done; close the connection.

**`error`**: something went wrong.

```json
{ "type": "error", "code": "bad_request", "message": "unknown lang 'xx'" }
```

Errors that do not close the connection (for example `bad_request`) leave the session running. See
[section 7](#7-errors-and-close-codes).

### Timing you can expect

| What | Typical |
|---|---|
| Connection set-up until `ready` | 1-2.5 s over a long-distance link (TLS + WebSocket + server start-up) |
| First `partial` after you start speaking | 1-2 s |
| `partial` cadence while speaking | about once a second |
| `final` after you stop speaking | 1.2-1.7 s server-side (pause 0.7 s + 0.4-0.9 s decode) plus network |

Start capturing audio immediately and buffer it until `ready` arrives, so the first words are not lost. The
[browser client](../examples/browser/ebma-asr.js) does this for you.

### Limits

| Limit | Value | What happens |
|---|---|---|
| Simultaneous sessions, whole backend | 4 (operator can raise it) | New connections get `busy` (close 1013). Retry after a few seconds. |
| Simultaneous sessions per `subject` | 2 | `too_many_sessions` (close 4429) |
| Length of one session | 20 minutes | `session_limit` error, the phrase in progress is finished, then `stopped`. Open a new connection to continue. |
| Silence on the connection | 60 s with no message at all | Same as above. Audio frames count as messages, so a live stream never triggers it. |
| Phrase length | 25 s of continuous speech | The phrase is split at the quietest point (`reason: "max_len"`) |

---

## 4. `GET /health`

```http
GET /health
```

| Caller | Response |
|---|---|
| Anyone | `{"status": "ok"}` |
| With `Authorization: Bearer <API key>` | adds `active_sessions`, `max_sessions`, `queue_depth`, `languages`, `modes` |

A browser on an allowed origin may call it (CORS is enabled for that one route), which is enough for a "service status"
light in your UI.

---

## 5. Audio: what works best

- **Mono**, speech, 16-bit. Stereo must be downmixed by you.
- Any sample rate from 8 kHz (telephony) to 96 kHz. 16 kHz and 48 kHz are the common ones. The server does the resampling.
- One speaker at a time. Overlapping speech, far-field microphones and loud background noise lower accuracy.
- Browser microphones: keep echo cancellation and noise suppression on (the browser client does).
- To convert a file: `ffmpeg -i input.mp3 -ac 1 -ar 16000 -c:a pcm_s16le output.wav`, then send the samples (skip the 44-byte WAV
  header). The [Python client](../examples/python/asr_client.py) shows how.

---

## 6. Copy-paste checks

```bash
# Is it up?
curl -s https://<backend host>/health
# {"status":"ok"}

# Does my API key work? (returns load figures)
curl -s https://<backend host>/health -H "Authorization: Bearer $EBMA_API_KEY"

# Get a token (from your server, never a browser)
curl -s -X POST https://<backend host>/v1/tokens \
  -H "Authorization: Bearer $EBMA_API_KEY" -H "Content-Type: application/json" \
  -d '{"subject":"test-user","ttl_seconds":60}'
```

The [connectivity doctor](../examples/check_backend.py) runs all of this, plus a real transcription, and explains failures.

---

## 7. Errors and close codes

WebSocket `error` messages carry a machine-readable `code`. Branch on the code, show the `message` to people.

| `code` | Close code | Meaning | What to do |
|---|---|---|---|
| `unauthorized` | 4401 | Token or key missing, wrong, tampered with, or expired | Get a fresh token and retry once. If it still fails, check `ws_url` and your server's clock. |
| `origin_not_allowed` | 4403 | The browser's website is not on the allowed list | Ask the operator to add your UI's origin (scheme + host + port). Not retryable. |
| `busy` | 1013 | All GPU session slots are in use | Retry with a short back-off (2-5 s), and tell the user if it lasts. |
| `too_many_sessions` | 4429 | This `subject` already has 2 sessions | Stop the old ones (a leftover tab?) or wait. |
| `session_limit` | 1000 (`stopped` comes first) | 20-minute limit, or 60 s of silence | Open a new connection to continue. |
| `bad_request` | none | A message was malformed or a value is not allowed (unknown `lang`, `sample_rate` out of range, language locked by the token, an audio frame with an odd byte count) | Fix the request. The session stays open. |
| `internal` | 1000 | Unexpected server error. The message is always "Unexpected server error."; the detail is in the server log | Retry once; report it to the operator with the time. |

The server always ends a session it terminates with a proper WebSocket close (code `1000` unless the table says otherwise), so a
client never waits on a dead connection. A close with no code (`1006`) means the network dropped.

HTTP errors from `POST /v1/tokens` use the JSON shape shown in [section 2](#2-post-v1tokens).

---

## 8. Languages and output modes

`lang` accepts these codes, or `"auto"`.

| Code | Language | Code | Language | Code | Language |
|---|---|---|---|---|---|
| `hi` | Hindi | `bn` | Bengali | `ta` | Tamil |
| `te` | Telugu | `mr` | Marathi | `gu` | Gujarati |
| `kn` | Kannada | `ml` | Malayalam | `pa` | Punjabi |
| `or` | Odia | `ur` | Urdu | `as` | Assamese |
| `ne` | Nepali | `sa` | Sanskrit | `sd` | Sindhi |
| `ks` | Kashmiri | `kok` | Konkani | `mai` | Maithili |
| `doi` | Dogri | `brx` | Bodo | `mni` | Manipuri |
| `sat` | Santali | `bho` | Bhojpuri | `hne` | Chhattisgarhi |
| `bgc` | Haryanvi | `bhb` | Bhili | `en` | English (Indian) |

`"auto"` detects the language of each phrase, but it is less reliable than choosing one, especially for Hindi, Bhojpuri,
Maithili and Urdu, and it can mislabel English. If your UI knows the language, send it.

| `mode` | Output | Example for a Hindi sentence |
|---|---|---|
| `native` | Native script | भूमि अधिग्रहण कानून जस्टिस अरुण मिश्रा की अध्यक्षता वाली संविधान पीठ ही करेगी सुनवाई |
| `mixed` | Native script, but digits and English words stay in Latin script | भूमि अधिग्रहण कानून Justice Arun Mishra की अध्यक्षता वाली संविधान पीठ ही करेगी सुनवाई |
| `romanized` | Latin transliteration | Bhoomi adhigrahan kanoon Justice Arun Mishra ki adhyakshata wali Samvidhan Peethi karegi sunwai |

The text comes without punctuation, and capitalisation of English words is not consistent. Add your own formatting if you need it.

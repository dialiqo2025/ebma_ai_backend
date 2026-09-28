# Put your UI on your own server: EBMA ASR integration guide

**Who this is for:** the developer who will host the EBMA ASR user interface on a server of their own and connect it to
the EBMA GPU backend. You need to be comfortable with a web server (Python, Node or PHP) and browser JavaScript. You do
not need to know anything about GPUs or speech models.

**How long it takes:** about an hour for a working demo, plus your own time for login and styling.

**How to use this guide:** do the steps in order. Every step says what you should see when it works and what to do if you
don't. Reference material lives in the [API reference](api-reference.md).

---

## 0. What you are building

```
   +------------------------+        +-----------------------+        +--------------------------+
   |  Browser (your user)   |        |  YOUR server          |        |  EBMA backend (GPU)      |
   |                        |        |  (hosts the UI)       |        |  https://<backend host>  |
   +------------------------+        +-----------------------+        +--------------------------+
            |                                    |                                  |
   1. open your page  ---------------------->    |                                  |
   2. "give me a token" -------------------->    |                                  |
            |                          3. POST /v1/tokens                           |
            |                             Authorization: Bearer <API KEY>  ------>  |
            |                          4. { token, ws_url }  <--------------------  |
   5. <---- { token, ws_url }  ----------    |                                      |
            |                                                                       |
   6. WebSocket  wss://<backend host>/ws?token=<token>   -------------------------> |
   7. microphone audio  ----------------------------------------------------------> |
   8. <---------------------------------------------- partial / final text          |
```

Three rules make it safe and fast:

1. **The API key stays on your server.** It is a password for GPU time. Your server exchanges it for a **token** that
   is good for 5 minutes, and only the token goes to the browser.
2. **Audio goes browser -> GPU backend directly.** It does not pass through your server, so your server needs no GPU, no
   audio handling and no WebSocket support.
3. **Your server decides who may transcribe.** The token endpoint is where you check that the visitor is signed in.

---

## 1. What you need from us

Ask the EBMA operator for these. Nothing else is needed.

| # | You need | Example | Notes |
|---|---|---|---|
| 1 | **Backend URL** | `https://<backend host>` | HTTPS, no trailing slash |
| 2 | **Your API key** | a random 32-character string | Shown once. Store it in an environment variable or a secrets manager. One key per client, so yours can be revoked without affecting anyone else. |
| 3 | **Your UI's origin registered** | `https://asr.yourcompany.com` | Tell the operator the exact address your UI will be served from: scheme + host + port, no path, no trailing slash. For local testing also give `http://localhost:9000`. Without this, browsers are refused (`origin_not_allowed`). |
| 4 | **This kit** | the `docs/` and `examples/` folders | |

**Your UI must be served over HTTPS in production.** Browsers block the microphone on plain `http://` pages (except
`http://localhost` for development).

Set these on the machine where you run the examples (Windows: `set`, macOS/Linux: `export`):

```bash
export EBMA_BACKEND_URL="https://<backend host>"
export EBMA_API_KEY="<your API key>"
```

---

## 2. Step 1: prove you can reach the backend (10 minutes)

Do this before writing any code. It isolates network and access problems from your own bugs.

```bash
pip install websockets
python examples/check_backend.py --backend "$EBMA_BACKEND_URL" --api-key "$EBMA_API_KEY" --origin http://localhost:9000
```

Use `--origin` with the address your UI will be served from. You should see every line `PASS`, ending in a transcribed
Hindi sentence:

```
1. Reach the server
  PASS  DNS resolves   (...)
  PASS  TLS certificate is valid   (issuer Let's Encrypt, 90 days left)
2. The HTTP API
  PASS  GET /health
  PASS  your API key is accepted   (0/4 sessions in use)
  PASS  POST /v1/tokens returns a token
  PASS  ws_url matches the backend address
  PASS  a wrong API key is refused
3. The streaming API (WebSocket)
  PASS  WebSocket opens with the token and the server says ready
  PASS  a connection without credentials is refused
4. Browser origin
  PASS  the backend accepts browsers from http://localhost:9000
  PASS  other websites are refused
5. Transcription
  PASS  1 phrase(s) transcribed
          भूमि अधिग्रहण कानून जस्टिस अरुण मिश्रा की अध्यक्षता वाली संविधान पीठ ही करेगी सुनवाई
Summary: 0 failed, 0 warning(s).
```

If a line says `FAIL` or `WARN`, the message under it says what is wrong. The most common ones:

| You see | It means | Do |
|---|---|---|
| `DNS does not resolve` | Typo in the URL, or your network blocks it | Check `--backend`; try from another network |
| `TLS certificate is not trusted` | Wrong address, or a proxy on your network intercepts HTTPS | Use the exact URL we gave you |
| `your API key was not accepted` | Copy-paste error (a space or line break), or the wrong key | Re-copy it; ask us to re-issue |
| `the backend refuses browsers from ...` | Your origin is not registered | Send us the exact origin |
| `ws_url ... does not match` | Backend address misconfigured on our side | Tell us |

Do not continue until the summary shows `0 failed`.

---

## 3. Step 2: add the token endpoint to your server (20 minutes)

This is the only server-side code you write: one route, `POST /api/asr-token`. It authenticates *your* user, asks the EBMA
backend for a token with your API key, and returns `{ token, ws_url }` to the browser.

Complete, runnable versions are in `examples/token_server/`. The essence:

### Python (FastAPI)

```python
import os, httpx
from fastapi import FastAPI, HTTPException

BACKEND = os.environ["EBMA_BACKEND_URL"].rstrip("/")
API_KEY = os.environ["EBMA_API_KEY"]
app = FastAPI()

@app.post("/api/asr-token")
async def asr_token():
    user_id = "demo-user"   # <-- REPLACE: authenticate your user here, use their stable id, refuse anonymous visitors
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{BACKEND}/v1/tokens", json={"subject": user_id, "ttl_seconds": 300},
                              headers={"Authorization": f"Bearer {API_KEY}"})
    if r.status_code != 200:
        print("EBMA token request failed:", r.status_code, r.text)   # log it, do not send it to the browser
        raise HTTPException(502, "could not get an ASR token")
    j = r.json()
    return {"token": j["token"], "ws_url": j["ws_url"], "expires_in": j["expires_in"]}
```

### Node (18 or newer)

```js
app.post("/api/asr-token", async (req, res) => {          // any framework: Express shown; see examples/token_server/server.mjs
  const userId = "demo-user";                             // REPLACE: authenticate your user, refuse anonymous visitors
  const r = await fetch(`${process.env.EBMA_BACKEND_URL}/v1/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.EBMA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subject: userId, ttl_seconds: 300 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) { console.error("EBMA token request failed", r.status, await r.text()); return res.status(502).json({ error: "could not get an ASR token" }); }
  const { token, ws_url, expires_in } = await r.json();
  res.json({ token, ws_url, expires_in });
});
```

### PHP

> This PHP snippet has **not been run by us** (no PHP available in our test environment). It follows the same call as the
> tested examples; treat it as a starting point.

```php
<?php
// POST /api/asr-token
$userId = "demo-user";   // REPLACE: authenticate your user, refuse anonymous visitors
$ch = curl_init(getenv("EBMA_BACKEND_URL") . "/v1/tokens");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => ["Authorization: Bearer " . getenv("EBMA_API_KEY"), "Content-Type: application/json"],
    CURLOPT_POSTFIELDS => json_encode(["subject" => $userId, "ttl_seconds" => 300]),
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
if ($status !== 200) { error_log("EBMA token request failed: $status $body"); http_response_code(502); exit(json_encode(["error" => "could not get an ASR token"])); }
$j = json_decode($body, true);
header("Content-Type: application/json");
echo json_encode(["token" => $j["token"], "ws_url" => $j["ws_url"], "expires_in" => $j["expires_in"]]);
```

### Check it

Start your server, then call your own endpoint:

```bash
curl -s -X POST http://localhost:9000/api/asr-token
```

You should get back something like:

```json
{"token":"ebma1.eyJraWQiOiJ1aS1kZXYi...","ws_url":"wss://<backend host>/ws","expires_in":300}
```

| You get | Cause |
|---|---|
| `502 could not get an ASR token` | Read your server's log line: `401` = wrong API key, `400` = bad body, a timeout = your server cannot reach the backend (firewall/egress) |
| A token, but the browser later fails with `unauthorized` | Your server's clock is far off, or `ws_url` was altered |

**Do not skip the authentication comment in the code.** Every token is GPU time you pay for; a token endpoint open to the internet is
an open tap.

---

## 4. Step 3: add the browser client (20 minutes)

Copy `examples/browser/ebma-asr.js` next to your page. It has no dependencies. This is the whole integration on the page:

```html
<button id="go">Start listening</button>
<p id="live"></p>          <!-- the live preview -->
<div id="finals"></div>    <!-- the finished phrases -->

<script type="module">
  import { EbmaAsr } from "/ebma-asr.js";

  const asr = new EbmaAsr({
    getToken: () => fetch("/api/asr-token", { method: "POST" }).then((r) => r.json()),   // your endpoint from step 2
    lang: "hi",          // or "en", "ta", "te", ... see the API reference; "auto" detects
    mode: "native",      // "native" | "mixed" | "romanized"
  });

  asr.addEventListener("partial", (e) => { live.textContent = e.detail.text; });      // may change while speaking
  asr.addEventListener("final", (e) => {                                              // done: append it
    finals.append(Object.assign(document.createElement("div"), { textContent: e.detail.text }));
    live.textContent = "";
  });
  asr.addEventListener("error", (e) => console.error(e.detail.code, e.detail.message));

  go.onclick = () => (asr.running ? asr.stop() : asr.start());   // start() must run from a click
</script>
```

`examples/browser/index.html` is a complete, styled page using exactly this. What the client does for you, so you don't
have to:

- Asks for the microphone and the token **at the same time**.
- Starts capturing the moment the microphone opens and **holds the audio until the connection is ready**, so the first
  words are never lost (a long-distance connection takes 1-2.5 s to set up).
- Streams 16-bit audio in 50 ms blocks; the backend resamples, so you never handle sample rates.
- Fetches a fresh token and retries **once** if the first token was refused as expired.
- Turns every failure into an `error` event with a `code` you can branch on.

Events: `partial`, `final`, `status`, `speech`, `level`, `error`. Full list and fields: top of `ebma-asr.js` and the
[API reference](api-reference.md).

**Prefer not to use the client?** `examples/browser/raw-websocket.html` is the same thing in about 60 lines with no
library, showing every protocol message. Port it to React, Vue, or anything else.

---

## 5. Step 4: run it and test it (10 minutes)

Run the ready-made example (Python):

```bash
pip install fastapi uvicorn httpx
cd examples/token_server
python -m uvicorn server:app --port 9000        # uses EBMA_BACKEND_URL and EBMA_API_KEY
```

or Node: `node examples/token_server/server.mjs` (port 9000 by default).

Open **http://localhost:9000**, choose a language, press **Start listening**, allow the microphone, and speak. Localhost
counts as a secure page, so the microphone works without HTTPS.

**You should see:** the status change to *listening*; a grey preview appear within a few seconds of you starting to speak; after
you pause for about a second the final text replaces it.

Then test the failure cases a real user will hit:

| Test | How | Expected |
|---|---|---|
| Wrong origin | Serve the same page from a port that is not registered (e.g. `--port 9002`) | An `origin_not_allowed` error event. Nothing transcribes. |
| Microphone denied | Click *Block* on the permission prompt | `mic_denied` error event |
| Token endpoint down | Stop your server after loading the page, press Start | `token_error` event |
| Too many tabs | Open the page in three tabs and press Start in all of them as the same user | The third gets `too_many_sessions` (each user may run 2 at once) |
| Session length | Leave one session running past 20 minutes | A `session_limit` error, then the status changes to *stopped*; press Start to continue. (A silent microphone keeps sending audio, so silence alone does not end a session.) |

---

## 6. Step 5: going live

- [ ] Your UI is served over **HTTPS**; your token endpoint too.
- [ ] Your real origin (e.g. `https://asr.yourcompany.com`) is **registered with us**. Remove `localhost` from the list once you are done testing.
- [ ] The token endpoint **authenticates your user** and passes a stable `subject` (never an email or phone number).
- [ ] The API key is in an **environment variable or secrets manager**, not in the repository, front-end code, or a log line.
- [ ] You **rate-limit** the token endpoint per user (for example a few per minute), so one user cannot script thousands of tokens.
- [ ] You show **friendly messages** for `busy` (try again in a few seconds), `origin_not_allowed`, and `mic_denied`. Sample copy is in the API reference table.
- [ ] You tested on the browsers your users have: current Chrome, Edge, Safari and Firefox. Their microphone permission prompts behave differently (Safari may ask again on each visit), so test the "denied" path in each.
- [ ] You know who to contact when it breaks (the EBMA operator), and you keep the time of the failure and the `code` from the error event.
- [ ] You told us how many people will use it at once. The GPU serves 4 sessions at a time by default; we size it to your number.

Things that surprise people:

- **Latency has two parts.** Text is ready on the server about 1.2-1.7 s after someone stops speaking (a 0.7 s pause that
  ends the phrase, plus recognition). Add the network round trip between your user and the GPU. The live preview hides much of
  the wait.
- **It transcribes phrase by phrase, not word by word.** Previews refresh about once a second and can change earlier words; the
  final text does not change.
- **One connection = one stream.** To transcribe again, start a new session (the client does this on every `start()`).
- **A session lasts up to 20 minutes.** Longer conversations need your UI to start a new session; nothing else changes.

---

## 7. Server-side integrations (no browser)

If audio comes from a server instead (a phone call, a meeting bot, a batch job), skip the token exchange and connect with your API key
in a header. `examples/python/asr_client.py` streams a WAV file and prints phrases as they arrive:

```bash
pip install websockets
python examples/python/asr_client.py --backend "$EBMA_BACKEND_URL" --api-key "$EBMA_API_KEY" --wav docs/sample_hi.wav --lang hi
```

Send 16-bit mono audio in 20-100 ms frames at real-time pace (whole samples: an even number of bytes per frame). The protocol
is in the [API reference](api-reference.md), and a few dozen lines in any language that has a WebSocket client is enough.

---

## 8. Troubleshooting

Run `check_backend.py` first: it finds most of these.

| Symptom | Likely cause | Fix |
|---|---|---|
| Microphone never asks / `getUserMedia` undefined | The page is not on HTTPS or localhost | Serve over HTTPS |
| Error event `origin_not_allowed` | Your page's origin is not registered, or has a typo (`http` vs `https`, `www`, port) | Send us the exact address from the browser bar, without the path |
| Error event `unauthorized` right away | Token expired before use (slow endpoint), tampered, or your server's clock is wrong | The client retries once; if it persists, check the server clock and that `ws_url` is passed unchanged |
| Error event `token_error` | Your `/api/asr-token` failed (HTTP error, not JSON, missing `token` or `ws_url`) | Open the browser Network tab, look at that request's response, and your server log |
| Error event `busy` | All GPU slots are in use | Retry after 2-5 s; ask us to raise the capacity if it is frequent |
| First words are missing | You are not buffering audio until `ready` | Use `ebma-asr.js`, or keep audio in a queue like the raw example does |
| Text is in the wrong script or language | `lang` is wrong, or `"auto"` guessed wrong | Pass the language explicitly; use `mode` to choose native, mixed or romanized |
| Text is empty, or misses quiet speech | Very short utterances (under a quarter second) are ignored; far-field or noisy audio | Ask the user to speak nearer the microphone; keep the browser's noise suppression on |
| `final` comes late (3 s or more) | Slow network to the GPU, or `end_silence_ms` is high | Check `latency_ms` in the event (server time) vs what you see; lower `end_silence_ms` to 400-500 |
| Works locally, fails once deployed | Browser blocks mixed content, or a corporate proxy blocks WebSockets | Serve the UI over HTTPS; test `wss://` from the affected network |
| Connection drops after ~20 min | The session time limit | Start a new session |

## 9. FAQ

**Can the UI be on a different domain from our token endpoint?** Yes, but then *that* domain must allow your UI's origin with
normal CORS on your own endpoint. The simplest setup is to serve the UI and the token route from the same server, as the examples do.

**Can we use one API key for staging and production?** Better not: ask for one per environment, so a leak in staging cannot touch production.

**Do you store our audio or transcripts?** The backend keeps audio only in memory while a session runs and does not write audio or
text to disk or logs. It logs, per session: which API key, your `subject`, how many seconds of audio, how many phrases.

**Can a browser call `POST /v1/tokens` directly?** No, on purpose. It would require the API key in the browser.

**How do we know how much we used?** Ask the operator: each session is logged with your key label, `subject` and audio seconds.

**What changes if we upgrade our UI later?** Nothing on our side. New API features add fields and events; ignore what you don't know.

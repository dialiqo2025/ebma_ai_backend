# Operating the EBMA ASR backend

**Who this is for:** the person who runs the GPU box. Developers who only build a UI need the
[integration guide](integration-guide.md) instead.

All commands run on the pod, in `/workspace/indic-transcribe-streaming`, over SSH.

---

## 1. What runs where

| Thing | Where |
|---|---|
| The backend (model + API) | one Python process, `python -m app.server`, started by `deploy/direct.sh` |
| Public address | `https://gpu-4527a.69.162.125.131.nip.io`: the platform's HTTPS proxy (real Let's Encrypt certificate) forwards to the pod's port 8888 as plain HTTP |
| Settings and secrets | `.env` in the project folder (mode 600) |
| Model files | `models/indic-transcribe-flex/` on the fast local disk (about 4.6 GB) |
| Log | `server.log` (append-only) |
| Python environment | `.venv/` |

GPU memory: about 2.3 GiB per backend process. The backend uses one decode thread per process.

---

## 2. Settings

Set in `.env` as `NAME="value"` lines. `deploy/start.sh` reads the file at start-up, so **restart after any change**.

| Variable | Default | Meaning |
|---|---|---|
| `API_KEYS` | none | `label:secret,label2:secret2`: one key per client. Manage with `deploy/newkey.sh`, not by hand. With no keys the backend is **open**, for development only. |
| `DEMO_KEY` | none | One extra key labelled `demo`, used by the built-in demo page. `deploy/direct.sh` sets it from `.demo_key`. |
| `TOKEN_SECRET` | random each start | Signs the short-lived tokens. Fixed in `.env` so tokens survive a restart. Change it to invalidate every outstanding token. |
| `TOKEN_TTL`, `TOKEN_TTL_MAX` | 300, 900 | Default and maximum token lifetime in seconds |
| `ALLOWED_ORIGINS` | any | Comma-separated browser origins (`https://asr.example.com`) allowed to open `/ws` and call `GET /health`. The backend's own page is always allowed. **Set it in production.** |
| `PUBLIC_BASE_URL` | derived from request headers | The address clients reach the backend at. Builds the `ws_url` in token responses. Set it explicitly. |
| `MAX_SESSIONS` | 4 | Simultaneous sessions per backend process. See [capacity](#5-capacity-measured). |
| `MAX_SESSIONS_PER_SUBJECT` | 2 | Simultaneous sessions for one end user (the `subject` a client passes when it asks for a token) |
| `MAX_SESSION_MINUTES` | 20 | Length of one session |
| `IDLE_SECONDS` | 60 | A connection that sends nothing for this long is closed |
| `SERVE_UI` | 1 | `0` turns the built-in demo page off, leaving a pure API (do this once your UI lives elsewhere) |
| `SHOW_MODEL_CREDIT` | 0 | `1` shows the model credit line on the demo page (see the README, "Model licence") |
| `INDIC_MODEL_DIR`, `INDIC_DEVICE`, `INDIC_DTYPE`, `ASR_PIN_CORES` | see README | Model location and precision |

---

## 3. Everyday tasks

### Give a UI developer access

```bash
bash deploy/newkey.sh acme-ui           # prints the key once. Copy it now.
nano .env                               # add their origin to ALLOWED_ORIGINS, comma-separated
TLS=none bash deploy/direct.sh          # restart (about 10 s; running sessions drop)
```

Send them: the backend URL, the key (through a password manager, never plain email or chat), and the `docs/` and `examples/` folders.
Ask them to run `python examples/check_backend.py ...` and send you the result. Use one key per client and one per environment.

### Take a key away

```bash
bash deploy/newkey.sh acme-ui --revoke
TLS=none bash deploy/direct.sh
```

Tokens that key already minted keep working until they expire (15 minutes at most). To cut them off at once, also change
`TOKEN_SECRET` in `.env` (this invalidates everybody's tokens, and clients simply fetch new ones).

### Allow another website

Add its origin to `ALLOWED_ORIGINS` and restart. An origin is `scheme://host[:port]` with no path and no trailing slash. Remove
`http://localhost:...` entries once development is over.

### After the pod is stopped and resumed

Processes do not survive a stop. The SSH port changes on every resume.

```bash
cd /workspace/indic-transcribe-streaming && TLS=none bash deploy/direct.sh
```

Then check the public address still answers. If the address changed, update `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS` and tell your clients.

### Take the service down / give JupyterLab back

```bash
bash deploy/direct.sh stop
```

---

## 4. Monitoring and usage

**Is it up?** From anywhere: `curl https://<backend>/health` gives `{"status":"ok"}`. With an API key it also shows
`active_sessions`, `max_sessions` and `queue_depth`. Hardware details are only shown to a request made on the pod itself.

**Log lines** (`server.log`). None contain audio or text.

```
INFO server: auth: 2 API key(s): ui-dev, demo | origins: ... | ui: on            at start-up
INFO server: token minted key=ui-dev subject=user-42 ttl=300s lang=-
INFO server: session end key=ui-dev subject=user-42 audio=9.7s phrases=1 duration=2.6s origin=https://asr.example.com
WARNING server: origin refused: https://evil.example (key ui-dev)
```

**Usage per client** (for billing or capacity planning):

```bash
grep "session end" server.log | sed -E 's/.*key=([^ ]+) .*audio=([0-9.]+)s phrases=([0-9]+).*/\1 \2 \3/' \
 | awk '{a[$1]+=$2; p[$1]+=$3; n[$1]++} END {for (k in a) printf "%-10s %3d sessions  %6.0f s of audio (%.1f min)  %3d phrases\n", k, n[k], a[k], a[k]/60, p[k]}'
```

`server.log` only grows. Trim it now and then (for example `tail -n 200000 server.log > s.tmp && mv s.tmp server.log`).

---

## 5. Capacity (measured)

Measured on this pod (RTX 4090, AMD EPYC 7532) with `scripts/load_test.py`: N people speaking continuously at the same
time, three phrases each, over the public address. Speaking back to back is the worst case; real conversations have gaps.

| Speakers at once | Recognition time per phrase | Wait for the GPU (median / worst) | Text ready after a speaker stops (median / worst) |
|---|---|---|---|
| 1 | 0.59 s | 0.0 / 0.0 s | 1.30 / 1.33 s |
| 2 | 0.59 s | 0.6 / 2.1 s | 1.89 / 3.39 s |
| 4 | 0.60 s | 1.1 / 1.7 s | 2.39 / 2.95 s |
| 6 | 0.61 s | 1.7 / 2.9 s | 3.02 / 4.19 s |
| 8 | 0.62 s | 2.1 / 3.8 s | 3.37 / 5.11 s |

The last column includes the 0.7 s pause that ends a phrase and excludes the network. "Worst" is the largest of only 3 to 24 phrases,
so treat it as indicative.

**How to read it.** Each backend process runs recognition on one thread, and phrases queue behind each other, so the wait grows by
roughly half a second per extra simultaneous speaker. The GPU itself is only about a third busy: the limit is that one thread, not
graphics memory. The default `MAX_SESSIONS=4` keeps the median under 2.5 s in the worst case.

**To serve more people at once** (not built or tested yet, this is the plan): run several backend processes on the same GPU. Each takes
about 2.3 GiB, so a 24 GB card holds many, and the pod has 30 CPU cores. They must share the public port, for example with
`uvicorn --workers`. Session counters are then per process, so the per-user limit becomes approximate. Model start-up needs about
5 GB of system RAM per process while loading, so start them one at a time on a 27 GB machine.

---

## 6. Security notes

What protects the service:

- **Every client has its own API key.** Keys live only in `.env`; browsers never see them, only tokens that expire in minutes.
- **Tokens** are signed (HMAC-SHA256), carry their expiry, and can be locked to one language and one end user.
- **Browser origins** are checked on the WebSocket, so another website cannot use the API in a visitor's browser. Servers skip this
  check and authenticate by key.
- `POST /v1/tokens` has no CORS headers, so it cannot be called from a browser.
- `/docs`, `/redoc`, `/openapi.json` are off. The access log is off (URLs can contain keys). `GET /health` reveals nothing to anonymous callers.
- Audio is held in memory only while a session runs. Nothing but counts is logged.

What it does **not** do (know the limits):

- There is **no per-IP rate limit**. Abuse is bounded by the session caps (`MAX_SESSIONS`, per-user, 20 minutes), not by request rate.
- The `subject` a UI passes is trusted as given; it is a label for limits and logs, not an identity we verify.
- Between the platform's proxy and the pod the traffic is plain HTTP inside their network. The public side is HTTPS.

**If a key leaks:** revoke it (section 3), then change `TOKEN_SECRET`, restart, and issue that client a new key. Check `server.log` for
sessions under that key label.

---

## 7. Model licence

The model is used under an agreement with its publisher: hosting for others is approved, and no credit line is required under
Dialiqo's terms. The agreement itself is not in this repository, so keep a copy where the team can find it. If it ever needs a credit,
set `SHOW_MODEL_CREDIT=1`. More in the README, "Model licence and the Bodhan AI agreement".

---

## 8. When something is wrong

| Symptom | Check |
|---|---|
| A client says "unauthorized" | Is their key in `API_KEYS`? Was `TOKEN_SECRET` changed (old tokens die)? Is the pod's clock right (`date`)? |
| A client says "origin_not_allowed" | Compare their exact origin (from the browser bar) with `ALLOWED_ORIGINS`: `http` vs `https`, `www`, port. |
| A client says "busy" often | `curl` health with a key: are `active_sessions` near `max_sessions`? See capacity; raise `MAX_SESSIONS` or add processes. |
| Text is slow | Health `queue_depth`, and the capacity table. High network latency shows as slow connection set-up, not slow text. |
| Nothing answers | `pgrep -f app.server`; last lines of `server.log`; then `TLS=none bash deploy/direct.sh`. If the pod was resumed, this is the usual cause. |
| Out of GPU memory | `nvidia-smi`. One process needs about 2.3 GiB; another tenant of the card, or several stray processes (`pkill -f app.server` then restart). |
| `check_backend.py` fails from a client's network | Run it yourself from outside. If it passes for you and fails for them, the problem is their network (proxy, firewall, DNS). |

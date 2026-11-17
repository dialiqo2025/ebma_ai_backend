# Voice Assistant: realtime (LiveKit)

The portal's Voice Assistant (`/platform/voice-assistant`) is a realtime voice call with the EBMA voice agent, which runs as a separate service (`ebma-livekit-agent`, deployed on `bot.dialiqo.com`).

```
Browser (livekit-client) ──WebRTC──▶ LiveKit (wss://bot.dialiqo.com) ◀── EBMA voice agent
   │ POST /api/v1/voice/sessions                                          │  EBMA ASR (stream) → LLM (stream) → EBMA TTS (stream)
   ▼                                                                      │
Backend: auth + credits → LLM settings → room + agent dispatch (encrypted config) → join token
   ▲                                                                      │
   └──────── POST /api/v1/voice/agent-events (HMAC, session.ended usage) ─┘
```

The old turn-based endpoints (`/chat/messages`, `/chat/speech`) are unchanged and still serve API-key customers.

## Endpoints (`src/services/voice/`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/voice/options` | JWT | languages (Arabic/Urdu excluded: no realtime ASR), voice presets, the user's cloned voices, which LLM is used, availability |
| POST | `/voice/sessions` | JWT | checks credits, then creates room `ebma-va-<uuid>`, dispatches the agent and returns `{livekitUrl, token, roomName, voice, llm}` |
| POST | `/voice/sessions/:room/end` | JWT | ends the call; ownership is checked through an HMAC owner tag in the room metadata |
| POST | `/voice/agent-events` | HMAC | agent lifecycle events; `session.ended` is billed (`stt_seconds`, `tts_characters`, `llm_tokens`, idempotent per session) |

API keys can't use `/voice/*`.

## Security model

- **Per-session config:** the system prompt, language, voice and LLM settings are sent to the agent as **AES-256-GCM encrypted** dispatch metadata.
  - Key: SHA-256(`EBMA_AGENT_SHARED_SECRET`). AAD: the room name. Expiry: 5 min.
  - So the user's own LLM API key is never visible to browsers or room participants, and a payload can't be replayed into another room.
- **LLM:** the user's LLM Settings are used if present (Gemini, Claude, OpenAI, Groq and Custom, all through their OpenAI-compatible endpoints). Otherwise the agent's platform model is used (Groq `openai/gpt-oss-120b`, key held by the agent only).
  - The agent refuses custom endpoints that resolve to private or loopback addresses (SSRF guard).
- **Listening:** the agent only listens to the participant identity named in the encrypted config.
- **Cloned voices:**
  - The backend puts the sample's SHA-256 in the encrypted config.
  - The browser downloads the user's own sample (`GET /tts/voices/:id/audio`) and sends it to the agent over a LiveKit byte stream.
  - The agent uses it only if the hash matches. If it doesn't arrive within 20 s, the call falls back to a preset voice.

## Configuration

Backend `.env`:

```
LIVEKIT_URL=https://bot.dialiqo.com
LIVEKIT_WS_URL=wss://bot.dialiqo.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
VOICE_AGENT_NAME=ebma-voice-agent
EBMA_AGENT_SHARED_SECRET=...      # = agent EBMA_METADATA_SECRET and EBMA_EVENTS_WEBHOOK_SECRET
VOICE_PLATFORM_LLM_LABEL=Groq gpt-oss-120b
```

Agent `.env` (`/workspace/ebma-livekit-agent/.env` on the LiveKit host):

```
EBMA_METADATA_SECRET=<shared secret>
EBMA_EVENTS_WEBHOOK_SECRET=<shared secret>
EBMA_EVENTS_WEBHOOK_URL=https://<production backend>/api/v1/voice/agent-events   # required for billing
```

**Billing:** usage is only recorded when the agent can reach `EBMA_EVENTS_WEBHOOK_URL`. A local backend (`localhost`) isn't reachable from the agent server, so calls from local development aren't billed.

## Testing

```bash
npx tsx scripts/voice-smoke-test.ts   # backend -> LiveKit -> agent (no DB, no login), prints join time + agent state
```

Agent-side tests (`docker compose run --rm --no-deps -T agent python -m pytest`) include a cross-language check: they decrypt a payload produced by `voice.crypto.ts`.

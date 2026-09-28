# EBMA ASR: documentation

EBMA ASR turns speech into text, live, for 27 Indian languages. The speech engine runs on a GPU backend; the user interface can
live on any other server. These documents explain how the two connect.

| You are... | Start with | Then |
|---|---|---|
| **A developer** building the UI on your own server | [integration-guide.md](integration-guide.md): a step-by-step walk-through, about an hour | [api-reference.md](api-reference.md) when you need exact details |
| **Someone integrating from a server** (phone calls, meeting bots, batch jobs) | Section 7 of the integration guide, and `examples/python/asr_client.py` | [api-reference.md](api-reference.md) |
| **The operator** of the GPU backend | [operations.md](operations.md): settings, keys, monitoring, capacity | |
| **Using a tool that reads OpenAPI** | [openapi.yaml](openapi.yaml): the two HTTP endpoints (the streaming API is a WebSocket, described in the reference) | |

## The kit

```
docs/
  integration-guide.md       walk-through for the UI developer
  api-reference.md           every endpoint, message, error and limit
  operations.md              for the operator
  openapi.yaml               the HTTP endpoints
  sample_hi.wav / .txt       a 10 s Hindi clip and its expected text, for smoke tests
examples/
  check_backend.py           RUN THIS FIRST: checks every step of the connection and explains failures
  browser/ebma-asr.js        the browser client (no dependencies)
  browser/index.html         a complete example page using it
  browser/raw-websocket.html the same in ~60 lines with no library, to port to any framework
  token_server/server.py     your server's one route, in Python (FastAPI)
  token_server/server.mjs    ...and in Node
  python/asr_client.py       stream a WAV file from a server
```

Everything under `examples/` was run against the live backend before it was included. The one PHP snippet in the integration guide is
the exception and is marked as such.

## The idea in three lines

1. Your server keeps a secret **API key** and exchanges it for a **token** that lasts five minutes.
2. Your page gives that token to the browser, which streams microphone audio **directly** to the GPU backend.
3. Text comes back phrase by phrase: a live preview while someone speaks, the final text when they pause.

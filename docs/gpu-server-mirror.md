# Mirroring the EBMA GPU server

How to copy the EBMA speech stack from the current GPU server to the new one, and get it serving there.

| | Source (current) | Destination (new) |
|---|---|---|
| SSH alias | `ebma-gpu` | `new-ebma-gpu` |
| Address | `103.119.170.133`, port `32797` | `103.189.173.21`, port `22` |
| User | `root` | `ubuntu` (has passwordless `sudo`) |
| Machine | Container on a rented GPU host (hostname `9ac6108309e2`) | Full VM (hostname `acecloud-new`) |
| OS | Ubuntu 24.04.1, Python 3.12.3 | Ubuntu 24.04.5, Python 3.12.3 |
| GPU | RTX PRO 4500 Blackwell, 32 GB | RTX PRO 4500 Blackwell, 32 GB |
| NVIDIA driver | 595.99 (CUDA 13.2) | 580.196 (CUDA 13.0) |
| CPU / RAM | 8 cores / 31 GB | 16 cores / 47 GB |
| Disk | `/workspace`: 64 GB used | `/`: 238 GB free |
| HTTPS | Provided by the platform's proxy (`*.103.119.170.133.nip.io`) | None. You must add it (step 6). |

## What runs on the source

Everything lives under `/workspace`. Nothing the services need is outside it.

| Directory | Size | What it is | Torch build |
|---|---|---|---|
| `ebma-tts/` | 20 GB | TTS. The Higgs TTS 3 4B model, served by `sgl-omni` on `127.0.0.1:8100`. Also holds `deploy/`, the scripts that run the whole stack. | 2.13.0, CUDA 13.0 |
| `indic-transcribe-streaming/` | 16 GB | Indic ASR. Its venv also runs `deploy/combined.py`, the public web/API process on `0.0.0.0:8899` (ASR at `/`, TTS at `/tts`). Holds `.env` and `.demo_key`, which are secrets. | 2.11.0, CUDA 13.0 |
| `parakeet-tdt/` | 11 GB | Parakeet ASR | 2.15.0, **CUDA 13.2** |
| `voxtral-ar/` | 17 GB | Arabic ASR (Voxtral). Switched on with `deploy/arabic_mode.sh`. | 2.13.0, **CUDA 13.2** |
| `indic-tn/` | 1.1 GB | Indic text normalization (git: `Kenpath/indic-text-normalization`) | n/a |

At the time of writing, the only processes running were the TTS engine (`sgl-omni`, port 8100) and `combined.py` (port 8899). `deploy/watchdog.sh` restarts either one if it fails 3 health checks in a row.

How things start:

- `bash deploy/serve_all.sh`, run from `/workspace/ebma-tts`, starts the whole stack.
  - It starts the engine if it isn't already up (about 4 minutes from cold) and warms it up.
  - Then it starts `combined.py`, loading `indic-transcribe-streaming/.env` and `.demo_key`.
  - Then it starts the watchdog.
- `bash deploy/serve_all.sh stop` stops the web side and the watchdog.
- `deploy/stop_services.sh` and `deploy/status.sh` are also available.

Nothing starts on boot. On the source, the platform's `/entrypoint.sh` only starts sshd and JupyterLab, so someone runs `serve_all.sh` by hand after each restart.

### Why the copy works as-is

- **Virtualenvs:** all of them are `uv` venvs pointing at `/usr/bin/python3.12`, which both machines have in the same version. They work unchanged if they stay at the same path, `/workspace/...`.
- **CUDA compiler:** `start_higgs.sh` uses the CUDA 13 `nvcc` that ships inside the venv (`.venv/.../nvidia/cu13`). The destination therefore needs no CUDA toolkit installed.
- **Compile caches:** the Triton, inductor and FlashInfer caches are in `ebma-tts/.cache`, so they come along with the copy.

## Blockers to settle first

1. **Driver version (probably not a blocker).** The destination's driver (580) reports CUDA 13.0, while `parakeet-tdt` and `voxtral-ar` were built for CUDA 13.2. CUDA's minor-version compatibility lets 13.x builds run on a 13.0 driver. On 2026-11-12, both venvs passed a real GPU test on the destination (a bf16 matmul and fp16 attention). If either service fails to start with a PTX or "unsupported toolchain" error, upgrade the driver to 595 or newer (needs a reboot).
2. **No HTTPS or firewall on the destination.** `combined.py` listens on `0.0.0.0:8899` over plain HTTP, and `ufw` is inactive. The source sits behind the platform's HTTPS proxy, but the destination is directly on the internet. See step 6.
3. **Unauthenticated JupyterLab on the source.** It runs as root on `0.0.0.0:28888` with an empty token, `allow_origin=*` and XSRF checks off, and is relayed to port 8888. Anyone who can reach that port gets a root shell. Do **not** copy this setup. Check whether the platform exposes it publicly.

## Steps

### 1. Prepare the destination (done)

```bash
ssh new-ebma-gpu 'sudo mkdir -p /workspace && sudo chown ubuntu:ubuntu /workspace'
```

### 2. Copy `/workspace`

The source has no `rsync` or `zstd`, so the copy is a plain `tar` stream over SSH. Copy one directory at a time, so a failure only means redoing that directory. Leave out `lost+found` and `Race-Storage`. Copying while the source is serving is safe, because the models and venvs don't change. The only side effect is that the log files are a snapshot.

**Option A: direct, server to server (faster).** Give the source a key the destination accepts, then push:

```bash
# On the source: make a throwaway key (lives only in /tmp)
ssh ebma-gpu 'ssh-keygen -q -t ed25519 -N "" -C temp-mirror -f /tmp/mirror_key && cat /tmp/mirror_key.pub'
# On the destination: accept that key, only from the source's IP
ssh new-ebma-gpu 'echo "from=\"103.119.170.133\" <paste the public key>" >> ~/.ssh/authorized_keys'

# Push each directory
for d in ebma-tts indic-transcribe-streaming parakeet-tdt voxtral-ar indic-tn; do
  ssh ebma-gpu "cd /workspace && tar cf - $d | ssh -c aes128-gcm@openssh.com -i /tmp/mirror_key \
    -o StrictHostKeyChecking=accept-new ubuntu@103.189.173.21 'tar xf - -C /workspace'"
done

# Afterwards: remove the throwaway key from both machines
ssh new-ebma-gpu "sed -i '/temp-mirror/d' ~/.ssh/authorized_keys"
ssh ebma-gpu 'rm -f /tmp/mirror_key /tmp/mirror_key.pub'
```

**Option B: relayed through your PC (no new keys, slow).** Measured at about 4.4 MB/s, so roughly 4 hours for 64 GB. The PC has to stay online for the whole copy.

```bash
for d in ebma-tts indic-transcribe-streaming parakeet-tdt voxtral-ar indic-tn; do
  ssh ebma-gpu "cd /workspace && tar cf - $d" | ssh new-ebma-gpu "tar xf - -C /workspace"
done
```

### 3. Check the copy

```bash
for h in ebma-gpu new-ebma-gpu; do echo "== $h"; ssh $h 'cd /workspace && du -s --apparent-size */ | sort -k2'; done
ssh new-ebma-gpu 'cd /workspace && for d in */; do [ -x $d.venv/bin/python ] && echo "$d $($d.venv/bin/python -c "import torch;print(torch.cuda.is_available())")"; done'
```

The sizes should match, and every venv should print `True`. For `parakeet-tdt` and `voxtral-ar`, that only holds once blocker 1 is fixed.

### 4. Fix files that name the old server

- **`indic-transcribe-streaming/.env`:**
  - `PUBLIC_BASE_URL` is `https://gpu-6342a-api.103.119.170.133.nip.io`. Change it to the destination's public URL.
  - `ALLOWED_ORIGINS` also lists the two old `nip.io` hosts. Add the new ones.
  - Keep `API_KEYS` and `TOKEN_SECRET` as they are, so existing clients keep working.
- **Paths:** search for anything else that hard-codes the old address:

  ```bash
  ssh new-ebma-gpu 'grep -rIl --exclude-dir=.venv --exclude-dir=models --exclude-dir=.cache "103.119.170.133\|gpu-6342a" /workspace'
  ```

### 5. Start the stack on the destination

First install the Python development headers. The old container had them, but the new VM does not. Without them, Triton fails to compile its start-up helper (`gcc ... cuda_utils.c` exits with status 1), and the engine never comes up:

```bash
ssh new-ebma-gpu 'sudo apt-get install -y python3.12-dev python3-dev zlib1g-dev libexpat1-dev python3.12-venv'
```

Then start it:

```bash
ssh new-ebma-gpu 'cd /workspace/ebma-tts && bash deploy/serve_all.sh'
ssh new-ebma-gpu 'curl -fsS http://127.0.0.1:8100/health && curl -fsS http://127.0.0.1:8899/health'
```

The engine takes about 4 minutes the first time. Memory split: TTS reserves `MEM_FRACTION=0.35` of the GPU, about 11 GB.

To start on boot, add a `systemd` unit that runs `serve_all.sh` as `ubuntu`. The source had no such unit.

### 6. HTTPS and firewall on the destination

Put a reverse proxy with a real certificate in front of port 8899, and stop exposing 8899 directly. For example, Caddy on a `nip.io` name:

```text
gpu-api.103.189.173.21.nip.io {
    reverse_proxy 127.0.0.1:8899
}
```

Then turn on the firewall:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

Change `combined.py` to listen on `127.0.0.1`, or rely on `ufw`. Check that the cloud provider's security group also allows 80 and 443.

### 7. Point the EBMA backend at the new server

These are environment variables in `ebma_ai_backend`, set on Render or in `.env`. Change them only after step 5 passes:

- `EBMA_ASR_BACKEND_URL`, `EBMA_ASR_ARABIC_WS_URL`, `EBMA_ASR_ARABIC_HEALTH_URL` (STT)
- `TTS_MODEL_ENDPOINT` (and `TTS_MODEL_API_KEY`, if the key changes)

Keep the old server running until the backend has served real traffic from the new one. Then stop the source.

## Status

| Step | Status |
|---|---|
| Inventory both servers | Done (2026-11-12) |
| 1. `/workspace` created on destination | Done |
| 2. Copy | Done (2026-11-12) with option A: 5 directories, about 64 GB, about 8.5 min at about 500 MB/s. Throwaway key removed from both machines. |
| 3. Check | Done. File counts are identical. Sizes match, except about 1 KB of log the live source wrote during the copy. Every torch venv sees the GPU, and the CUDA 13.2 venvs pass a real GPU test. Copied files belong to `ubuntu`, and `.env` and `.demo_key` kept mode 600. |
| Driver upgrade | Probably not needed (see blocker 1) |
| 4. Fix files that name the old server | Done. In `indic-transcribe-streaming/.env`, `PUBLIC_BASE_URL` now points at the new URL and the new URL is added to `ALLOWED_ORIGINS`; the old entries are kept for the switch-over. The original is saved as `.env.bak-old-server`. No other files named the old server. |
| 5. Start the stack | Done (2026-11-12). The first start failed because the Python headers were missing; it worked after installing them. Engine (8100) and web side (8899) are healthy, the watchdog is running, and about 17 GB of GPU memory is used, the same as the source. Not started on boot yet: no systemd unit. |
| 6. HTTPS and firewall | Done. `ufw` is on, allowing 22, 80 and 443. AceCloud's own firewall had to be opened for 80 and 443, which was done in the console. Caddy 2.6.2 serves `https://gpu-api.103.189.173.21.nip.io` with a Let's Encrypt certificate. Port 8899 is not reachable from outside. |
| 7. Point the backend at the new server | Not started. This is your decision, because it switches live traffic. |

New public URL: `https://gpu-api.103.189.173.21.nip.io`. `/health` and `/tts/health` return 200; the demo pages `/` and `/tts/` need `?key=<.demo_key>`.

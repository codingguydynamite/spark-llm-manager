---
name: llm-manager
description: Use when starting, stopping, checking status, or checking memory of local LLMs (Qwen 27B, Nemotron 30B, or other vLLM / run.sh models) on the 192.168.1.19 host.
---

# llm-manager — remote LLM control API

A zero-dependency Node.js HTTP service running on the host **192.168.1.19**
(port **8790** by default). It starts LLM inference processes on that host,
tracks their state in memory, and reports host/GPU memory. Use it whenever
you need to start/stop/inspect a local model on that machine.

## Base URL & auth

- Base: `http://192.168.1.19:8790`
- Every endpoint except `GET /health` requires:
  `Authorization: Bearer $LLM_API_TOKEN`
- **Never hardcode or print the token.** Read it from the `LLM_API_TOKEN`
  environment variable, or ask the user for it. On the host it lives in the
  pm2 env / `ecosystem.config.js`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, no auth |
| GET | `/models` | catalog: names, labels, expected GPU/RAM |
| GET | `/status` | all models, cached + `X-Status-Age`, `X-Status-Refresh` headers |
| GET | `/status/<name>` | one model |
| POST | `/start/<name>` | idempotent start (202 / 409 semantics below) |
| POST | `/stop/<name>` | stop (SIGTERM → 10 s → SIGKILL) |
| GET | `/memory` | host RAM + GPU + per-model expected/actual + headroom |
| GET | `/logs/<name>?tail=100` | tail of the model's stdout/stderr log |

## Known models

- `qwen27b` — Qwen 27B via the DGX Spark `run.sh` (cwd `~/Desktop/dgx-spark-qwen38`,
  `ENGINE_BIND=0.0.0.0 ./run.sh`).
- `nemotron30b` — NVIDIA Nemotron 3.5 Lightning 30B-A3B NVFP4, vLLM on port 8000.

Adding a new model = add an entry to `models.json` on the host + `pm2 reload llm-manager`.

## Recipes (curl)

```bash
T=$LLM_API_TOKEN   # never hardcode

# is the API up?
curl -s http://192.168.1.19:8790/health

# what's running?
curl -s -H "Authorization: Bearer $T" http://192.168.1.19:8790/status

# start a model (safe to call repeatedly — idempotent)
curl -s -X POST -H "Authorization: Bearer $T" http://192.168.1.19:8790/start/nemotron30b

# stop it
curl -s -X POST -H "Authorization: Bearer $T" http://192.168.1.19:8790/stop/nemotron30b

# memory headroom — call BEFORE starting another big model
curl -s -H "Authorization: Bearer $T" http://192.168.1.19:8790/memory

# watch startup (vLLM takes a while to load weights)
curl -s -H "Authorization: Bearer $T" "http://192.168.1.19:8790/logs/nemotron30b?tail=50"
```

## Start-response semantics (idempotency)

`POST /start/<name>`:

- **202 `started`** — this call triggered the spawn. Poll `/status/<name>`
  until `state` is `running` (or check `/logs/<name>` for readiness errors).
  vLLM models can take 1–5 min to load.
- **202 `in-progress`** — someone else is already starting it ("We're
  starting an LLM for you"). Do NOT start again; poll `/status`.
- **409 `already-running`** — it's up. Use it immediately; do not retry.
- **404** — model name not in the catalog (check `/models`).
- **500 `error`** — spawn failed; read `message` and `/logs/<name>`.

## Working rules

1. **Never assume a model is stopped** — always `GET /status` first. The API
   re-adopts processes started manually on the host, so state is trustworthy.
2. `X-Status-Refresh: stale|in-progress` means the cache is being refreshed in
   the background; the data you got is at most a few minutes old. For a
   critical "is it really up?" check, poll a second time ~5 s later.
3. Before starting a second large model, check `/memory` → `headroom`
   (available RAM minus declared expectations of models still to start).
   GPU VRAM is reported separately per GPU — vLLM uses `--gpu-memory-utilization`.
4. If a model dies out-of-band it will show `stopped` with `lastError`
   (e.g. OOM-killed) within one sweep (≤25 min) or the next `/status` after
   the cache refreshes.
5. Restarting the API does **not** stop running LLMs — they are re-adopted
   from `/proc` on boot. Only `POST /stop` (or `STOP_CHILDREN_ON_SHUTDOWN=1`
   on pm2 stop) kills them.

## Adding a new model (on the host)

1. Edit `/workspace/llm-manager/models.json` — append:
   ```json
   {
     "name": "my-model",
     "label": "My Model",
     "cwd": "/path/to/working/dir",
     "command": "bash -lc '...the exact launch command...'",
     "port": 8000,            // null if no HTTP endpoint; readiness probe target
     "match": "distinctive-substring-of-the-launch-command",
     "expectedGpuGb": 24,
     "expectedRamGb": 8,
     "readyProbe": { "kind": "port", "ms": 300000 }
   }
   ```
   - `match` MUST be a distinctive substring of the running process's
     cmdline — it's how the API finds and re-adopts the process after a
     restart (e.g. the model checkpoint path or `run.sh` script name).
   - `readyProbe.kind`: `port` waits until `port` accepts connections
     (default for vLLM); `alive` just waits `ms` and requires the process
     to still be alive (for scripts like `run.sh` with no fixed port).
2. Reload: `sudo pm2 reload llm-manager` (or `restart` — reload keeps the
   API process).
3. Verify: `curl /models` shows it, then start it.

## Errors & gotchas

- **401** → token missing/wrong; check `LLM_API_TOKEN` env on the caller.
- **404 on `/start`** → typo in model name or model not in catalog.
- **500 "readiness timeout"** → process spawned but its port never came up in
  `readyProbe.ms`; check `/logs/<name>` — usually OOM or missing checkpoint.
  The child is auto-killed; state is `stopped` with `lastError`.
- **`/memory` has no GPU section** → `nvidia-smi` absent on host; RAM numbers
  are still valid.
- Host RAM is read from `/proc/meminfo` (no exec); GPU via `nvidia-smi`
  (auto-detected). No other external process ever runs.

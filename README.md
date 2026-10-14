# LLM Manager — zero-dependency Node.js LLM control API

Start/stop/monitor local LLMs (vLLM, `run.sh` scripts) on this host over a
small JSON HTTP API. **No npm dependencies** — Node built-ins only.

Hosted at `192.168.1.19:8790`, run under pm2 with admin privileges.

## Quick start

```bash
# on the host (192.168.1.19), as admin:
cd /workspace/llm-manager
npm test                 # node --test, no install needed
sudo pm2 start ecosystem.config.js
sudo pm2 save
```

If `LLM_API_TOKEN` is not set in the pm2 env, one is generated per boot and
printed in the API log — set it in `ecosystem.config.js` to keep it stable.

## API

All endpoints except `/health` need `Authorization: Bearer $LLM_API_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness (open) |
| GET | `/models` | catalog + declared memory footprints |
| GET | `/status` | cached state of all models (`X-Status-Age`, `X-Status-Refresh`) |
| GET | `/status/<name>` | one model |
| POST | `/start/<name>` | idempotent: 202 started / 202 in-progress / 409 already-running |
| POST | `/stop/<name>` | SIGTERM → 10 s → SIGKILL |
| GET | `/memory` | host RAM (`/proc/meminfo`) + optional GPU (`nvidia-smi`) + expected/actual + headroom |
| GET | `/logs/<name>?tail=100` | model stdout/stderr tail |

```bash
T=$LLM_API_TOKEN
curl -s http://192.168.1.19:8790/health
curl -s -H "Authorization: Bearer $T" http://192.168.1.19:8790/status
curl -s -X POST -H "Authorization: Bearer $T" http://192.168.1.19:8790/start/nemotron30b
curl -s -H "Authorization: Bearer $T" http://192.168.1.19:8790/memory
```

## Config

- `models.json` — model catalog. Adding an LLM = add one entry (see
  `skills/llm-manager/SKILL.md` for the full field guide), then
  `sudo pm2 reload llm-manager`.
- Env vars: `LLM_API_PORT` (8790), `LLM_API_HOST` (0.0.0.0),
  `LLM_API_TOKEN`, `SWEEP_INTERVAL_MS` (25 min), `REFRESH_MIN_AGE_MS`
  (5 min), `STOP_GRACE_MS` (10 s), `ENABLE_GPU_PROBE` (auto|on|off),
  `STOP_CHILDREN_ON_SHUTDOWN` (default off — LLMs survive API restarts and
  are re-adopted from `/proc`).

## How it stays honest

- Liveness via `process.kill(pid, 0)` + `/proc/<pid>/stat` (no `ps`, no exec).
- Per-model RSS from `/proc/<pid>/statm`.
- 25-min background sweep + on-demand stale-while-revalidate on `GET /status`.
- Per-model single-flight lock: two concurrent starts can never spawn twice.
- After an API restart, `/proc/*/cmdline` matching re-adopts running LLMs.

See `plan.md` for the full design rationale and `skills/llm-manager/SKILL.md`
for AI-agent usage instructions.

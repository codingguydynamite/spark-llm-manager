# LLM Manager API — Implementation Plan

A zero-dependency Node.js HTTP service that starts/monitors local LLMs (vLLM,
custom `run.sh` scripts) on the host, tracks their state in memory, and
exposes status / start / stop / memory over a small JSON API on the local
network.

**Host:** `192.168.1.19` · **Runtime:** Node.js, no npm dependencies · **Ops:**
pm2, running with admin privileges · **Default port:** `8790` (env-overridable)

---

## 1. Goals & non-goals

### Goals
- Start LLM inference processes on the host (`vllm serve ...`, `run.sh`, ...)
- Track per-model state **in memory** and keep it honest:
  - periodic liveness sweep every **25 min** (configurable)
  - **stale-while-revalidate**: `GET /status` returns the last cached state
    immediately and triggers a fresh check in the background for the next call
- **Idempotent start** with a single-flight lock: a second start request while
  a model is running or being started gets `already running` /
  `we're starting an LLM for you`, never a second process
- Memory visibility: host RAM usage/available (`/proc/meminfo`, pure Node, no
  exec) + per-model RSS + optional GPU memory via `nvidia-smi` probe
- Config-driven model catalog so adding a new LLM = adding a JSON entry
- Auth token so the LAN-open API can't be abused
- **An AI skill file** (`skills/llm-manager/SKILL.md`) teaching any agent how
  to use the API from a remote machine (curl recipes, token handling,
  error interpretation)

### Non-goals (for now)
- No persistent state store — server restart re-discovers running processes
  from `/proc` instead of a DB
- No web UI
- No user accounts / per-client auth — one shared bearer token
- No multi-host federation (single host, `192.168.1.19`)

---

## 2. Key design decisions

### 2.1 Zero external dependencies
Only Node built-ins: `node:http`, `node:child_process`, `node:fs`,
`node:process`, `node:crypto`. No `npm install` at all — `package.json`
declares no dependencies.

### 2.2 Process liveness without `ps` / `grep`
We spawn the LLMs ourselves, so we always hold the **PID**.
- Liveness: `process.kill(pid, 0)` (Node API, no exec) + confirm via
  `/proc/<pid>/stat` exists.
- Per-process RSS: parse `/proc/<pid>/statm` × page size.
- If the API server restarts and loses its PID table, a **recovery scan**
  reads `/proc/*/cmdline` for every model and re-adopts PIDs whose command
  line matches the model's signature (from config `match` field).
- GPU memory: no pure-Node source exists; use `nvidia-smi --query-gpu=...`
  (system binary, not an npm dependency) as an **optional probe** — disabled
  gracefully if the binary is absent. Host RAM (`/proc/meminfo`) is always
  exec-free.

### 2.3 State machine per model
```
stopped ──start──▶ starting ──ready──▶ running
   ▲                  │                  │
   │                  │ (spawn failed)   │ (died / stop called)
   └──────────────────┴──────────────────┘
```
- `starting`: spawn accepted, waiting for readiness (port probe if configured,
  else a short settle delay).
- `running`: liveness confirmed.
- `stopped`: dead / never started, with `lastError` when applicable.
All transitions go through the registry; nothing mutates state ad hoc.

### 2.4 Single-flight start lock (the "prevent double start" requirement)
- `POST /start/<name>` first checks the registry state:
  - `running` → **409** `{ "state": "running", "message": "LLM already running" }`
  - `starting` → **202** `{ "state": "starting", "message": "We're starting an LLM for you" }`
- Only in `stopped` state may a spawn happen; the check + spawn runs under a
  per-model in-memory promise lock (single-flight), so two concurrent
  requests cannot both pass the `stopped` check.
- The spawn child is kept in the registry (`child.kill` target), so `stop`
  works even if the readiness probe hasn't fired.

### 2.5 Cached status with background refresh
- Registry holds `cache: { at: <ts>, entries: [...] }`.
- `GET /status` → returns cache immediately; response headers include
  `X-Status-Age` and `X-Status-Refresh: stale|fresh|in-progress`.
- If cache age > `REFRESH_MIN_AGE` (default 5 min) or a flag says reaped,
  a background sweep is kicked off (single-flight) for the *next* response.
- Hard sweep interval: **25 min** (env `SWEEP_INTERVAL_MS`), reaps dead PIDs
  and updates RSS regardless of traffic.

### 2.6 Memory model per LLM entry
Each model definition declares its footprint so the API can report
"planned vs actual":
- `expectedGpuGb`, `expectedRamGb` — declared expectations
- actual: child RSS from `/proc`, GPU free/used from nvidia-smi probe
- `GET /memory` returns: host total/available/used, per-model expected vs
  actual RSS, GPU totals (when probe active), and `headroom` (available −
  sum of expected of models that would still fit) — useful for "can I
  start one more?" decisions.

### 2.7 Security
- Bearer token required on every endpoint (env `LLM_API_TOKEN`, default
  generated & printed on first boot if unset — LAN convenience, still
  locked down by default).
- `POST` routes reject non-`application/json`/missing token with 401/400.
- No user content is interpolated into shell strings: model commands come
  from `models.json` only; the API accepts **no free-form command input**
  (prevents shell injection by design).
- Binds `0.0.0.0` on `192.168.1.19` so remote LAN clients can reach it.
- pm2 runs it as root/admin on the host (user requirement); note: this is
  intentional here, not a recommendation.

---

## 3. API surface

All responses JSON. Auth: `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness; no auth needed |
| GET | `/models` | static catalog: all configured models + declared memory footprints |
| GET | `/status` | cached state of all models + `X-Status-Age`; triggers bg refresh when stale |
| GET | `/status/<name>` | cached state of one model |
| POST | `/start/<name>` | start; idempotent (202 / 409 as described in 2.4) |
| POST | `/stop/<name>` | SIGTERM → grace 10 s → SIGKILL; 404 if not tracked |
| GET | `/memory` | host + GPU + per-model expected/actual memory |
| GET | `/logs/<name>?tail=100` | tail of the model's log file (spawned with stdout/err redirected) |

Example state entry:
```json
{
  "name": "llama-70b-vllm",
  "state": "running",
  "pid": 41234,
  "startedAt": "2026-10-14T12:00:00Z",
  "port": 8001,
  "rssGb": 118.4,
  "log": "/workspace/llm-manager/logs/llama-70b-vllm.log",
  "lastError": null,
  "cacheAgeMs": 12000
}
```

### Model catalog (`models.json`)
The shipped catalog contains the two known models (full file in
`models.json`; shown here with the Nemotron command abbreviated):

```json
{
  "models": [
    {
      "name": "qwen27b",
      "label": "Qwen 27B — DGX Spark (run.sh)",
      "cwd": "~/Desktop/dgx-spark-qwen38",
      "command": "ENGINE_BIND=0.0.0.0 ./run.sh",
      "port": null,
      "match": "dgx-spark-qwen38",
      "expectedGpuGb": null,
      "expectedRamGb": null,
      "readyProbe": { "kind": "alive", "ms": 30000 }
    },
    {
      "name": "nemotron30b",
      "label": "NVIDIA Nemotron 3.5 Lightning 30B-A3B NVFP4 (vLLM)",
      "cwd": "/",
      "command": "export MODEL_CKPT=nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4\nexport DSPARK_CKPT=...\nvllm serve --model $MODEL_CKPT --host 0.0.0.0 --port 8000 --moe-backend marlin --kv-cache-dtype fp8 ...",
      "port": 8000,
      "match": "NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
      "expectedGpuGb": null,
      "expectedRamGb": null,
      "readyProbe": { "kind": "port", "ms": 300000 }
    }
  ]
}
```
Commands execute via `bash -lc` (login shell), so `export`/env-var usage
works exactly as when typing it in a terminal. The Nemotron entry stores the
full vLLM invocation (marlin backend, fp8 KV cache, speculative decoding via
the DSpark checkpoint, nemotron_v3 reasoning parser, qwen3_coder tool parser)
verbatim.

Field guide for adding a new LLM (vLLM serve or any `run.sh` script):
- `name` / `label` — stable id + human name
- `cwd` — working dir the launch runs in (`~` expands to the admin user's home)
- `command` — exact launch command as a shell string (multi-line OK)
- `port` — readiness-probe target (vLLM serve port); `null` + `alive` probe
  for scripts with no known port
- `match` — distinctive cmdline substring for `/proc` re-adoption
- `expectedGpuGb` / `expectedRamGb` — declared footprint (null until known)
- `readyProbe` — `{kind: 'port'|'alive', ms: timeout}`

---

## 4. Architecture / file layout

```
llm-manager/
├── plan.md                  # this file
├── package.json             # name + start script only; NO dependencies
├── models.json              # model catalog (see §3)
├── ecosystem.config.js      # pm2 config (admin, restart on crash, log paths)
├── server.js                # entry: env → config, builds app, listens
├── lib/
│   ├── config.js            # load+validate models.json & env; defaults
│   ├── registry.js          # in-memory state Map, state machine, single-flight locks, cache
│   ├── process.js           # spawn, kill, liveness (kill(0)+/proc), RSS read, /proc re-adoption
│   ├── sweeper.js           # 25-min interval + on-demand sweep, stale-while-revalidate trigger
│   ├── memory.js            # /proc/meminfo parser; optional nvidia-smi probe (graceful off)
│   └── http.js              # tiny router: JSON parse, auth middleware, route table
├── logs/                    # per-model stdout/err (created at spawn)
└── skills/
    └── llm-manager/
        └── SKILL.md         # AI instructions for remote use (curl recipes, token, errors)
```

Module boundaries:
- `registry` knows nothing about `child_process`; it only holds state, PIDs
  (opaque numbers), and timestamps → unit-testable by mocking.
- `process.js` is the only place that touches `child_process` and `/proc`.
- `http.js` never touches state directly; it calls registry/sweeper methods
  (e.g. `registry.requestStart(name)` returns a discriminated result
  `{started} | {alreadyRunning} | {inProgress}`).
- `sweeper` calls `process.alive(pid)` + `process.rss(pid)` and writes into
  the registry cache under the same single-flight lock as on-demand refresh.

---

## 5. Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `LLM_API_PORT` | `8790` | listen port |
| `LLM_API_HOST` | `0.0.0.0` | bind address |
| `LLM_API_TOKEN` | from gitignored `token.env` (default `TOKEN_FILE`); generated per boot if absent | bearer token |
| `SWEEP_INTERVAL_MS` | `1500000` (25 min) | background liveness sweep |
| `REFRESH_MIN_AGE_MS` | `300000` (5 min) | cache age after which status triggers bg refresh |
| `MODEL_DIR` | `/workspace/llm-manager/models.json` | catalog path |
| `LOG_DIR` | `/workspace/llm-manager/logs` | per-model log dir |
| `TOKEN_FILE` | `/workspace/llm-manager/token.env` | env file holding secrets (`LLM_API_TOKEN`); gitignored, real env vars always win |
| `ENABLE_GPU_PROBE` | `auto` | `auto` (detect nvidia-smi) / `1` / `0` |
| `STOP_GRACE_MS` | `10000` | SIGTERM→SIGKILL grace |

---

## 6. Edge cases handled explicitly

1. **Concurrent start requests** → per-model single-flight lock; second call
   gets 202/409, no second spawn (§2.4).
2. **Spawn fails instantly** (bad script) → child `exit` listener flips state
   to `stopped` with `lastError`; next start retried cleanly.
3. **LLM dies between sweeps** → `GET /status` does the cheap `kill(0)` check
   per tracked PID before serving (cheap, no exec); cache updated inline.
4. **API server restarts** (pm2 crash-restart) → on boot, `/proc` cmdline
   re-adoption scan re-attaches live PIDs; unadopted models report `stopped`.
5. **Orphaned processes after crash** (kill(0) on re-adopted PID is valid) →
   re-adoption covers it; documented in skill for manual `SIGTERM` fallback.
6. **Port collision** (LLM's own port in use) → ready-probe times out →
   state `stopped`, `lastError: "readiness timeout"`, child killed.
7. **Zombies** → `child.on('exit')` + periodic reaper; Node reaps its own
   children.
8. **GPU probe absent** → memory endpoint omits GPU section with a note,
   never errors.
9. **Token leaked** → rotate: edit `token.env` (or `LLM_API_TOKEN` env) and
   `sudo pm2 reload llm-manager`; documented in skill.

---

## 7. Implementation phases (order matters; each ends verified)

**Phase 0 — Skeleton** (~small)
`package.json`, `server.js` boot, `/health`, pm2 `ecosystem.config.js`.
Verify: `pm2 start ecosystem.config.js`, curl `/health` from another LAN
machine (or `192.168.1.19:8790`).

**Phase 1 — Config + registry**
`lib/config.js` (validate `models.json`), `lib/registry.js` (state machine +
single-flight + cache). Verify: unit-style script asserting state
transitions and that two concurrent `requestStart` calls yield one spawn.

**Phase 2 — Process manager**
`lib/process.js`: spawn with log redirection, `alive()`, `rss()`, `stop()`,
`/proc` re-adoption scan. Verify: start a dummy `sleep` model, kill it,
confirm state flips; restart API, confirm re-adoption.

**Phase 3 — HTTP API + auth**
`lib/http.js` + wire all routes incl. `POST /start` idempotent semantics.
Verify: hammer `POST /start` 10× in parallel → exactly one process;
repeat after ready → all 409.

**Phase 4 — Sweeper + stale-while-revalidate**
`lib/sweeper.js`: 25-min timer + on-demand single-flight refresh; status
headers (`X-Status-Age`, `X-Status-Refresh`). Verify: stale cache returned
immediately, fresh after bg sweep; kill a model out-of-band, next status
call shows `stopped`.

**Phase 5 — Memory endpoint**
`lib/memory.js` (`/proc/meminfo`; optional `nvidia-smi`), `GET /memory`
with expected-vs-actual + headroom. Verify: numbers match `free -h` /
`nvidia-smi` on the host.

**Phase 6 — Real models + logs**
Add actual vLLM / `run.sh` entries to `models.json`; `GET /logs/<name>`.
Verify: start a real model, watch it come to `running` via port probe,
stop cleanly.

**Phase 7 — AI skill + docs**
`skills/llm-manager/SKILL.md`: who/where (`192.168.1.19:8790`), token via
env (never hardcode), curl recipes for status/start/stop/memory, idempotency
semantics ("if 202, poll /status; if 409, it's up — don't retry"), error
table, adding new models (edit models.json + pm2 reload).
Verify: a fresh agent session following *only* the skill can start and stop
a model remotely.

**Phase 8 — Hardening**
Graceful shutdown (SIGTERM → stop tracked children, `pm2 stop`), log
rotation for `logs/`, `pm2` log path config, final end-to-end checklist run.

---

## 8. Ops (pm2)

`ecosystem.config.js`:
```
name: llm-manager
script: server.js
cwd: /workspace/llm-manager
env: { LLM_API_PORT: 8790, SWEEP_INTERVAL_MS: 1500000, ENABLE_GPU_PROBE: auto }
out_file/err_file: /workspace/llm-manager/logs/api-{out,err}.log
restart: true, max_restarts: 10, wait_ready: false
```
- Run under the host's admin user (user requirement; API needs to see all
  `/proc` entries and start vLLM under admin).
- `pm2 save` after first good start; consider `pm2 startup` for boot.

---

## 9. Verification checklist (definition of done)

- [ ] API reachable from a different LAN machine: `curl http://192.168.1.19:8790/health`
- [ ] `POST /start` ×10 parallel → 1 process; repeat → 409
- [ ] `POST /start` while `starting` → 202 "we're starting an LLM for you"
- [ ] `GET /status` sub-ms from cache, `X-Status-Refresh: in-progress` on stale
- [ ] Kill LLM out-of-band → reflected in next `GET /status`
- [ ] Restart API (pm2) → running LLMs re-adopted, still reported `running`
- [ ] `GET /memory` host numbers match `free -h`; GPU section correct or absent cleanly
- [ ] New model added via `models.json` only → `pm2 reload` → startable
- [ ] Skill file: remote agent session starts + stops a model using only the skill
- [ ] No npm dependencies: `npm ls` shows zero; server boots on a clean Node install

---

## 10. Open questions / assumptions (flag before Phase 1 if wrong)

- Port `8790` free on `192.168.1.19`? (assumed yes; env-overridable anyway)
- LLM processes run as **admin/root** on that host (assumed, matches pm2
  admin requirement)
- `nvidia-smi` present for GPU probe (auto-detected; fine if not)
- Token shared-secret is acceptable security posture for a trusted LAN
- Node version on host ≥ 18.2 (uses only long-stable built-ins; `process.kill`
  signal-0 semantics unchanged)
- Qwen 27B `run.sh` has no fixed HTTP port → uses `alive` readiness probe
  (30 s) instead of a port probe; if the script later exposes a known port,
  switch `readyProbe` to `port` for faster, more reliable readiness.

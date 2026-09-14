# sparkDash ⚡ — Multi-unit monitoring dashboard for NVIDIA DGX Spark

<p align="center">
  <img src="https://img.shields.io/badge/platform-arm64-2d9d78?style=flat-square" alt="Platform: ARM64">
  <img src="https://img.shields.io/badge/React-19-58c4dc?style=flat-square&logo=react" alt="React 19">
  <img src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express" alt="Express 5">
  <img src="https://img.shields.io/badge/license-MIT-2d9d78?style=flat-square" alt="MIT License">
  <br>
  <sub>by <a href="https://x.com/MiaAI_lab">Mia'a AI Lab</a></sub>
  <br><br>
  <a href="https://x.com/MiaAI_lab" target="_blank" style="display:inline-block;margin:0 8px;vertical-align:middle;"><img src="https://img.shields.io/badge/Follow%20me%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow Mia on X" height="28" style="height:28px;width:auto;vertical-align:middle;border:0;" /></a>
</p>

sparkDash is a real-time web dashboard for one or more **NVIDIA DGX Spark (GB10)** machines in a single browser window. It streams GPU, CPU, unified memory, storage, network, and local LLM metrics — and lets you add, edit, reorder, or remove Sparks from the UI without restarts or code changes.

It also supports **non-Spark units**: any Linux machine with an NVIDIA GPU (e.g. a workstation with a dedicated RTX/L-series card) can be added as a **dedicated GPU host** and monitored the same way via SSH and `nvidia-smi`. For these units the dashboard correctly separates **RAM** (system memory) from **VRAM** (discrete GPU memory).

<img src="./assets/screenshot.jpg" alt="sparkDash Overview page with multiple DGX Spark units, GPU metrics, and LLM status">

---

## ⭐ Why this fork exists (styles01 fork)

**This is not a cosmetic fork — it is the production-monitoring branch for a real GB10 serving stack.**
Upstream sparkDash monitors Spark hardware; this fork extends it into a **full LLM-serving cockpit** for the
Qwen3.8-Flash-Next lanes documented in [`styles01/sparkrun-recipes`](https://github.com/styles01/sparkrun-recipes)
(daily driver: Mia-AiLab NVFP4 + MTP3 + custom 47k draft vocab, 262K ctx; alternate lane: the DwarfStar ds4 C engine).

**What this fork adds on top of upstream:**

- **ds4 / DwarfStar engine support** — native probe for the `ds4.c` C-engine HTTP server:
  backend auto-detection (`owned_by: ds4.c`), `GET /metrics` + `/v1/stats` parsing
  (`ds4_decode_tok_s`, `ds4_prefill_tok_s`, `ds4_spec_accept_ratio`, `ds4_banks_*`, `ds4_kv_pages_resident`),
  plus engine-side upgrades we ported back into the engine so the dashboard has something to read:
  a self-contained Prometheus metrics emitter and a `/v1/stats` JSON endpoint with
  `reasoning_effort` / `thinking_enabled`.
- **Real reasoning-effort display** — reads the engine's actual effort from `/v1/stats`
  instead of guessing `"high"` from log patterns; per-engine effort semantics (ds4: none/high/max).
- **LLM panel upgrades** — per-position MTP acceptance bars, spec-accept totals + ratio,
  prefix-cache hit rate, KV cache %, active lanes, prefill cached/computed split,
  TTFT+E2E latency chart, decode/prefill throughput chart with fixed scales,
  thinking badge ("ACTIVELY THINKING"), data-availability-gated cards (missing backends render `—`, never blank).
- **VllmMetricsParser.js** — a dedicated vLLM Prometheus parser (`vllm:*` series) with
  prefix-cache, spec-decode, and per-stream rate derivation; upstream now absorbs parts of
  our earlier inline parsers back into helpers.
- **Multi-backend, one panel** — vLLM, SGLang, llama.cpp, and ds4 backends detected by probe,
  all rendered through the same card set keyed on data presence (no per-backend panels).

**Screenshot of the fork in production** (Qwen3.8-Flash-Next on vLLM, live agent traffic):

![sparkDash fork — Qwen3.8-Flash-Next vLLM lane, MTP3 + draft vocab](./assets/screenshot-styles01-qwen38-vllm.jpg)

Upstream's features are all retained (multi-Spark, ComfyUI, Hermes, Tailnet monitoring, bench tools).
This fork rebases onto upstream `main` regularly; the rebase workflow lives in
`docs/` if you want to maintain a similar fork.


### LLM Prompt Showcase

<a href="https://github.com/MiaAI-Lab/sparkDash/releases/download/media-showcase/llm-showcase.mp4">
  <img src="./assets/llm-showcase.gif" alt="LLM Prompt Showcase — multi-terminal streaming demo (click for MP4)" width="100%">
</a>

<p align="center"><sub><a href="https://github.com/MiaAI-Lab/sparkDash/releases/download/media-showcase/llm-showcase.mp4">Download MP4</a> · also in <code>assets/llm-showcase.mp4</code></sub></p>

---

## Table of contents

- [Latest version changelog](#latest-version-changelog)
- [Features](#features)
- [ComfyUI monitoring](#comfyui-monitoring)
- [Hermes Agent monitoring](#hermes-agent-monitoring)
- [Tailnet monitoring](#tailnet-monitoring)
- [Full changelog](./CHANGELOG.md)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [REST API](#rest-api)
- [Configuration](#configuration)
- [Security](#security)
- [Scripts](#scripts)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

---

## Latest version changelog

### Version 1.7.0 — DS4 CUDA telemetry, synthwave theme, 42-card grid
- **DS4 CUDA Engine support** — full telemetry for Entrpi/ds4-on-spark v0.6.2: DSpark acceptance, banks/lanes, memory census, reasoning effort, active context, provenance ("Built by @bleysg")
- **Synthwave theme** — purple/magenta/green temperature scale color spectrum for LLM panel
- **Radial odometers** — Avg & Peak tok/s as car-speedometer gauges (max=100)
- **42-card advanced grid** — all available metrics in dense 8-column layout
- **Config & provenance at top** — engine type, model, author accreditation, config badges, collapsible params
- **Per-position spec decode** — always visible, synthesized for DS4 from overall ratio
- **Backend-adaptive panel** — cards populate from data availability, not hardcoded backend names
- **Graph yMax=100** — throughput scale capped at 100 tok/s

### Version 1.6.0 — ComfyUI monitoring & compact default
- **ComfyUI** — opt-in per Spark (port 8188): live jobs, progress, last run, cancel, queue ETA, Open on LAN IP, model inventory
- **Overview** — Comfy status chip (`idle` / `run` / `Nq`)
- **Layout** — collapsible Resources / Services; LLM + Comfy side-by-side; multi-LLM row rules
- **Compact UI** — default density (comfortable still in Settings)

Full history: [CHANGELOG.md](./CHANGELOG.md)

---

## Features

| Area | What you get |
|------|----------------|
| **Multi-unit** | Any number of units; each has a tabbed detail page plus a shared Overview |
| **Non-Spark GPU hosts** | Linux boxes with a dedicated NVIDIA GPU are first-class units: same `nvidia-smi` collectors over SSH, detected hardware summary, and separate **RAM** / **VRAM** panels. Detail page: GPU (left) + **RAM → Network → Storage** (right column); Overview cards show RAM and VRAM bars |
| **Live streaming** | WebSocket metrics with configurable poll intervals; central history store for sparklines across tab switches |
| **Local + remote** | Host metrics via sysfs/proc/`nvidia-smi`; remotes over SSH (key or password) |
| **LLM probe** | Auto-detects llama.cpp, vLLM, sglang, or ds4-server; 40+ live telemetry metrics, per-position spec decode, radial odometers, provenance/accreditation |
| **ComfyUI** | Opt-in probe: queue/jobs, progress, cancel, Open link, inventory, overview chip |
| **Hermes Agent** | Opt-in per unit: background update check (10 min), status badges, one-click or batch `hermes update` |
| **Tailnet** | Opt-in probe: flags a unit that is healthy on the LAN but off its tailnet |
| **Decode benchmark** | Multi-concurrency streaming decode tok/s; type picker (Structured / Prose / Code / JSON); lab protocol (temp 0, thinking off); persisted last run. Remote units: LAN HTTP, or SSH tunnel to loopback. **Remote** button for an on-demand HTTPS/host:port target |
| **Prefill benchmark** | Context-size sweep (1k–300k) of prefill tok/s and TTFT; unique prefix per size; persisted last run. Same remote targeting as decode |
| **Prompt Showcase** | Full-page multi-terminal LLM streaming demo (up to 32 prompts) with live tok/s and copy-out |
| **LLM inference health** | KV cache %, run/wait queue, TTFT/E2E/ITL p95, preemptions, prefix cache, MTP accept from Prometheus `/metrics` (vLLM and q27; q27 FIFO-queues so the Requests tile reads “N run” without a wait gauge) |
| **Multiple LLM ports** | Monitor several LLM servers on different ports simultaneously — each gets its own panel with independent backend detection and metrics |
| **GPU processes** | See the top GPU processes by VRAM usage directly in the GPU panel, including process name and memory allocation |
| **Spark uptime** | System uptime displayed inline on each Spark header for at-a-glance availability |
| **Power controls** | Graceful shutdown (SSH host script) and Wake-on-LAN; batch actions on Overview |
| **Spark roles** | **Head** / **Worker** / **Standalone** — worker label + head link; standalone can disable LLM monitoring |
| **Unified memory** | GB10 128 GB LPDDR5X pool (~273 GB/s), GPU/CPU split, bandwidth via `nvidia-smi dmon` |
| **Themes** | Dark, light, cool white, OLED, **Synthwave** (purple/magenta/green temperature scale) — persisted in `localStorage` |
| **Secrets** | SSH passwords AES-256-GCM encrypted; never in `sparks.json` or API responses |
| **Docker-first** | Single privileged container for host metrics; prod and dev Compose files |
| **Hot config** | Add / edit / remove / reorder Sparks from the UI with no process restart |

---

## ComfyUI monitoring

sparkDash can **optionally** monitor a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance on each Spark — the same way it probes local LLMs, but focused on **jobs and queue**, not a second copy of GPU/RAM bars (those stay on the GPU / CPU panels).

### What is supported

| Capability | Details |
|------------|---------|
| **Opt-in per Spark** | `comfyMonitoring` (default **off**) + `comfyPort` (default **8188**) |
| **Any role** | Head, worker, and standalone can enable ComfyUI independently of LLM cluster role |
| **Liveness** | `GET /system_stats` — online, ComfyUI / PyTorch version, device type (cpu/cuda) |
| **Queue / jobs** | `GET /queue` — running + pending items; workflow **title**, **model/LoRA** filenames from the graph, footprint (**resolution · steps · sampler · batch · node count**) |
| **Progress** | Progress bar on the active job — Comfy WebSocket when events are available; otherwise elapsed / average-duration **estimate** |
| **Last finished job** | Status + duration via `/api/jobs` (fallback `/history`) |
| **Queue ETA** | Estimate from recent job durations × pending (+ progress remainder when known) |
| **Cancel / remove** | From the Comfy card: interrupt a running job or dequeue a pending one (`POST /api/sparks/:id/comfy/cancel`) |
| **Open ComfyUI** | One-click link to `http://{lanIp}:{comfyPort}` (LAN IP preferred so remote browsers do not hit localhost) |
| **Model inventory** | Checkpoints + LoRAs from `/models/*` (UI section only when at least one file is listed) |
| **Overview chip** | When monitoring is on: `Comfy · idle` / `run` / `Nq` / muted if unreachable |
| **Layout** | Under **Services**: primary LLM + Comfy side-by-side when both are enabled; collapsible **Resources** / **Services** sections |

**Not claimed:** true per-job VRAM (Comfy does not expose that cleanly over HTTP). Host GPU/VRAM remains on the GPU panel. Live step progress depends on Comfy broadcasting WS events; stock Comfy often scopes detailed progress to the client that submitted the prompt.

### How to enable (per Spark)

1. Open the Spark tab → **Edit** (pencil).
2. Enable **ComfyUI monitoring**.
3. Set **port** if needed (default **8188**).
4. **Save**.

The Spark page **Services** section shows the ComfyUI card. On Overview, a small Comfy chip appears for that unit.

**Connectivity Test** (in Edit) includes ComfyUI when monitoring is enabled.

### ComfyUI side requirements

- ComfyUI must be reachable from the **sparkDash server** on the probe host:
  - **Local Spark** (`isLocal`): sparkDash probes `127.0.0.1:{port}` (use Docker `network_mode: host` if the dashboard runs in a container).
  - **Remote Spark**: probe uses the Spark **LAN IP** (same as LLM probes).
- For **Open** from another machine’s browser, Comfy should listen on a reachable interface (e.g. `--listen 0.0.0.0`), not only loopback, and the Spark’s **LAN IP** must be set correctly in Edit.

### Config fields (persisted on the Spark)

| Field | Default | Description |
|-------|---------|-------------|
| `comfyMonitoring` | `false` | Probe ComfyUI and show the card / overview chip |
| `comfyPort` | `8188` | ComfyUI HTTP port |

### Related API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sparks/:id/comfy/cancel` | Cancel a job (`{ "promptId": "<uuid>" }`) — interrupt running and/or remove from queue |

Env (optional): `COMFY_PORT` (default `8188`), `COMFY_PROBE_TIMEOUT_MS`, `POLL_INTERVAL_COMFY`.

---

## Hermes Agent monitoring

sparkDash can **optionally** monitor [Hermes Agent](https://github.com/nousresearch/hermes-agent) (nousresearch/hermes-agent) on each unit and run one-click updates for you over SSH.

### What is supported

| Capability | Details |
|------------|---------|
| **Opt-in per Spark** | `hermesMonitoring` (default **off**) in **Edit Spark** |
| **Auto update check** | Background `hermes update --check` over SSH (default every 10 min) — returns update availability + pending commits |
| **Status badges** | In the Spark header: `Hermes` (installed version), `Hermes not found` if the binary is missing |
| **One-click update** | **Update Hermes** button opens a dialog with live status, real pending commits, and release notes; **Update now** runs `hermes update` via SSH (non-interactive go) |
| **Update state** | Running / success / error surfaced live (button turns into a “Hermes updating… / failed” state) |
| **Batch update** | **Update Hermes** on Overview runs `hermes update` on every monitored unit, with a live per-unit progress bar |

### How to enable (per Spark)

1. Open the Spark tab → **Edit** (pencil).
2. Enable **Hermes Agent**.
3. **Save** — background checks start immediately.

The **Update Hermes** button appears in the Spark header/mobile action row; it turns warning-yellow with a commit-count badge only when an update is actually available. It also appears on Overview (batch) when at least one unit has Hermes enabled.

**Connectivity check note:** local units run the check as the **host user** (via `setpriv`/`nsenter`, never as container root); remote units run it over SSH. Either way, the logged-in user needs permission to read the Hermes repo.

### Side requirements

- **Hermes Agent must be installed on the target machine** — sparkDash only checks & updates; it does not install it. The binary is looked up in `~/.local/bin` and `/usr/local/bin`.
- SSH user must be able to run `hermes update --check` / `hermes update` non-interactively (key auth recommended).
- An update can take a few minutes (repo pull + dependency reinstall); a stale `*.lock` file from a crashed run is cleared before each attempt.

### Config fields (persisted on the Spark)

| Field | Default | Description |
|-------|---------|-------------|
| `hermesMonitoring` | `false` | Check/update Hermes Agent on this machine |

### Related API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sparks/hermes/update-all` | Batch `hermes update` on every monitored Spark (Overview button) |
| POST | `/api/sparks/:id/hermes/check` | Force `hermes update --check` now |
| POST | `/api/sparks/:id/hermes/update` | Run `hermes update` in the background (202) |
| GET | `/api/sparks/:id/hermes/updates` | Update preview: latest release + installed version + real pending commits + resolved view |

Env (optional): `POLL_INTERVAL_HERMES` (default `600000` ms), `HERMES_UPDATE_TIMEOUT_MS` (default `600000` ms).

---

## Tailnet monitoring

Opt-in per unit (default **off**). Runs `tailscale status --json` on the host and shows a **Tailnet** card under Resources.

This closes a blind spot every LAN-based check shares, including sparkDash's own SSH liveness. When `tailscaled` loses its session with the coordination server, SSH/GPU/LLM can all stay healthy while the box is unreachable from off-LAN.

### What is supported

| Capability | Details |
|------------|---------|
| **Opt-in per unit** | `tailscaleMonitoring` (default **off**) in **Edit Spark** |
| **Off-tailnet detection** | `Self.Online` — the node's *own* view of the coordination server |
| **Reason, not just state** | Tailscale `Health` messages, backend state, tailnet IP, DERP relay, version, expired-key warning |

Asked of **each node about itself**. Peer state is never the verdict. The probe is read-only (`tailscale up` / `down` / `login` are never run).

### How to enable

1. Open **Edit Spark**.
2. Tick **Tailnet monitoring**.
3. Save. The Tailnet card appears under Resources.

### Host requirements

- `tailscale` CLI on the monitored host, and `tailscaled` running.
- Remote units: existing SSH. Local Docker: `nsenter` into the host mount namespace (same as `nvidia-smi`; `/host/proc` is already bind-mounted).

### Config fields

| Field | Default | Description |
|-------|---------|-------------|
| `tailscaleMonitoring` | `false` | Run `tailscale status --json` and show the Tailnet card |

Env (optional): `POLL_INTERVAL_TAILSCALE` (default `30000`), `TAILSCALE_PROBE_TIMEOUT_MS` (default `8000`).

---

## Quick start

```bash
git clone https://github.com/MiaAI-Lab/sparkDash.git
cd sparkDash

# Production (Docker; loopback-only by default)
docker compose up --build -d

# Or development (host, with hot reload)
npm install
npm run dev
```

- **Docker**: open **http://127.0.0.1:5555** on the host (arm64 image, auto-restart, host mounts for GPU/metrics access)
- **Dev**: Vite on **http://localhost:5173** (proxies API/WS to Express)

For another computer, keep the server on loopback and use an SSH tunnel:

```bash
ssh -N -L 5555:127.0.0.1:5555 user@sparkdash-host
```

Then open `http://127.0.0.1:5555` on that computer. For shared access, use an authenticated TLS reverse proxy, Tailscale Serve, or set `BIND_HOST=0.0.0.0` **and** `SPARKDASH_TOKEN`. Direct LAN bind without a token fails closed. Previous `http://<host-ip>:5555` installs must migrate.

For development with Docker (source-mounted, HMR):
```bash
docker compose -f docker-compose.dev.yml up --build
```

**Remote units + SSH keys (Docker):** SSH is executed *inside* the container on the sparkDash host (typically the head DGX). Configured LAN IPs are from **that** host’s point of view, not your laptop. OpenSSH looks for keys under `/root/.ssh` in the container — the host user’s `~/.ssh` is not used unless you bind-mount it. Uncomment this volume in `docker-compose.yml` (and recreate the container):

```yaml
- ${HOME}/.ssh/id_ed25519:/root/.ssh/id_ed25519:ro
```

If the key file has a non-default name (e.g. `id_ed25519_shared`), mount it **as** `id_ed25519`, or set `SSH_IDENTITY_FILE` to the path inside the container. Keep the file mode `600`. The unit that runs sparkDash itself should be added with **This host (local collectors — no SSH for metrics)**.

---

## Architecture

Design principle: **one Spark model, N instances**. Every unit is a record in `config/sparks.json` with a `kind` field (`spark` or `host`). The same `SparkMonitor`, `SystemCollector`, and `LlmProbe` code runs for all of them. Adding a unit is a config change, not a code change.

```txt
┌────────────────────── Docker container (sparkDash) ────────────────────────┐
│  Express (server/)                                                         │
│  ├─ config/sparks.json        Spark registry (API read/write)              │
│  ├─ SparkRegistry             load/persist Sparks; change events           │
│  ├─ SparkMonitor (per Spark)  collector + LLM probe + rate baselines       │
│  │   ├─ SystemCollector       local sysfs/proc OR remote SSH               │
│  │   └─ LlmProbe              HTTP to host:LLM_PORT, backend autodetect    │
│  ├─ REST /api/*                                                            │
│  └─ WebSocket /ws             snapshot stream to browsers                  │
│  React SPA (src/)  — Overview + per-Spark pages, themes, dialogs           │
└────────────────────────────────────────────────────────────────────────────┘
         │ SSH (key or sshpass)                    │ HTTP :8888
         ▼                                         ▼
    remote Spark(s)                         each Spark’s LLM server
```

### Data flow

```txt
Browser  ←→  WebSocket /ws   ←→  SparkMonitor.snapshot()  ←→  collectors
Browser  ←→  REST /api/*     ←→  SparkRegistry + SparkMonitor
```

Poll loops run in the background (even with no clients) so rate metrics — tokens/s, network bytes/s, disk I/O — stay correct.

---

## Tech stack

| Layer | Stack |
|-------|--------|
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS v4 |
| Backend | Node.js (ESM), Express 5, `ws` |
| Platform | ARM64 — DGX Spark GB10 (Neoverse V2) |
| Deploy | Docker multi-stage (arm64), Compose |
| Secrets | AES-256-GCM SSH password store |
| Ports | **5555** dashboard/API; **5173** Vite (dev only) |

---

## Repository layout

```txt
sparkDash/
├── src/                 React + TypeScript SPA
│   ├── api/             REST client + shared types
│   ├── components/      Overview, Spark pages, dialogs, UI primitives
│   ├── hooks/           WebSocket snapshot, routing
│   └── theme / CSS      Tailwind v4 + four themes
├── server/              Express + WebSocket (plain JS ESM)
│   ├── sparks/          SparkRegistry, SparkMonitor
│   ├── collectors/      SystemCollector, LlmProbe, ssh
│   ├── secretsStore.js  Encrypted password persistence
│   └── validate.js      Host/user validation (SSRF-minded)
├── config/              Runtime state (volume; secrets gitignored)
├── assets/              Screenshots
├── Dockerfile           Production multi-stage arm64
├── docker-compose.yml   Production
├── docker-compose.dev.yml
└── deploy.sh            Rebuild / recreate helpers
```

---

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sparks` | List Sparks (passwords redacted) |
| POST | `/api/sparks` | Add Spark and start its monitor |
| PATCH | `/api/sparks/:id` | Update Spark (hot-swap config) |
| DELETE | `/api/sparks/:id` | Remove Spark and drain monitor |
| PUT | `/api/sparks/order` | Persist tab order |
| GET | `/api/sparks/:id/metrics` | One-shot metrics snapshot |
| GET | `/api/fleet-energy` | Estimated fleet watts, rolling energy, coverage, and Wh/output-token |
| POST | `/api/sparks/test` | Ephemeral SSH + LLM (+ Comfy if enabled) test (no persist) |
| POST | `/api/sparks/:id/test` | Connectivity test (can save password) |
| POST | `/api/sparks/:id/comfy/cancel` | Cancel ComfyUI job by `promptId` |
| PUT | `/api/sparks/:id/password` | Save SSH password (works offline) |
| PUT | `/api/sparks/:id/disabled-devices` | Hide storage devices (hot) |
| PUT | `/api/sparks/:id/disabled-interfaces` | Hide network interfaces (hot) |
| PUT | `/api/sparks/:id/llm-ports` | Replace all LLM ports (hot) |
| POST | `/api/sparks/:id/llm-ports` | Add an LLM port (hot) |
| DELETE | `/api/sparks/:id/llm-ports/:port` | Remove an LLM port (hot) |
| PUT | `/api/sparks/:id/llm-port` | LLM port — backward-compat (hot) |
| GET | `/api/sparks/:id/llm/daily` | Daily busy decode/prefill tok/s (`port`, `days`) |
| POST | `/api/sparks/:id/llm/bench` | Start decode benchmark (202); poll/cancel/clear on the same path |
| POST | `/api/sparks/:id/llm/prefill-bench` | Start prefill + TTFT context sweep (202); poll/cancel/clear on the same path |
| GET | `/api/settings` | Global settings |
| PUT | `/api/settings` | Update global settings |
| WS | `/ws` | Real-time metrics stream |

There is no application authentication on the HTTP/WebSocket API. sparkDash therefore binds to loopback and refuses direct LAN binding. Use an SSH tunnel, authenticated TLS reverse proxy, or Tailscale Serve; see [Remote access](./docs/REMOTE-ACCESS.md).

`/api/fleet-energy` samples the configured fleet independently every two seconds. It estimates
each node as GPU board draw + a CPU utilization model (5.2–65 W) + 23 W of memory/network/base
overhead, clamped to the DGX Spark power envelope. Current and hourly fleet watts require fresh,
simultaneous telemetry from every node; coverage fields make gaps explicit. Minute buckets are
persisted at mode `0600` for rolling 24-hour and 31-day windows. Wh/output-token is reported when
exactly one configured node has role `head` and exposes a monotonic LLM output-token counter.
These values are estimates, not wall-meter measurements. Restart sparkDash after changing fleet
membership so the persisted series has one stable node set.

---

## Configuration

### Global settings (UI or API)

Gear icon in the header, or `GET`/`PUT` `/api/settings`:

| Setting | Default | Description |
|---------|---------|-------------|
| Poll interval | 2000 ms | WebSocket broadcast interval (minimum 1000 ms) |
| Default LLM port | 8888 | Default for new Sparks |
| Auto-hide offline | false | Hide offline Sparks on Overview |
| Hide worker nodes | false | Hide Worker-role Sparks from Overview and the tab bar |
| Temperature unit | Celsius | Display GPU temperature in °C or °F |

### Environment variables

Copy `.env.example` to `.env` if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `BIND_HOST` | `127.0.0.1` | HTTP and WebSocket listen address. Non-loopback bind requires `SPARKDASH_TOKEN`. |
| `SPARKDASH_TOKEN` | _(empty)_ | Bearer token required for mutations and remote telemetry when not on loopback. |
| `PORT` | `5555` | HTTP + WebSocket listen port |
| `LLM_PORT` | `8888` | Default LLM probe port |
| `COMFY_PORT` | `8188` | Default ComfyUI probe port |
| `POLL_INTERVAL_GPU` | `2000` | GPU poll (ms) |
| `POLL_INTERVAL_COMFY` | `2000` | ComfyUI probe poll (ms) |
| `POLL_INTERVAL_CPU` | `2000` | CPU / RAM poll (ms) |
| `POLL_INTERVAL_NETWORK` | `2000` | Network poll (ms) |
| `POLL_INTERVAL_STORAGE` | `5000` | Storage poll (ms) |
| `POLL_INTERVAL_LLM` | `2000` | LLM probe poll (ms) |
| `POLL_INTERVAL_BANDWIDTH` | `2000` | Memory bandwidth / dmon poll (ms) |
| `POLL_INTERVAL_HERMES` | `600000` | Hermes Agent update check poll (ms) |
| `POLL_INTERVAL_TAILSCALE` | `30000` | Tailnet probe poll (ms) |
| `TAILSCALE_PROBE_TIMEOUT_MS` | `8000` | Timeout for `tailscale status --json` (ms) |
| `POLL_INTERVAL_NVERR` | `60000` | Kernel journal scan for NVRM `NV_ERR_NO_MEMORY` (ms) |
| `HERMES_UPDATE_TIMEOUT_MS` | `600000` | Hard timeout for running `hermes update` over SSH (ms) |
| `POLL_INTERVAL_LIVENESS` | `5000` | Online/SSH liveness check (ms) |
| `SPARKDASH_SECRETS_KEY` | _(auto)_ | Passphrase or 64-char hex for secret encryption |
| `HOST_PROC_PATH` | `/host/proc` | Host proc mount inside container |
| `HOST_SYS_PATH` | `/host/sys` | Host sys mount |
| `HOST_ROOT_PATH` | `/host/root` | Host root mount |
| `SSH_IDENTITY_FILE` | _(unset)_ | Path **inside the process** to a private key (`ssh -i`). Use when the bind-mount is not a default OpenSSH name. |
| `SSH_CONTROL_PERSIST_SECONDS` | `60` | Reuse authenticated SSH transports for remote collectors. Set to `0` to disable multiplexing. |
| `FLEET_ENERGY_JSON_PATH` | `config/fleet-energy.json` | Rolling fleet-energy persistence path |

> The listener and both Compose files default to `127.0.0.1`. Existing Docker users who opened
> `http://<host-ip>:5555` must migrate to an SSH tunnel, authenticated reverse proxy, Tailscale
> Serve, or `BIND_HOST=0.0.0.0 SPARKDASH_TOKEN=...`. Recovery:
> `BIND_HOST=127.0.0.1 docker compose up -d --force-recreate`.

### Adding a unit

1. Open the **+** tab.
2. Choose **Unit type**:
   - **NVIDIA DGX Spark** — the default; hardware summary shows DGX Spark specs and the CX7 IP field is available.
   - **Dedicated GPU host** — any Linux machine with an NVIDIA GPU. It is monitored exactly like a Spark (SSH + `nvidia-smi`) but is **not** reported as a DGX Spark: the header shows a detected hardware summary (GPU model, CPU, RAM) instead of fixed GB10 specs, and the page shows separate **RAM** and **VRAM** panels (VRAM from `nvidia-smi`, RAM from system memory). On the unit page, RAM → Network → Storage stack in the right column with GPU filling the left column.
3. Set **Name** and choose whether this is **This host**. Local units do not require a LAN IP or SSH; their optional LAN IP enables browser links and directed Wake-on-LAN. Remote units require a LAN IP/host, SSH user, and key or password. Key auth in Docker needs a key mounted into the container (see Quick start).
4. **Test** shows pass/fail/skipped for host collectors/SSH and each enabled service (LLM, ComfyUI, Hermes Agent, Tailnet). Every enabled capability must pass; disable an unavailable optional service before saving if it should not be monitored.
5. Save — a tab appears and metrics start streaming.

### Power controls (shutdown / Wake-on-LAN)

- **Shutdown** (per Spark or **Shutdown All** on Overview) runs over SSH:  
  `sudo -n /usr/local/bin/spark-shutdown`  
  Install that script on each Spark and allow passwordless sudo for it only.
- **Wake** / **Wake All** send a UDP magic packet (port 9). The MAC is taken from the **enP7s7** interface automatically while the Spark is online (persisted as `detectedMacAddress`). Optionally set a **MAC override** in Edit Spark. Broadcast is derived as `/24` from LAN IP, or `255.255.255.255` if LAN IP is missing.
- Batch shutdown only targets **online** Sparks; offline nodes are skipped.
- Power APIs are mutations: on loopback they follow the local-trust model; a remote bind requires `SPARKDASH_TOKEN`.

### Themes

Header theme control cycles:

| Theme | Notes |
|-------|--------|
| **Dark** (default) | Neutral grays, true black base, muted amber accent |
| **Light** | Warm paper whites |
| **White** | Cool neutral whites |
| **OLED** | True black for OLED panels |
| **Synthwave** | Purple/magenta/green temperature scale — no red/orange/yellow. Brightness conveys intensity. Neon green = fast, hot pink = medium, purple = slow. Cyan = latency/cool metrics. |

> **Synthwave theme** — a custom color spectrum designed for at-a-glance LLM telemetry. Instead of red/green/yellow, it uses a temperature scale: purple/blue (cold/slow) → magenta/pink (warm/medium) → neon green (hot/fast). Cyan represents latency and cool metrics. The entire LLM panel — stat cards, gauges, charts, sparklines — follows this spectrum so you can read performance by color alone.

Choice is stored in `localStorage`.

---

## Security

- **SSH passwords** are not stored in `sparks.json` and are never returned by the API.
- Passwords are encrypted with **AES-256-GCM** in `config/sparks-secrets.json` (survives restarts).
- Encryption key: `config/.secrets-key` (auto-generated) or `SPARKDASH_SECRETS_KEY`. **Do not delete the key file** or encrypted secrets become unreadable.
- **Target validation** rejects clearly unsafe IPv4 targets (link-local `169.254.0.0/16`, `0.0.0.0/8`, multicast/reserved ≥ 224). Private, loopback, and public addresses are allowed so LAN and remote Sparks work.
- SSH and HTTP probes use short timeouts (about 5 s SSH connect, 3 s HTTP) so a hung host cannot stall the poll loop.
- Prefer **SSH keys** over passwords. In Docker, mount the private key into `/root/.ssh` (see Quick start); passwords are the only SSH secret the app stores itself.
- Loopback installs remain local-trust. Remote bind (`BIND_HOST` not loopback) requires `SPARKDASH_TOKEN` for mutations and WebSocket telemetry and fails closed without it.
- One-off remote benchmark hosts must be listed in `SPARKDASH_BENCH_HOSTS`.
- Tested operator capacity for this remediation: **12 units**.


---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite (5173) + Express (5555) together |
| `npm run dev:server` | Express only (`node --watch`) |
| `npm run dev:client` | Vite only |
| `npm run build` | Production frontend → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm start` | Production server (`node server/index.js`) |
| `npm run docker:up` | `docker compose up -d` |
| `npm run docker:prod` | Same as `docker:up` |
| `npm run docker:rebuild` | `docker compose up --build -d` |
| `npm run docker:dev` | Dev Compose |
| `npm run docker:dev:build` | Dev Compose with rebuild |
| `./deploy.sh` | Recreate container; `--build`, `--frontend` flags |

---

## How it works

### Local vs remote Sparks

One `SystemCollector` path for both modes. When `spark.isLocal` is true, metrics come from host sysfs/proc and `nvidia-smi` (often via nsenter into the host namespace). Remote Sparks wrap the same commands in a shared `sshExec()` helper (key agent or `sshpass`). The helper reuses an authenticated OpenSSH transport by default so frequent metric polls do not create a new SSH/PAM login lifecycle each time. Set `SSH_CONTROL_PERSIST_SECONDS=0` to disable reuse. For `kind: "host"` units, actual hardware (GPU model, driver version, CPU, RAM) is detected once and cached in place of the static DGX Spark specs, and GPU VRAM comes straight from `nvidia-smi` while system RAM is read from `/proc/meminfo`.

### Graceful degradation

Collectors catch errors and return zero/default metrics instead of crashing the loop. After sustained liveness failures, a Spark is marked offline; the UI shows stale or empty states rather than hard errors.

### Hot configuration

Name, IP, SSH credentials, LLM port, and device/interface filters update the running `SparkMonitor` without tearing down poll loops or losing rate baselines. Registry writes are atomic (temp file + rename).

### LLM probe

Each configured LLM port gets its own `LlmProbe` instance running in parallel. Probes auto-detect backends:

- **llama.cpp** — `/slots` for live decode rates; model from `/props`
- **DS4 CUDA Engine** (Entrpi/ds4-on-spark, v0.6.2) — `/v1/models` (`owned_by: ds4.c`) + Prometheus `ds4_*` counters; DSpark spec decode, memory census, bank/lane tracking, log-tailing for reasoning effort + active context
- **vLLM** — `/v1/models` + Prometheus `/metrics` counters (scientific notation supported); TTFT/E2E/ITL p95 from histograms, per-position spec decode acceptance, KV cache, prefix cache, preemptions
- **SGLang** — `/v1/models` + `/get_server_info` (`last_gen_throughput` when metrics off) or Prometheus `/metrics`; DFlash acceptance, prefill cached/computed, active context, peak aggregate

Rates are derived from per-probe cumulative counter diffs (or SGLang sticky throughput while it moves). Multiple ports can be added or removed at runtime without restarting the monitor.

### LLM Telemetry Panel

The LLM panel provides a dense, Grafana-style telemetry view with 40+ live metrics. A redesigned layout (top to bottom):

<img src="./assets/telemetry-screenshot.jpg" alt="SparkDash LLM telemetry panel showing DS4 CUDA engine metrics — config/provenance, radial odometers, gauge arcs, throughput/latency/spec decode charts, 42 compact stat cards">

1. **Header bar** — backend badge (vLLM / SGLang / DS4), model name, port, thinking indicator
2. **Config & Provenance** — engine type, model name, author accreditation ("Built by @bleysg"), container/build image, config badges (context, lanes, spec decode method, quantization, prefix caching), collapsible params section
3. **Hero stats** — Decode tok/s (sparkline card), Aggregate tok/s (sparkline card), Avg tok/s (radial odometer, max=100), Peak tok/s (radial odometer, max=100)
4. **Gauge arcs** — Spec Accept %, Active Lanes (live/total), KV Cache %, Reasoning effort
5. **Chart row** — Throughput (decode + prefill, yMax=100), Latency (TTFT + E2E), Speculative Decode (per-position acceptance bars — Pos 0, Pos 1, Pos 2)
6. **Advanced stats** — 42 compact cards in an 8-column grid: TTFT, E2E, ITL p95, TTFT p95, E2E p95, Running, Waiting, Prefix Hit, Preempts, Uptime, Total Tokens, Spec Accept, GPU Mem, KV Cache, Active Context, Decode Steps, Tok/Step, Spec Drafts, Spec Hits, Spec Quench, Warm Records, KV Pages, Derived Artifacts, Prefill Cached, Prefill Computed, Admits Cold/Warm/Fork, Requests Started/Completed/Failed/Inflight, and more
7. **Actions** — Run decode benchmark, Open showcase

#### Three supported backends

The probe auto-detects which inference engine is running and adapts the telemetry accordingly. All three backends share the same panel — cards populate from whatever data is available.

| Backend | Detection | Metrics source | Key metrics |
|---------|-----------|----------------|-------------|
| **vLLM** | `/v1/models` → `owned_by` not ds4/sglang; falls back to Prometheus `/metrics` counters | Prometheus `/metrics` (vLLM native counters + histograms) | Generation tok/s, prefill tok/s, KV cache %, TTFT/E2E/ITL p95 (from histograms), prefix cache hit rate, preemptions, MTP acceptance, per-position spec decode acceptance (`spec_decode_num_accepted_tokens_per_pos_total`), GPU memory utilization, recipe info from `/proc` cmdline + chat template |
| **SGLang** | `/v1/models` → `/get_server_info` (`last_gen_throughput`); or Prometheus `/metrics` | SGLang `/metrics` or `/get_server_info` | Generation tok/s, prefill tok/s, DFlash acceptance, total tokens, tok/step, decode steps, prefill cached/computed, requests, active context, peak aggregate, TTFT/E2E/ITL p95 (from SGLang histograms) |
| **DS4 CUDA Engine** | `/v1/models` → `owned_by: "ds4.c"`; fallback: `/metrics` regex `ds4_tokens_decoded_total` | DS4 Prometheus `/metrics` (`ds4_*` prefix) + `/v1/models` for model info | Generation tok/s, prefill tok/s, DSpark acceptance ratio, spec drafts/hits/quench, banks live/total (lanes), KV cache usage (from memory census `ds4_memory_bytes`), GPU memory utilization (from memory census), prefix cache hit rate (prefillCached / total), TTFT (estimated from prefill rate), ITL p95 (1/perStreamAvg), E2E latency, reasoning effort (from log tailing), active context (from log tailing), uptime, admits (cold/warm/fork/partial), warm records, KV pages resident, derived artifacts, tok/step, per-position spec decode (synthesized from overall ratio via geometric decay) |

**Backend-adaptive design:** The panel renders cards based on data availability, not hardcoded backend names. If a metric is null for one backend but available for another, the card shows "—" (em dash) — no panels are deleted or gated per-backend. This means switching from vLLM to DS4 to SGLang doesn't break the panel; it just populates different cards.

**DS4-specific derivations:** Since the DS4 CUDA engine doesn't expose vLLM-style histograms or per-position spec decode breakdowns, several metrics are derived:
- **TTFT** — estimated from prompt tokens / prefill rate (with rolling window fallback)
- **ITL p95** — approximated as 1 / perStreamAvg (inter-token latency)
- **kvCacheUsage** — from `ds4_memory_bytes{class="kv_primary"}` / 121GB
- **gpuMemoryUtilization** — from total `ds4_memory_bytes{domain="unified_device"}` / 121GB
- **prefixCacheHitRate** — `prefillCached / (prefillCached + prefillComputed)`
- **perPositionAcceptance** — synthesized from overall DSpark accept ratio using geometric decay (Pos 0 = 100%, Pos N = ratio^N)
- **reasoningEffort + activeContext** — from DS4 log file tailing (`/tmp/ds4-serve.log`)

---

## Contributing

Contributions are welcome. Conventions:

- **Server**: plain JavaScript ESM
- **Client**: TypeScript + React
- Prefer extending the shared Spark model over per-unit special cases

---

## License

[MIT](./LICENSE) — Copyright (c) 2026 Mia'a AI Lab

---

## Acknowledgements

- Built for the **NVIDIA DGX Spark (GB10)** on ARM64
- Rebuilt from a legacy multi-unit dashboard with a single shared Spark model (no copy-pasted “Spark N” code paths)
- LLM probe behavior refined from production monitoring experience

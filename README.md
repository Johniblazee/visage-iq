# VisageIQ

> Face-matching service backed by your Google Drive folder.

VisageIQ takes a portrait, passport, or ID photo on the front-end and returns the top-3 most similar faces from a Google Drive folder you control, each with a confidence score. Photos in Drive are synchronized into a vector database (Postgres + pgvector) once and matched against in milliseconds thereafter — even at hundreds of thousands of records.

Built for internal review tooling: every result is decision-*support* for a human reviewer, never an automated identity decision. See [Responsible use](#responsible-use) below.

---

## Features

- **Drive-native enrollment.** Drop photos into a shared Google Drive folder; a service account reads them automatically. No bespoke admin UI to maintain a face database.
- **State-of-the-art recognition.** Powered by [InsightFace](https://github.com/deepinsight/insightface) `buffalo_l` (ArcFace + RetinaFace, 512-dim embeddings).
- **Sub-second top-K queries** at hundreds of thousands of rows via pgvector's HNSW index.
- **Background sync** with RQ workers + APScheduler — folder changes propagate every 30 minutes automatically, and a manual *Sync now* button is one click away.
- **React UI** for uploads, candidate cards with confidence bars, sync controls, analytics, and verdict bands (`MATCH` / `REVIEW` / `NO_MATCH`).
- **Rate limiting** per IP via slowapi + Redis.
- **One-command local stack** with Docker Compose and a self-documenting `Makefile`.
- **One-click cloud deploy** with a Render Blueprint (`render.yaml`).

## Stack

InsightFace `buffalo_l` · FastAPI · React · PostgreSQL 16 + pgvector (HNSW) · Redis 7 (cache + RQ + rate-limit) · APScheduler · Docker Compose · Render

## Architecture

```
┌────────────────┐
│  Google Drive  │  ◀── photos live here
└───────┬────────┘
        │ list / download (service-account auth)
        ▼
┌────────────────┐         enqueue          ┌──────────────┐
│  FastAPI api   │ ───────────────────────▶ │  RQ queue    │
│  /match        │                          │  (Redis)     │
│  /sync         │ ◀─── results             └──────┬───────┘
│  /image/{id}   │                                 │ pulls jobs
└───────┬────────┘                                 ▼
        │ upserts                          ┌──────────────┐
        │ embeddings                       │  RQ worker   │
        ▼                                  └──────┬───────┘
┌──────────────────────────────────┐              │ embeds + upserts
│  Postgres + pgvector (HNSW)      │ ◀────────────┘
│  table: persons (vector(512))    │
└──────────────────────────────────┘
        ▲
        │ similarity search
        │
┌────────────────┐
│  React UI      │  ◀── browser
└────────────────┘
```

The api never reads Drive at match time. Drive photos are pulled in by `/sync` (manual button or 30-minute scheduler), embedded, and stored in Postgres. `/match` runs a cosine-similarity query against the stored embeddings.

---

## Quickstart

### Prerequisites

- Docker Desktop
- GNU `make` (Windows: use Git Bash, or `choco install make`)
- A Google Cloud service-account JSON with read access to a Drive folder of photos *(see [Drive credentials](#drive-credentials))*

### Run it

```bash
make env       # creates .env from .env.example
# Edit .env and set:
#   GDRIVE_SA_JSON   — paste the full contents of your service-account JSON
#   GDRIVE_FOLDER_ID — the Drive folder id

make up        # docker compose up --build -d (~5–10 min on first build)
make health    # smoke-test the api
```

Open the React UI at http://localhost:3000. The sidebar nav has two tabs: **Search** (match flow) and **Analytics** (per-file outcomes from the last sync). Click **Sync now** in the sidebar to populate the database. Upload a photo to see matches. The Streamlit reference UI (`frontend-test/`) runs separately at http://localhost:8501.

While a sync is running, an **Active Sync** widget appears in the sidebar with a live progress bar and counters; it follows you as you switch between pages.

Run `make help` for the full list of shortcuts.

---

## Hardware modes — CPU vs GPU

VisageIQ ships in two flavours sharing the same code:

| Mode | Image base | When to pick it |
|---|---|---|
| **CPU** ([Dockerfile](Dockerfile)) | `python:3.12-slim-bookworm` | No NVIDIA GPU, or GPU available but you don't want the ~3 GB CUDA base image. Per-face embed: ~300 ms (~1.0 s with the 4-rotation iteration). |
| **GPU** ([Dockerfile.gpu](Dockerfile.gpu)) | `nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04` | You have an NVIDIA GPU + driver + nvidia-container-toolkit. Per-face embed: ~50 ms — roughly 30× faster on a 22 k-photo sync. |

The Makefile detects `nvidia-smi` on the host and **automatically** layers [docker-compose.gpu.yml](docker-compose.gpu.yml) on top of the base compose file when present. No manual flags.

```bash
make up      # CPU if no nvidia-smi; GPU if there is. Echoes which compose files were applied.
```

### Manual command equivalents

```bash
# CPU mode — just the base file
docker compose up -d --build

# GPU mode — base + override
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

### GPU prerequisites

```bash
nvidia-smi                                           # NVIDIA driver visible to the host
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu22.04 nvidia-smi
                                                     # ↑ verifies nvidia-container-toolkit
```

If the second command errors, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host before running `make up`.

### Verify GPU is engaged

```bash
curl -s http://localhost:8000/health | jq .providers
# Expect: ["CUDAExecutionProvider", "CPUExecutionProvider"]

make logs-worker | grep -i "Applied providers"
# Expect: Applied providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'], with options: ...
```

If you see only `CPUExecutionProvider`, ONNX Runtime fell back to CPU silently — usually because the container couldn't load `libcublasLt.so.12`. That happens when the api/worker were built from the CPU `Dockerfile` instead of `Dockerfile.gpu`. Run `make rebuild` on a host that has `nvidia-smi` so the Makefile picks the GPU Dockerfile.

In `.env`, make sure CUDA is listed first:

```
ONNX_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
```

CPU is left as the fallback so the same `.env` works on either mode — ONNX picks whichever provider it can actually load.

### Trade-offs

- **GPU image first build:** 5–15 minutes (downloads the CUDA runtime base + builds Python 3.12 from deadsnakes + bakes the InsightFace model). Subsequent rebuilds are minutes.
- **GPU image disk size:** ~3 GB vs ~1.2 GB for CPU.
- **Match latency:** typically dominated by the embedding step. GPU pulls a single match from ~1.0 s to ~150–200 ms.
- **No GPU on Render:** Render Standard plans don't expose GPUs. The `render.yaml` blueprint uses the CPU `Dockerfile` regardless.

---

## Drive credentials

VisageIQ reads your photo library through a Google Cloud service account. The service-account JSON is supplied as a single env var (`GDRIVE_SA_JSON`) — same mechanism locally and on Render. One-time setup:

1. **Create / pick a Google Cloud project** at https://console.cloud.google.com/projectcreate.
2. **Enable the Drive API**: https://console.cloud.google.com/apis/library/drive.googleapis.com.
3. **Create a service account** at https://console.cloud.google.com/iam-admin/serviceaccounts. Name it (e.g. `visageiq-sa`). Skip role grants — Drive sharing handles access.
4. **Generate a JSON key**: Service account → **Keys** → **Add Key → Create new key → JSON**. A `.json` file downloads.
5. **Share your Drive folder** with the service account email (`<sa-name>@<project>.iam.gserviceaccount.com`), role **Viewer**.
6. **Copy the folder ID** from the Drive URL `https://drive.google.com/drive/folders/<FOLDER_ID>`.
7. **Put the JSON into `GDRIVE_SA_JSON`** in `.env`:
   - Easiest: flatten to one line and wrap in single quotes:
     ```bash
     # produces a single-line GDRIVE_SA_JSON='{"type":...}' you can paste into .env
     echo "GDRIVE_SA_JSON='$(cat /path/to/key.json | python -c 'import json,sys; print(json.dumps(json.load(sys.stdin)))')'"
     ```
   - Or paste multi-line between single quotes (python-dotenv supports it).
8. **Set `GDRIVE_FOLDER_ID`** in `.env`.

On Render, the same `GDRIVE_SA_JSON` env var is set on the **api** and **worker** services via the dashboard (the [Deployment](#deployment) section walks through this).

---

## Usage

### From the UI

1. Open http://localhost:3000.
2. Sidebar → **Sync now** to import the Drive folder (one-time, then every 30 min automatically). The **Active Sync** panel appears in the sidebar with a live progress bar and counters; it stays visible if you switch to **Analytics**.
3. Upload a portrait on the **Search** tab. Top-3 candidates render with thumbnails, confidence percentage, verdict badge, and a **Top match: NN%** summary line. Sliders in the Search header adjust the MATCH / REVIEW thresholds — verdict pills update live without re-querying.
4. Open **Analytics** (sidebar nav) for a breakdown of every file the worker has seen: outcome counts (`enrolled` / `unchanged` / `no_face` / `invalid_image` / `drive_error` / `embed_error`), file-extension distribution, an outcome×ext matrix, and a paginated browser of skipped files with reasons (50/100/200/500 rows per page).

### From the API

```bash
# Match a photo
curl -F "file=@portrait.jpg" "http://localhost:8000/match?top_k=3"

# Trigger a sync (returns a job id)
curl -X POST http://localhost:8000/sync

# Poll a sync job
curl http://localhost:8000/sync/<job_id>

# Health
curl http://localhost:8000/health
```

API response (`/match`):

```json
{
  "query_face_bbox": [x1, y1, x2, y2],
  "query_face_count": 1,
  "query_det_score": 0.92,
  "query_rotation": 0,
  "enrolled_count": 21358,
  "candidates": [
    {
      "drive_file_id": "1AbC...",
      "title": "passport_jane_doe.jpg",
      "similarity": 0.71,
      "confidence_pct": 71.0,
      "verdict": "MATCH"
    }
  ]
}
```

`/health` reports more than just liveness — it carries `enrolled_count`, `drive_total`, `last_sync_finished_at`, and `active_sync_job_id` for the sidebar widgets.

OpenAPI docs are auto-generated at http://localhost:8000/docs.

---

## Configuration

All configuration lives in `.env` (local) or service environment variables (Render). Defaults are sane; only `GDRIVE_FOLDER_ID` and credentials are required.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:pg@db:5432/postgres` | Postgres DSN |
| `REDIS_URL` | `redis://redis:6379/0` | Redis URL (cache + RQ + rate-limit) |
| `GDRIVE_FOLDER_ID` | *(required)* | Drive folder shared with the service account |
| `GDRIVE_SA_JSON` | *(required)* | Raw JSON contents of the service-account key |
| `GDRIVE_RECURSIVE` | `true` | Walk subfolders during sync |
| `INSIGHTFACE_MODEL` | `buffalo_l` | Try `antelopev2` for a fairness A/B |
| `ROTATION_MODE` | `fallback` | One of `off` / `fallback` / `always`. **`off`**: only 0° is tried (fastest; tilted photos skipped). **`fallback`** *(recommended)*: try 0° first, only try 90°/180°/270° if 0° found no face. **`always`**: iterate all four, pick highest `det_score` (most robust, most expensive). |
| `ROTATION_ENABLED` | `true` | Kill-switch. If `false`, forces `ROTATION_MODE=off` regardless of the value above. |
| `ROTATION_EARLY_EXIT_SCORE` | `0.85` | Used only when `ROTATION_MODE=always`: short-circuit the loop as soon as a rotation produces ≥ this `det_score`. Set `1.0` to always try all four. |
| `MATCH_THRESHOLD` | `0.40` | Cosine similarity floor for `MATCH` verdict |
| `REVIEW_THRESHOLD` | `0.30` | Floor for `REVIEW` (below → `NO_MATCH`) |
| `TOP_K` | `3` | Default candidates returned by `/match` |
| `SYNC_INTERVAL_MIN` | `30` | Scheduler period in the api container; `0` to disable |
| `IMAGE_CACHE_TTL_SECONDS` | `86400` | Redis TTL for cached Drive image bytes |
| `MATCH_RATE_LIMIT` | `30/minute` | Per-IP slowapi limit on `/match` |
| `SYNC_RATE_LIMIT` | `5/minute` | Per-IP slowapi limit on `/sync` |
| `WORKER_REPLICAS` | `1` | Number of `worker` containers `make up` / `make rebuild` will start. Each holds its own ~500 MB InsightFace instance. |
| `ONNX_PROVIDERS` | `CPUExecutionProvider` | Comma-list. GPU: `CUDAExecutionProvider,CPUExecutionProvider` |
| `INSIGHTFACE_MODULES` | `detection,recognition` | Comma list of InsightFace sub-models to load. Default skips genderage / landmarks for ~30–40% lower RAM. Empty (or list all five) restores the full loadout. |
| `EMBED_WORKERS` | `1` | Per-sync embed parallelism via `ProcessPoolExecutor`. CPU recommendation: `3` (4-core), `7` (8-core). **GPU MUST stay at `1`** — multiple processes oversubscribe one GPU. |
| `EMBED_WORKER_MAX_INFLIGHT` | `8` | Bounded inflight queue for the embed pool. Caps RAM regardless of file count. |
| `DOWNLOAD_WORKERS` | `4` | `ThreadPoolExecutor` size for Drive-download prefetch. Overlaps I/O with embedding — the main GPU throughput win. Set `1` to disable. |
| `DOWNLOAD_MAX_INFLIGHT` | `8` | Cap on simultaneously prefetched downloads (≈ `N × image_size` bytes buffered). |
| `API_BASE_URL` | `http://api:8000` | URL the UI uses to call the api |

---

## Deployment

A [`render.yaml`](render.yaml) Blueprint is included. It provisions five Render resources: managed Postgres (with pgvector), managed Key Value (Redis), api web service, worker service, and ui web service.

1. **Push the repo to GitHub.**
2. **Render dashboard → New + → Blueprint** → select the repo. Render reads `render.yaml`.
3. **Fill secrets when prompted:**
   - `GDRIVE_SA_JSON` — paste the full contents of your downloaded service-account JSON. Set on **api** and **worker** services. Render encrypts it.
   - `GDRIVE_FOLDER_ID` — the Drive folder ID. Set on **api** and **worker** services.
4. **First build takes ~5–10 minutes** because the Dockerfile bakes the InsightFace `buffalo_l` weights (~300 MB) so cold starts skip the download.
5. **After the api deploys**, open the **ui** service → Environment → set `API_BASE_URL` to the api's public URL (e.g. `https://visageiq-api.onrender.com`). Save; the UI auto-redeploys.

Pushes to the tracked branch auto-deploy all five resources. Schema migrations run idempotently on api startup, so additive changes (new columns, new indexes) require no manual step.

**Cold starts:** Render starter plans suspend after 15 minutes of inactivity. The first request after suspension takes 10–20 seconds while the container wakes. Bump api + worker to **Standard** plan in `render.yaml` (or use a free uptime monitor pinging `/health`) for always-on behaviour.

**Scaling sync throughput:** when the initial sync of a large folder feels slow, you can:

- **Run multiple worker containers** (locally: `docker compose up -d --scale worker=4`; on Render: clone the worker service in `render.yaml`). Each worker holds its own ~500 MB InsightFace instance in RAM. Note the current `run_sync()` job is one big task, so >1 worker only helps for *concurrent* sync jobs, not for parallelising a single sync — see future per-file fan-out work for true linear speedup.
- **Tune `ROTATION_EARLY_EXIT_SCORE`** (default `0.85`). Most photos are upright; the embedder breaks out of the 4-rotation loop after the first iteration when the detector is confident. Lower the value for more aggressive early-exit; raise to `1.0` to disable and always try all four rotations.
- **Switch to GPU** for ~30× per-face speedup: `pip install onnxruntime-gpu` and `ONNX_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider`.

---

## Development

```bash
make install     # python -m venv .venv && pip install -r requirements.txt
make api         # FastAPI on :8000 with autoreload
make worker      # RQ worker
make ui          # React UI (Vite) on :3000
make sync        # Foreground sync (no worker required)
make check       # Byte-compile every Python module
make psql        # psql shell into the compose db
make redis-cli   # redis-cli into the compose redis
make logs        # Tail all compose service logs
make down        # Stop everything
```

Run `make help` for the full list.

### Native (no Docker for the app)

You still want Docker for Postgres + Redis (much easier than installing them natively). The api / worker / UI run as plain Python processes:

```bash
# 1. Postgres + Redis
docker run -d --name fm-pg -p 5432:5432 -e POSTGRES_PASSWORD=pg pgvector/pgvector:pg16
docker run -d --name fm-redis -p 6379:6379 redis:7-alpine

# 2. Python deps
make install
source .venv/bin/activate    # or .venv/Scripts/activate on Windows

# 3. Point .env at localhost
# DATABASE_URL=postgresql://postgres:pg@localhost:5432/postgres
# REDIS_URL=redis://localhost:6379/0
# (GDRIVE_SA_JSON and GDRIVE_FOLDER_ID stay the same as the Docker case)

# 4. Schema
make init-db

# 5. Three terminals
make api      # terminal 1
make worker   # terminal 2
make ui       # terminal 3
```

For the initial bulk load without a worker, run `make sync` in a fourth terminal — it executes the same algorithm synchronously and surfaces tracebacks directly.

### Project structure

```
backend/                 FastAPI service, InsightFace wrapper, Drive client,
                         Redis cache, sync logic, RQ, analytics queries
frontend/                React operator UI (face search, worker/sync controls,
                         analytics, retry workflow)
frontend-test/           Streamlit reference UI used during testing
├── streamlit_app.py     Home page (match flow)
├── _shared.py           Shared utilities (active-sync sidebar fragment)
└── pages/
    └── 01_Analytics.py  Analytics page (auto-discovered by Streamlit)
scripts/                 init_db.sql (persons + file_status tables),
                         enroll.py (foreground sync CLI)
Dockerfile               CPU image for api + worker (slim-bookworm)
Dockerfile.gpu           GPU image — CUDA 12.6 + cuDNN 9 + Python 3.12
Dockerfile.ui            React build + Nginx image
Dockerfile.streamlit     Streamlit reference UI image (frontend-test/)
docker-compose.yml       Base compose (CPU)
docker-compose.gpu.yml   Override — switches api/worker to Dockerfile.gpu and
                         requests the NVIDIA GPU. Auto-applied by the Makefile.
render.yaml              Render Blueprint (CPU only — Render plans don't expose GPU)
Makefile                 Auto-detects nvidia-smi and layers docker-compose.gpu.yml
requirements.txt
```

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | DB + Redis liveness, model name, `enrolled_count`, `drive_total`, `last_sync_finished_at`, `active_sync_job_id` |
| `POST` | `/match` | Upload an image, get top-K candidates with `query_rotation` + `enrolled_count` |
| `POST` | `/sync` | Enqueue a Drive→DB sync job |
| `GET` | `/sync/{job_id}` | Poll a sync job's status — includes live `progress` (`phase`/`current`/`total`/counters; `phase=skipped` when lock-blocked) |
| `POST` | `/sync/force-unlock` | Manual override: clears `lock:sync` + `lock:retry` + `sync:active_job_id`. Rarely needed — locks use a short TTL + heartbeat and the next sync auto-recovers a dead holder within ~2 min. Rate-limited 5/min. |
| `POST` | `/sync/retry` | Re-run the embedding pipeline for an explicit list of `drive_file_id`s (1–1000). Skips the Drive walk; holds its own `lock:retry`. |
| `GET` | `/worker/status` | Whether RQ workers are currently suspended (`{"suspended": bool}`) |
| `POST` | `/worker/pause` | Suspend RQ workers — no new jobs dequeued; in-flight jobs finish |
| `POST` | `/worker/resume` | Clear the suspension flag |
| `GET` | `/image/{file_id}` | Drive-image proxy (Redis-cached) for thumbnails |
| `GET` | `/analytics/summary` | Outcome counts, extension distribution, outcome×ext matrix |
| `GET` | `/analytics/files` | Paginated `file_status` rows with `outcome` / `ext` / `q` filters |
| `GET` | `/docs` | Auto-generated OpenAPI |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/match` returns zero candidates | `persons` table is empty — sync hasn't run | Click **Sync now** in the UI, or `curl -X POST .../sync`, or `make compose-sync` |
| `422 No face detected` | Detector found no face | Check the image — too small, occluded, or non-photographic |
| `DriveError: GDRIVE_FOLDER_ID not set` | Env var didn't load | Confirm `.env` has the line; restart the service |
| `DriveError: GDRIVE_SA_JSON is not set` | Env var missing or empty | Paste the full SA JSON into `GDRIVE_SA_JSON` in `.env` (or Render env tab) |
| `DriveError: GDRIVE_SA_JSON is not valid JSON` | Quoting / line-ending issue | Wrap the value in single quotes; flatten to one line first if needed |
| `DriveError: ... 403` | Folder not shared with the SA | Share the Drive folder with the SA email, role **Viewer** |
| `extension "vector" is not available` | Wrong Postgres image | Use `pgvector/pgvector:pg16`, never plain `postgres:16` |
| Sync jobs stuck `queued` | No worker is consuming the queue | Confirm worker container/service is running (`make ps` / Render dashboard) |
| Worker logs `[sync …] already in progress; skipping` and exits in ~2s on every retry | Stuck Redis lock from a crashed worker. **Now mostly self-healing**: `lock:sync` uses a short TTL (120s) with a heartbeat refresh, and the next sync auto-recovers when it detects the holder job is dead — so it clears within ~2 min on its own. | Wait ~2 min for auto-recovery. To clear it immediately: sidebar → **Drive Sync** → **Force unlock (advanced)**, or `make redis-cli` → `DEL lock:sync` + `DEL sync:active_job_id`. If it recurs, the worker is crashing mid-sync — see HOWTO "native abort". |
| `429 rate limit exceeded` | slowapi cap hit | Bump `MATCH_RATE_LIMIT` / `SYNC_RATE_LIMIT` in `.env` |
| Render cold start (~15s) | Starter plan suspended after idle | Bump to Standard plan, or accept it |
| Thumbnail returns 502 | api couldn't fetch from Drive | Check api logs; usually a permission revoke or deleted file |
| `Failed to load library libonnxruntime_providers_cuda.so ... libcublasLt.so.12` | api/worker built from CPU `Dockerfile` (no CUDA libs) | Run `make rebuild` on a host with `nvidia-smi`; the Makefile picks `Dockerfile.gpu` automatically |
| `E: Unable to locate package python3.12-distutils` (build) | Python 3.12 doesn't ship a separate distutils package | Already fixed — pull latest `Dockerfile.gpu` |
| `Calling st.sidebar in a function wrapped with st.fragment is not supported` | Streamlit's rule: a fragment writes to its caller's container | Already fixed in `frontend-test/_shared.py`; pull latest |
| `image file is truncated` / `Empty image buffer (zero bytes)` in worker logs | Partial Drive uploads or zero-byte files | Expected. Logged as `invalid_image` in the `file_status` table; visible on the Analytics page's *Browse files* with `outcome=invalid_image`. |
| Active Sync widget never appears | Worker is processing but `active_sync_job_id` Redis key wasn't set | Fall back to `make logs-worker`; if a job is running, manually set the key with `make redis-cli` then `SET sync:active_job_id <job_id>` (or wait for the next sync — `enqueue_sync` always sets it) |

---

## Responsible use

Every face recognition system, including this one, has measurably different error rates across demographic groups. NIST FRVT studies have documented this for every commercial and open-source vendor evaluated. VisageIQ:

- **Always returns top-K candidates with explicit similarity scores** — never a binary identity decision.
- **Surfaces a verdict band** (`MATCH` / `REVIEW` / `NO_MATCH`) so reviewers attend more carefully to borderline cases.
- **Should not be wired into automated actions** (account creation, access grants, alerts) without a human in the loop.

If you have labeled validation data, plot per-subgroup ROC curves and tune `MATCH_THRESHOLD` to equalize false-reject rates across groups, rather than picking a single global threshold. Background reading: [NIST FRVT Demographics](https://pages.nist.gov/frvt/html/frvt_demographics.html).

---

## License

Specify your license here (e.g. MIT, Apache 2.0). Until then, all rights reserved by the repository owner.

## Acknowledgments

- [InsightFace](https://github.com/deepinsight/insightface) — face detection and embedding
- [pgvector](https://github.com/pgvector/pgvector) — vector similarity search in Postgres
- [FastAPI](https://fastapi.tiangolo.com/), [Streamlit](https://streamlit.io/), [RQ](https://python-rq.org/), [APScheduler](https://apscheduler.readthedocs.io/), [slowapi](https://slowapi.readthedocs.io/)

# Face Match (Google Drive backed)

Internal face-matching service. Photos live in a Google Drive folder; the app syncs them into Postgres + pgvector, embeds with InsightFace, and serves top-3 matches with confidence scores via FastAPI + a Streamlit UI. Fully containerized.

Stack: InsightFace `buffalo_l` · FastAPI · Streamlit · PostgreSQL + pgvector (HNSW) · Redis (cache + RQ queue + rate-limit) · APScheduler · Docker Compose.

## Decision-support, not identity decision

No open-source face recognition model is demographically perfect — NIST FRVT studies consistently find disparate error rates across racial groups for every vendor tested. This app always returns the top-K candidates with similarity scores and a MATCH / REVIEW / NO_MATCH band. The final identity decision is made by a human reviewer.

---

## 1. Google Drive service account setup

Step-by-step. Do once.

1. **Create / pick a Google Cloud project** at https://console.cloud.google.com/projectcreate. Note the Project ID.
2. **Enable the Drive API** at https://console.cloud.google.com/apis/library/drive.googleapis.com → **Enable** for your project.
3. **Create a service account** at https://console.cloud.google.com/iam-admin/serviceaccounts → **Create service account** → name it `face-match-sa` → **Done** (skip optional role grants — Drive sharing handles access).
4. **Generate a JSON key**: open the new service account → **Keys** tab → **Add Key → Create new key → JSON → Create**. A `*.json` file downloads.
5. **Save the key file to** `secrets/gdrive-sa.json` in this repo (gitignored). The compose stack mounts it as a Docker secret at `/run/secrets/gdrive-sa`.
6. **Copy the service account email** (looks like `face-match-sa@<project-id>.iam.gserviceaccount.com`) shown on the service account page.
7. **Share the Drive folder** holding your match images with that email. Open Drive → right-click the folder → **Share** → paste the SA email → role **Viewer** → uncheck "Notify people" → **Share**.
8. **Capture the folder ID**. From the folder URL `https://drive.google.com/drive/folders/<FOLDER_ID>`, copy the trailing token.
9. **Edit `.env`** (copy from `.env.example`):
   ```
   GDRIVE_SA_JSON_PATH=/run/secrets/gdrive-sa
   GDRIVE_FOLDER_ID=<paste folder id>
   GDRIVE_RECURSIVE=true
   ```

That is the entire credential setup. Subfolders inside the shared folder are walked automatically when `GDRIVE_RECURSIVE=true`.

---

## 2. Run with Docker Compose

```bash
cp .env.example .env       # edit GDRIVE_FOLDER_ID
docker compose up --build  # first build downloads InsightFace models on first sync
```

What comes up:

| Service | Port | What it does |
|---|---|---|
| `db` | 5432 | Postgres 16 + pgvector. `scripts/init_db.sql` runs on first boot. |
| `redis` | 6379 | Image cache, RQ queue, slowapi rate-limit storage |
| `api` | 8000 | FastAPI: `/match`, `/sync`, `/sync/{job_id}`, `/image/{file_id}`, `/health` |
| `worker` | – | `rq worker` consuming the `sync` queue |
| `ui` | 8501 | Streamlit. Open http://localhost:8501 |

The InsightFace model weights persist in the `insightface-models` named volume so they only download once (~300 MB).

---

## 3. First-time data load

Two ways:

**A. From the UI:** open http://localhost:8501, click **Sync now** in the sidebar. The status polls until done.

**B. Via the API:**

```bash
curl -X POST http://localhost:8000/sync
# → {"job_id":"...","status":"queued"}
curl http://localhost:8000/sync/<job_id>
```

**C. Foreground from a CLI** (skips Redis/worker — useful if a worker is unreachable):

```bash
docker compose run --rm api python scripts/enroll.py
```

The sync is idempotent: it lists every image in the Drive folder, embeds new files, re-embeds files whose Drive `modifiedTime` advanced, and (if `prune=true`) deletes rows for files removed from Drive.

---

## 4. Match flow

Upload a photo via the Streamlit UI or:

```bash
curl -F "file=@portrait.jpg" "http://localhost:8000/match?top_k=3"
```

Response:

```json
{
  "query_face_bbox": [x1, y1, x2, y2],
  "query_face_count": 1,
  "query_det_score": 0.92,
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

Thumbnails in the UI render via `GET /image/{file_id}` — the API streams the file from Drive (cached in Redis for 24h by default).

---

## 5. Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:pg@db:5432/postgres` | Postgres DSN (compose-internal hostname) |
| `REDIS_URL` | `redis://redis:6379/0` | Redis URL for queue + cache + rate-limit |
| `GDRIVE_SA_JSON_PATH` | `/run/secrets/gdrive-sa` | Path to mounted SA key inside the container |
| `GDRIVE_FOLDER_ID` | *(required)* | Drive folder shared with the service account |
| `GDRIVE_RECURSIVE` | `true` | Walk subfolders |
| `INSIGHTFACE_MODEL` | `buffalo_l` | Try `antelopev2` for a fairness A/B |
| `MATCH_THRESHOLD` | `0.40` | Cosine similarity floor for MATCH |
| `REVIEW_THRESHOLD` | `0.30` | Floor for REVIEW (below → NO_MATCH) |
| `TOP_K` | `3` | Default candidates returned |
| `SYNC_INTERVAL_MIN` | `30` | Scheduler period in the API container; set `0` to disable |
| `IMAGE_CACHE_TTL_SECONDS` | `86400` | Redis TTL for cached Drive image bytes |
| `MATCH_RATE_LIMIT` | `30/minute` | Per-IP slowapi limit on `/match` |
| `SYNC_RATE_LIMIT` | `5/minute` | Per-IP slowapi limit on `/sync` |
| `ONNX_PROVIDERS` | `CPUExecutionProvider` | Comma-list. GPU: `CUDAExecutionProvider,CPUExecutionProvider` (also swap to `onnxruntime-gpu`) |
| `API_BASE_URL` | `http://api:8000` | UI uses this to call the API |

---

## 6. Project layout

```
backend/         FastAPI service, InsightFace, Drive client, Redis cache, sync logic, RQ
frontend/        Streamlit app (sync button, match flow, image proxy thumbnails)
scripts/         init_db.sql, enroll.py (foreground sync CLI)
secrets/         gdrive-sa.json (gitignored; mounted as Docker secret)
Dockerfile       Shared image for api + worker
Dockerfile.ui    Slim Streamlit image
docker-compose.yml
```

---

## 7. Deploy to Render

The repo includes a `render.yaml` blueprint that provisions five resources:

| Resource | Type | Purpose |
|---|---|---|
| `face-match-db` | Postgres (managed) | pgvector enabled at first DB connection |
| `face-match-cache` | Key Value (managed Redis) | Image cache, RQ queue, rate-limit storage |
| `face-match-api` | Docker web service | FastAPI on `$PORT`, runs APScheduler in-process |
| `face-match-worker` | Docker worker service | `rq worker` consuming the `sync` queue |
| `face-match-ui` | Docker web service | Streamlit on `$PORT`, public URL is what users hit |

### One-time setup

1. **Push this repo to GitHub.**
2. In the Render dashboard click **New → Blueprint**, point it at the repo. Render reads `render.yaml`.
3. **Sync `sync: false` env vars** when Render prompts:
   - `GDRIVE_SA_JSON` — paste the **entire contents** of `secrets/gdrive-sa.json` (raw JSON, single line or multi-line both fine). Render encrypts it. Set on **api** and **worker** services.
   - `GDRIVE_FOLDER_ID` — the Drive folder ID from Step 1.7.
   - `API_BASE_URL` (UI service only) — fill in **after** the api service deploys, with its public URL: `https://face-match-api.onrender.com` (or whatever Render assigns).
4. **First deploy** kicks off automatically. The api/worker images take ~5–10 min on first build because the Dockerfile bakes the InsightFace `buffalo_l` weights (~300 MB) so cold starts skip the download.
5. **Run a sync**: open the UI URL (`https://face-match-ui.onrender.com`), click **Sync now**. First sync time ∝ folder size (CPU embedding ~300–500 ms per face).

### Render-specific notes

- **pgvector** is auto-enabled by `bootstrap_schema()` running at API startup (`CREATE EXTENSION IF NOT EXISTS vector` on every connection from the pool). No manual `psql` step required.
- **Service-account credential** is supplied as a single env var (`GDRIVE_SA_JSON`) instead of a file. The code prefers the env var when set; locally, the Docker secret file at `/run/secrets/gdrive-sa` is still used by `docker compose`.
- **Cold-start latency**: starter plans suspend after 15 min of inactivity. The first request after suspension takes ~10–20s while the container boots. Bump api + worker to **standard** ($25/mo each) if always-on matters.
- **Cost shape**: db basic-256mb (~$6), keyvalue starter (~$10), api standard, worker standard, ui starter. Drop worker plan to starter if your folder is small (<500 images) and sync rarely runs.
- **Image vulnerability hint**: Docker linters may flag `python:3.12-slim-bookworm` for transitive CVEs. The Dockerfiles do `apt-get upgrade -y` and `pip install --upgrade pip setuptools wheel` to patch what we control. Remaining findings live in upstream layers and clear when Docker Hub republishes the tag — not service-impacting.
- **TLS / domains**: Render provisions HTTPS on `*.onrender.com` automatically. Add a custom domain via the dashboard if needed.

### Updating the deployment

Push to the connected branch; Render auto-deploys both api + worker + ui. The `bootstrap_schema()` call is idempotent so no manual migration step is needed for new schema additions (as long as they remain `IF NOT EXISTS` / additive).

---

## 8. Race-fairness notes

- Use `buffalo_l` (Glint360K training, broader demographic coverage). Swap to `antelopev2` for an A/B if you have a labeled validation set.
- Tune `MATCH_THRESHOLD` on **your** data. Compute per-subgroup ROC and equalize false-reject rates rather than picking a single global threshold.
- Always surface top-K with scores. Never let the API drive an automated identity action.
- NIST FRVT remains the canonical reference: https://pages.nist.gov/frvt/html/frvt_demographics.html.
# visage-iq

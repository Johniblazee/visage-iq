# Video match (v1: uploaded clips) — design

**Date:** 2026-09-17 · **Status:** approved in conversation, pending written review
**Branch:** `feat/video-match`

## Goal

An operator uploads a short video clip (CCTV export, phone clip) and gets an
**attendance roll**: every enrolled student identifiable in the clip, with the
evidence needed to seek to them in the original footage. Live webcam matching
is v2 and reuses the per-frame core defined here; only the transport differs.

## Non-negotiables

- **Nothing from a video is ever written to the enrolled index.** The video
  module has no write path to `persons` / `alt_embeddings`; embeddings computed
  from frames live only in memory for the duration of a frame.
- **Frames are never persisted.** Decoding happens in memory; no `frames/`
  directory, no per-frame files.
- **The uploaded video is deleted when the job ends** (success or failure).
- Evidence kept per matched student: timestamps (numbers), one best full frame
  (JPEG) and one face crop (JPEG). Nothing for unidentified faces except a count.
- Every upload, result view and evidence view is audited.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Output | Attendance roll: one card per identified student |
| Source | Short clips (seconds–~15 min, ≤ 500 MB) uploaded from the browser |
| Retention | Video deleted after processing; results kept |
| Execution | Own RQ queue `video`, served by a second worker service `worker-video` |
| Evidence | All matched timestamps + best full frame (face box drawn) + face crop |
| UI | Designed in the VisageIQ Claude Design project before any UI code |

## Architecture

```
browser ──multipart──▶ api: POST /video ──▶ /data/video-uploads/<job>.<ext> (shared volume)
                                      └──▶ RQ queue "video" ─▶ worker-video: run_video_job
                                                                  │ cv2.VideoCapture, sample frames
                                                                  │ detect+embed each frame (GPU, in memory)
                                                                  │ pgvector top-1 per face
                                                                  │ aggregate per enrolled photo
                                                                  ▼
                                                        video_jobs + video_sightings (Postgres)
browser ◀──poll GET /video/{id} ◀── api                 upload file deleted (finally)
browser ◀── GET /video/{id}/results, /frame, /crop
```

### Components

**`backend/video.py`** (worker side; pure functions where possible)
- `probe(path) -> VideoInfo(fps, frame_count, duration_s, width, height)` — opens with
  OpenCV, reads one frame; raises `VideoError` with a human message on failure.
- `sample_indices(frame_count, fps, sample_fps) -> list[int]` — evenly spaced frame
  indices, at most one per 1/sample_fps seconds; always includes frame 0.
- `iter_frames(path, indices)` — yields `(index, ts_seconds, ndarray)`; sequential
  read with `grab()`/`retrieve()` (no seeking), so decode cost is linear.
- `match_frame(frame, min_face_px) -> list[FaceHit]` — `FaceAnalysis.get(frame)` at
  rotation 0 only; drops faces whose bbox short side < `min_face_px`; for each
  remaining face runs the gallery search (`main._search` moved to a shared module,
  top_k=1) and returns `(bbox, det_score, drive_file_id, similarity)`; faces whose
  best similarity is below the review threshold return `drive_file_id=None`.
  This function is the **shared per-frame core** for v2 (live webcam).
- `Aggregator` — in-memory dict keyed by `drive_file_id`:
  `best_similarity, best_ts, best_frame_jpeg, best_crop_jpeg, timestamps[], frames_seen`;
  `add(ts, hit, frame)` keeps the frame/crop only when the score improves;
  `unknown_faces` counter for hits without a drive_file_id.
- `encode_evidence(frame, bbox) -> (frame_jpeg, crop_jpeg)` — full frame with the
  box drawn (longest side capped at 1280 px, JPEG q80) and a face crop padded 30%,
  256 px, JPEG q85.
- `run_video_job(job_id)` — RQ entrypoint: load job row → probe → iterate → progress
  to `job.meta["progress"]` every 25 frames → one transaction writing sightings and
  the job summary → `finally: unlink(upload)`. Any exception marks the job
  `failed` with a human `error` and the technical `detail`.

**`backend/queue.py`** — `enqueue_video(job_id)` on queue `video`, timeout 30 min.

**`backend/main.py`** — endpoints (below). `_search` and `_STUDENT_JOIN` move to
`backend/gallery.py` so the worker can import them without importing the app.

**`worker-video`** — compose service, same image/Dockerfile as `worker`, command
`rq worker video`, GPU overlay applies, mounts `video-uploads`.

**`frontend`** — new tab "Video match" (`VideoPage.tsx`), types in `api.ts`,
design from the Claude Design project.

### Config (`backend/config.py`, `.env.example`)

| Key | Default | Meaning |
|---|---|---|
| `VIDEO_SAMPLE_FPS` | `2` | Frames analysed per second of video |
| `VIDEO_MIN_FACE_PX` | `40` | Skip detections smaller than this (short side of bbox) |
| `VIDEO_MAX_UPLOAD_MB` | `500` | Reject larger uploads with 413 |
| `VIDEO_MAX_DURATION_S` | `900` | Reject longer clips (probed before enqueue) |
| `VIDEO_UPLOAD_DIR` | `/data/video-uploads` | Shared volume path inside the containers (documented in README, not in `.env.example`) |
| `VIDEO_RATE_LIMIT` | `10/hour` | Per-IP upload limit (slowapi, like /match) |

Verdict thresholds are the live `MATCH_THRESHOLD` / `REVIEW_THRESHOLD` from
`/config`, read when the upload is accepted and stored on the job row so the
worker and the results endpoint use one pair and results are reproducible.

## Data model (`scripts/init_db.sql`, idempotent)

```sql
CREATE TABLE IF NOT EXISTS video_jobs (
    id              UUID PRIMARY KEY,
    actor           TEXT NOT NULL,
    filename        TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    status          TEXT NOT NULL,          -- queued | running | done | failed
    error           TEXT,
    detail          TEXT,
    duration_s      REAL,
    fps             REAL,
    width           INT,
    height          INT,
    sampled_frames  INT NOT NULL DEFAULT 0,
    faces_seen      INT NOT NULL DEFAULT 0,
    unknown_faces   INT NOT NULL DEFAULT 0,
    match_threshold REAL,
    review_threshold REAL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS video_sightings (
    job_id          UUID NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
    drive_file_id   TEXT NOT NULL,
    best_similarity REAL NOT NULL,
    best_ts         REAL NOT NULL,
    first_ts        REAL NOT NULL,
    last_ts         REAL NOT NULL,
    frames_seen     INT NOT NULL,
    timestamps      REAL[] NOT NULL,
    frame_jpeg      BYTEA NOT NULL,
    crop_jpeg       BYTEA NOT NULL,
    PRIMARY KEY (job_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS video_jobs_created_idx ON video_jobs (created_at DESC);
```

Student details are joined at read time through `students.photo_drive_file_id`
(same LATERAL join as face search). No embeddings are stored.

Results retention: kept. Sizes are small (~150 KB per student per video). A
`VIDEO_RESULTS_TTL_DAYS` sweep is out of scope for v1.

## API

| Method & path | Purpose |
|---|---|
| `POST /video` (multipart `file`) | Validate size → stream to upload dir → probe (reject undecodable / too long with 400/413 and a human message) → insert `video_jobs` (queued) → enqueue → `{job_id}`. Audit `video_upload` (filename, size, duration). Rate-limited per IP by `VIDEO_RATE_LIMIT`. |
| `GET /video` | Recent jobs (last 50): id, filename, status, created_at, counts. |
| `GET /video/{id}` | Job row + live `progress` from RQ meta: `{phase, current, total, faces_seen}` (the UI derives the ETA from the frame rate). |
| `GET /video/{id}/results` | Job summary + sightings with student, `confidence_pct`, `verdict`, timestamps, `frames_seen`, `first_ts/last_ts/best_ts`. Sorted verdict desc, then score. Audit `video_results`. |
| `GET /video/{id}/frame/{drive_file_id}` | Best full frame JPEG (box drawn). Audit `image_view`. |
| `GET /video/{id}/crop/{drive_file_id}` | Face crop JPEG. |
| `DELETE /video/{id}` | Remove job + evidence. Audit `video_delete`. |

All endpoints sit behind the existing Clerk middleware.

### Accepted inputs

Accepted by **content**, not extension: the API probes with OpenCV (bundled
ffmpeg, libavcodec 62) — MP4/MOV (H.264, H.265), AVI, MKV, WebM (VP8/VP9/AV1),
MPEG-TS, 3GP, WMV, FLV all decode. Vendor-native containers (Dahua `.dav`, raw
`.h264` streams) may fail and are rejected with: *"Couldn't decode this video —
export it as MP4 (H.264) and try again."*

## Processing rules

- Sampling: `VIDEO_SAMPLE_FPS` (2). A 5-minute clip → 600 frames ≈ 20–40 s on
  the GPU (detect + embed measured at ~9 ms per 720p frame).
- No rotation search (CCTV/phone clips are upright; the sync's rotation logic
  is for scanned passports).
- A face counts as a sighting of enrolled photo *P* when its top-1 gallery hit
  is *P* with similarity ≥ review threshold. Verdict for the card = verdict of
  `best_similarity` under the job's stored thresholds.
- `frames_seen` = number of sampled frames with a sighting; the UI flags
  `frames_seen == 1` ("seen in 1 frame") so single-frame flukes are weighed.
- Unidentified faces (top-1 below review) increment `unknown_faces` only.
- Progress: `job.meta["progress"] = {"phase": "matching", "current": i, "total": n, "faces_seen": k}`
  every 25 frames; `phase: "probing"` before the loop, `"writing"` during the
  final transaction.

## Errors

| Condition | Behaviour |
|---|---|
| Upload > `VIDEO_MAX_UPLOAD_MB` | 413 before writing (checked on `Content-Length` and while streaming) |
| Undecodable file | 400 "Couldn't decode this video — export it as MP4 (H.264) and try again." (file removed) |
| Duration > `VIDEO_MAX_DURATION_S` | 400 "Clip is Xm long; the limit is 15 minutes." (file removed) |
| Worker exception mid-job | job `failed`, `error` human, `detail` technical; upload removed by `finally` |
| Worker killed (OOM/abort) | RQ marks the job failed; orphan uploads older than 1 day removed by a sweep at the start of every video job |
| Results for unknown/foreign job id | 404 |

Frontend surfaces upload/validation failures as toasts (existing toast system)
and job failures on the job card with the human message and `title=detail`.

## Infra changes

- `docker-compose.yml`: `worker-video` service (build like `worker`, command
  `rq worker video`), named volume `video-uploads` mounted at
  `/data/video-uploads` in `api` and `worker-video`; `docker-compose.gpu.yml`
  extends `worker-video` with the GPU reservation like `worker`.
- `frontend/nginx.conf`: a `location /api/video` block with `client_max_body_size 512m;
  proxy_request_buffering off; proxy_read_timeout 300s; proxy_send_timeout 300s;`
  (send timeout needed because buffering is off); all other routes keep the
  25 MB / 90 s defaults.
- Makefile `up`/`rebuild` already build every service; `make logs-worker`
  equivalent for `worker-video`.

## UI (design first)

Designed in the VisageIQ Claude Design project (Miva design system) before
coding — screens: **upload** (drop zone like face search, format/size hints),
**processing** (progress bar with frames processed / faces seen / ETA),
**roll** (cards: crop beside enrolled photo thumbnail, name, ID, programme,
best %, verdict, first–last seen, "seen in N frames"; sort/filter by verdict;
count of unidentified faces), **detail** (existing candidate modal extended:
best full frame with the box, timestamp list as chips that copy `mm:ss`, enrolled
record), **recent jobs** list with status. All errors via toasts / job card.

## Testing

- Unit (`backend/test_video.py`): `sample_indices` (fps math, frame 0 included,
  never exceeds frame_count), `Aggregator` (best-frame replacement, first/last,
  timestamps order, unknown counter), `encode_evidence` (sizes, JPEG magic).
- End-to-end (`scripts/video_smoke.py`, run inside worker-video; asserts and exits 1 on failure): synthesise a 3 s
  clip with `cv2.VideoWriter` from an enrolled student's photo, run
  `run_video_job`, assert that `drive_file_id` appears on the roll with
  `frames_seen ≥ 5` and the upload file is gone afterwards.
- Existing suites unaffected; `_search` relocation covered by the current
  match flow.

## Out of scope (v1)

Live webcam (v2), cancelling a running job, distinct-person clustering of unidentified faces, results
TTL sweep, Drive-link ingestion, seeking inside an in-app video player (the
video is deleted; timestamps are for the operator's own copy).

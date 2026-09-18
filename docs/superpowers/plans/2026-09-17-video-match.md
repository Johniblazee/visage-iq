# Video match (v1: uploaded clips) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a short video clip and get an attendance roll of every enrolled student identifiable in it, with timestamps, the best full frame and a face crop per student — without persisting frames, without touching the enrolled index, and deleting the upload when the job ends.

**Architecture:** `POST /video` streams the upload to a shared volume, probes it, and enqueues a job on a new RQ queue `video` served by a second worker service (`worker-video`, GPU). The worker samples frames in memory, runs the existing detect+embed on each, top-1 searches the gallery (search extracted to `backend/gallery.py` so both API and worker use one implementation), aggregates per enrolled photo, and writes `video_jobs` + `video_sightings` in one transaction. The UI (designed first in the VisageIQ Claude Design project) uploads, polls progress, and renders the roll.

**Tech Stack:** FastAPI, RQ/Redis, psycopg3 + pgvector, OpenCV (bundled ffmpeg), InsightFace on onnxruntime-gpu, React/Vite/TS, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-17-video-match-design.md` · **Branch:** `feat/video-match`

**Conventions for this repo:** never add Claude as co-author; the user commits — each task ends with `git add …` and a paste-ready commit message, not a `git commit`. Tests run with `.venv/Scripts/python -m pytest -q backend`. Builds/deploys go through the GPU overlay: `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build <services>` (or `make up`).

---

## File structure

| File | Responsibility |
|---|---|
| `backend/gallery.py` (new) | Gallery search + verdict, shared by API and worker (moved out of `main.py`) |
| `backend/video.py` (new) | Pure pipeline pieces (`probe`, `sample_indices`, `iter_frames`, `encode_evidence`, `Aggregator`), the per-frame core `match_frame`, and the RQ job `run_video_job` |
| `backend/video_store.py` (new) | All SQL for `video_jobs` / `video_sightings` (api reads + worker writes) |
| `backend/embedding.py` | `embed_frame()` — all faces in a decoded BGR frame, rotation 0, same vector construction as `embed()` |
| `backend/queue.py` | `enqueue_video()` on queue `video` |
| `backend/main.py` | `/video*` endpoints; imports search/verdict from `gallery` |
| `backend/schemas.py` | `VideoJob`, `VideoSighting`, `VideoResults`, `VideoEnqueueResponse` |
| `backend/config.py`, `.env.example`, `README.md` | Six `VIDEO_*` settings |
| `scripts/init_db.sql` | Two tables + index (idempotent) |
| `scripts/video_smoke.py` (new) | End-to-end check with a synthesised clip, run inside `worker-video` |
| `backend/test_video.py` (new) | Unit tests for sampler, evidence encoder, aggregator |
| `docker-compose.yml`, `docker-compose.gpu.yml`, `frontend/nginx.conf`, `Makefile` | `worker-video` service, `video-uploads` volume, upload limits, logs target |
| `frontend/src/components/CandidateModal.tsx` (new, moved from SearchPage) | Detail modal, now with optional video evidence |
| `frontend/src/components/VideoPage.tsx` (new) | Upload → progress → roll → detail, per the Claude Design page |
| `frontend/src/api.ts`, `App.tsx`, `ds.tsx`, `index.css` | Types, nav tab, `video` icon, roll styles |

Task order: **0** (design) runs in parallel with 1–7; **8** waits for 0's approval.

---

### Task 0: Design the "Video match" page in the VisageIQ Claude Design project

**Files:** none in the repo (design project `019dd5ec-fc5e-7751-8244-a35c0ec9b381`)

- [ ] **Step 1: Authorisation** — the user runs `/design-login` once in an interactive Claude Code session on this machine (DesignSync refused with "needs design-system authorization" in the headless session). Until then this task is blocked; Tasks 1–7 proceed.

- [ ] **Step 2: Read the current system** — `DesignSync list_files` on the project; `get_file` the Face search screen HTML (the page whose upload zone, ranked-candidate cards and score bars this page mirrors) and the tokens file. Reuse their classes and tokens verbatim; do not invent new colours.

- [ ] **Step 3: Author one artboard file** `screens/video-match.html` with the four states side by side, in the Miva design language:
  1. **Upload** — drop zone (same look as Face search), hint line "MP4/MOV/AVI/MKV/WebM · up to 500 MB · up to 15 min", recent-jobs list below (filename, when, status badge, students found).
  2. **Processing** — card with filename, progress bar, "frames 240 / 600 · faces seen 37 · ~20 s left".
  3. **Roll** — header "23 students identified · 4 unidentified faces", filter chips All / Match / Review, grid of cards: face crop (left) beside enrolled photo thumb, name, ID · programme, confidence % + verdict badge, "first 00:12 · last 01:48 · seen in 41 frames" (single-frame sightings show a "1 frame" warning tag).
  4. **Detail** — the existing candidate modal extended: best full frame with the red face box in the photo slot, enrolled photo as a small thumb, timestamp chips (`00:12`, `00:14`, …) that copy on click, the student record.

- [ ] **Step 4: Push** — `finalize_plan` with `writes: ["screens/video-match.html"]`, then `write_files`. Tell the user to open it in claude.ai/design and comment.

- [ ] **Step 5: Gate** — iterate until the user approves. Record the approved file path in this plan under Task 8 before starting it.

---

### Task 1: Extract gallery search into `backend/gallery.py`

**Files:**
- Create: `backend/gallery.py`
- Modify: `backend/main.py` (remove `_STUDENT_JOIN`, `_PRIMARY_SEARCH_SQL`, `_ALT_SEARCH_SQL`, `_verdict`, `_search`; import them)

- [ ] **Step 1: Create the module** (bodies are verbatim moves from `main.py`):

```python
"""Gallery search shared by the API (/match, /match-many) and the video worker.

Importable without the FastAPI app: only the DB pool, settings, scoring and
the pydantic result models.
"""
from psycopg import sql as pgsql

from backend import scoring
from backend.config import settings
from backend.db import pool
from backend.embedding import EmbeddingResult
from backend.schemas import Candidate, StudentRef, Verdict

_STUDENT_JOIN = (
    "LEFT JOIN LATERAL (SELECT full_name, student_id, location, programme "
    "                   FROM students st WHERE st.photo_drive_file_id = p.drive_file_id "
    "                   ORDER BY st.id LIMIT 1) s ON TRUE "
)

_PRIMARY_SEARCH_SQL = (
    "SELECT p.drive_file_id, p.drive_file_name, "
    "       1 - (p.face_embedding <=> %s) AS similarity, "
    "       s.full_name, s.student_id, s.location, s.programme "
    "FROM persons p "
    + _STUDENT_JOIN +
    "ORDER BY p.face_embedding <=> %s "
    "LIMIT %s"
)

# Compare-model search. The model name is inlined as a literal (validated
# against the COMPARE_MODELS allowlist first) so the planner can match the
# per-model partial HNSW index — a bind parameter would force a full scan.
_ALT_SEARCH_SQL = pgsql.SQL(
    "SELECT p.drive_file_id, p.drive_file_name, "
    "       1 - (a.embedding <=> %s) AS similarity, "
    "       s.full_name, s.student_id, s.location, s.programme "
    "FROM alt_embeddings a "
    "JOIN persons p ON p.drive_file_id = a.drive_file_id "
    + _STUDENT_JOIN +
    "WHERE a.model = {} "
    "ORDER BY a.embedding <=> %s "
    "LIMIT %s"
)


def verdict(similarity: float, match_t: float, review_t: float) -> Verdict:
    if similarity >= match_t:
        return "MATCH"
    if similarity >= review_t:
        return "REVIEW"
    return "NO_MATCH"


def search(
    result: EmbeddingResult, top_k: int, model: str, match_t: float, review_t: float
) -> list[Candidate]:
    emb = result.embedding
    with pool.connection() as conn, conn.cursor() as cur:
        if model == settings.insightface_model:
            cur.execute(_PRIMARY_SEARCH_SQL, (emb, emb, top_k))
        else:
            cur.execute(_ALT_SEARCH_SQL.format(pgsql.Literal(model)), (emb, emb, top_k))
        rows = cur.fetchall()
    out: list[Candidate] = []
    for file_id, title, sim, s_name, s_sid, s_loc, s_prog in rows:
        sim_f = float(sim)
        out.append(
            Candidate(
                drive_file_id=file_id,
                title=title,
                similarity=sim_f,
                confidence_pct=scoring.confidence_pct(sim_f),
                verdict=verdict(sim_f, match_t, review_t),
                student=StudentRef(
                    full_name=s_name, student_id=s_sid, location=s_loc, programme=s_prog
                ) if s_name else None,
            )
        )
    return out
```

- [ ] **Step 2: Edit `main.py`** — delete the five moved definitions (they sit between `_resolve_model` and `_lookup_modified_time`, plus `_verdict` above `_resolve_model`); import it module-style: `from backend import analytics, audit, gallery, students` and call `gallery.search(...)`/`gallery.verdict(...)`; then `grep -nE "pgsql|scoring\." backend/main.py` and drop `from psycopg import sql as pgsql` / `scoring` from the imports only if no other use remains.

- [ ] **Step 3: Verify** — `python -m py_compile backend/main.py backend/gallery.py` and `.venv/Scripts/python -m pytest -q backend` → `19 passed`. Then deploy the api and run one search from the UI (or `docker compose exec -T api python -c "from backend import gallery; print(gallery.search.__name__)"`).

- [ ] **Step 4: Stage** — `git add backend/gallery.py backend/main.py`
  ```
  refactor(api): move gallery search into backend/gallery.py

  The video worker needs the same top-k search and verdict without
  importing the FastAPI app.
  ```

---

### Task 2: Settings, schema, env template

**Files:**
- Modify: `backend/config.py` (after `sync_rate_limit`), `scripts/init_db.sql` (append), `.env.example` (append), `README.md` (config table)

- [ ] **Step 1: Settings**

```python
    # --- video match (uploaded clips; see docs/superpowers/specs/2026-09-17-video-match-design.md) ---
    video_sample_fps: float = 2.0        # frames analysed per second of video
    video_min_face_px: int = 40          # skip detections whose bbox short side is smaller
    video_max_upload_mb: int = 500
    video_max_duration_s: int = 900
    video_upload_dir: str = "/data/video-uploads"   # shared volume: api writes, worker-video reads+deletes
    video_rate_limit: str = "10/hour"
```

- [ ] **Step 2: Schema** (append to `scripts/init_db.sql`):

```sql
-- Video match: one row per uploaded clip, one per enrolled photo seen in it.
-- Evidence is two small JPEGs per sighting; no embeddings, no frames.
CREATE TABLE IF NOT EXISTS video_jobs (
    id               UUID PRIMARY KEY,
    actor            TEXT NOT NULL,
    filename         TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    upload_path      TEXT,                     -- NULL once the file is deleted
    status           TEXT NOT NULL,            -- queued | running | done | failed
    error            TEXT,
    detail           TEXT,
    duration_s       REAL,
    fps              REAL,
    width            INT,
    height           INT,
    sampled_frames   INT NOT NULL DEFAULT 0,
    faces_seen       INT NOT NULL DEFAULT 0,
    unknown_faces    INT NOT NULL DEFAULT 0,
    match_threshold  REAL,
    review_threshold REAL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS video_sightings (
    job_id           UUID NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
    drive_file_id    TEXT NOT NULL,
    best_similarity  REAL NOT NULL,
    best_ts          REAL NOT NULL,
    first_ts         REAL NOT NULL,
    last_ts          REAL NOT NULL,
    frames_seen      INT NOT NULL,
    timestamps       REAL[] NOT NULL,
    frame_jpeg       BYTEA NOT NULL,
    crop_jpeg        BYTEA NOT NULL,
    PRIMARY KEY (job_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS video_jobs_created_idx ON video_jobs (created_at DESC);
```

- [ ] **Step 3: `.env.example`** (append):

```
# Video match (uploaded clips). Frames are analysed in memory and the upload is
# deleted when the job ends; only per-student evidence JPEGs are kept.
VIDEO_SAMPLE_FPS=2
VIDEO_MIN_FACE_PX=40
VIDEO_MAX_UPLOAD_MB=500
VIDEO_MAX_DURATION_S=900
VIDEO_RATE_LIMIT=10/hour
```

- [ ] **Step 4: README** — add the six keys to the configuration table with the meanings above.

- [ ] **Step 5: Verify** — `.venv/Scripts/python -c "from backend.config import settings; print(settings.video_sample_fps, settings.video_upload_dir)"` → `2.0 /data/video-uploads`. Deploy the api (it runs `init_db.sql` on start) and check: `docker compose -p facial-recognition exec -T worker python -c "from backend.db import pool; from backend.sync import _ensure_pool_open; _ensure_pool_open(); exec('with pool.connection() as c, c.cursor() as cur:
    cur.execute(\"SELECT to_regclass('video_jobs'), to_regclass('video_sightings')\"); print(cur.fetchone())')"` (`pool.connection()` is a context manager) → `('video_jobs', 'video_sightings')`.

- [ ] **Step 6: Stage** — `git add backend/config.py scripts/init_db.sql .env.example README.md`
  ```
  feat(video): settings and tables for video match jobs
  ```

---

### Task 3: Pure pipeline pieces with tests

**Files:**
- Create: `backend/video.py` (part 1), `backend/test_video.py`

- [ ] **Step 1: Write the failing tests** (`backend/test_video.py`):

```python
import io

import numpy as np
from PIL import Image

from backend.video import Aggregator, Hit, encode_evidence, sample_indices


def test_sample_indices_spacing_and_bounds():
    idx = sample_indices(frame_count=250, fps=25.0, sample_fps=2.0)
    assert idx[0] == 0
    assert idx == sorted(set(idx))
    assert all(0 <= i < 250 for i in idx)
    assert 19 <= len(idx) <= 21                          # ~2 per second over 10 s
    assert sample_indices(5, 25.0, 2.0) == [0]           # shorter than one interval
    assert sample_indices(0, 25.0, 2.0) == []
    assert len(sample_indices(100, 25.0, 1000.0)) == 100  # never denser than every frame


def test_encode_evidence_is_jpeg_and_capped():
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    frame_jpeg, crop_jpeg = encode_evidence(frame, [600, 300, 700, 420])
    assert frame_jpeg[:2] == b"\xff\xd8" and crop_jpeg[:2] == b"\xff\xd8"
    with Image.open(io.BytesIO(frame_jpeg)) as im:
        assert max(im.size) <= 1280
    with Image.open(io.BytesIO(crop_jpeg)) as im:
        assert max(im.size) <= 256


def _hit(fid, sim):
    return Hit(bbox=[10, 10, 90, 110], det_score=0.9, drive_file_id=fid, similarity=sim)


def test_aggregator_keeps_best_evidence_and_all_timestamps():
    frame = np.zeros((200, 200, 3), dtype=np.uint8)
    agg = Aggregator()
    agg.add(1.0, _hit("A", 0.50), frame)
    agg.add(1.5, _hit("A", 0.62), frame)   # better -> evidence replaced
    agg.add(2.0, _hit("A", 0.55), frame)
    agg.add(2.0, _hit(None, 0.20), frame)  # unidentified face
    agg.add(3.0, _hit("B", 0.48), frame)
    s = {x.drive_file_id: x for x in agg.sightings()}
    assert s["A"].best_similarity == 0.62 and s["A"].best_ts == 1.5
    assert s["A"].first_ts == 1.0 and s["A"].last_ts == 2.0
    assert s["A"].timestamps == [1.0, 1.5, 2.0] and s["A"].frames_seen == 3
    assert s["B"].frames_seen == 1
    assert agg.unknown_faces == 1
    assert [x.drive_file_id for x in agg.sightings()] == ["A", "B"]  # best first
```

- [ ] **Step 2: Run to see them fail** — `.venv/Scripts/python -m pytest -q backend/test_video.py` → `ImportError: cannot import name ... from 'backend.video'` (module missing).

- [ ] **Step 3: Implement** (`backend/video.py`):

```python
"""Video match: sample an uploaded clip, match every face against the gallery,
keep per-student evidence. Runs on the `video` RQ queue (worker-video).

Hard rules (docs/superpowers/specs/2026-09-17-video-match-design.md): frames
stay in memory, nothing is written to the enrolled index, the upload is
deleted when the job ends.
"""
import logging
import os
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

logger = logging.getLogger(__name__)

FRAME_MAX_SIDE = 1280   # evidence frame, longest side
CROP_SIDE = 256         # evidence face crop, longest side
CROP_PAD = 0.30         # padding around the bbox as a fraction of its size
BOX_BGR = (49, 59, 228)  # --miva-red
ORPHAN_MAX_AGE_S = 24 * 3600


class VideoError(Exception):
    """Human-readable; becomes the upload/job error message."""


@dataclass
class VideoInfo:
    fps: float
    frame_count: int
    duration_s: float
    width: int
    height: int


def probe(path: str) -> VideoInfo:
    """Open with OpenCV's bundled ffmpeg and read one frame; anything that
    fails here is rejected before a job is queued."""
    cap = cv2.VideoCapture(path)
    try:
        ok, _ = cap.read()
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()
    if not ok or fps <= 0 or frames <= 0 or width <= 0 or height <= 0:
        raise VideoError("Couldn't decode this video — export it as MP4 (H.264) and try again.")
    return VideoInfo(fps=fps, frame_count=frames, duration_s=frames / fps, width=width, height=height)


def sample_indices(frame_count: int, fps: float, sample_fps: float) -> list[int]:
    """Frame indices to analyse: one every fps/sample_fps frames (never denser
    than every frame), always starting at 0."""
    if frame_count <= 0:
        return []
    step = max(1, int(round(fps / sample_fps))) if sample_fps > 0 else 1
    return list(range(0, frame_count, step))


def iter_frames(path: str, indices: list[int]):
    """Yield (index, ts_seconds, frame_bgr) for the requested indices using a
    sequential grab/retrieve — seeking in long-GOP CCTV files is slow and
    inexact, decoding only the wanted frames keeps it linear and cheap."""
    if not indices:
        return
    wanted, last = set(indices), max(indices)
    cap = cv2.VideoCapture(path)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    try:
        i = 0
        while i <= last and cap.grab():
            if i in wanted:
                ok, frame = cap.retrieve()
                if ok:
                    yield i, i / fps, frame
            i += 1
    finally:
        cap.release()


def _jpeg(img: np.ndarray, quality: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise VideoError("Couldn't encode an evidence frame")
    return buf.tobytes()


def _fit(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1:
        return img
    return cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


def encode_evidence(frame: np.ndarray, bbox: list[int]) -> tuple[bytes, bytes]:
    """(full frame with the face box drawn, padded face crop) as JPEG bytes."""
    x1, y1, x2, y2 = bbox
    h, w = frame.shape[:2]
    boxed = frame.copy()
    cv2.rectangle(boxed, (x1, y1), (x2, y2), BOX_BGR, 3)
    pad_x, pad_y = int((x2 - x1) * CROP_PAD), int((y2 - y1) * CROP_PAD)
    crop = frame[max(0, y1 - pad_y):min(h, y2 + pad_y), max(0, x1 - pad_x):min(w, x2 + pad_x)]
    if crop.size == 0:
        crop = frame
    return _jpeg(_fit(boxed, FRAME_MAX_SIDE), 80), _jpeg(_fit(crop, CROP_SIDE), 85)


@dataclass
class Hit:
    bbox: list[int]
    det_score: float
    drive_file_id: str | None      # None = no gallery match at or above the review floor
    similarity: float


@dataclass
class Sighting:
    drive_file_id: str
    best_similarity: float
    best_ts: float
    first_ts: float
    last_ts: float
    frames_seen: int
    timestamps: list[float] = field(default_factory=list)
    frame_jpeg: bytes = b""
    crop_jpeg: bytes = b""


class Aggregator:
    """Per-enrolled-photo roll. Evidence is re-encoded only when the score
    improves, so memory stays ~150 KB per student regardless of clip length."""

    def __init__(self) -> None:
        self._by_id: dict[str, Sighting] = {}
        self.unknown_faces = 0

    def add(self, ts: float, hit: Hit, frame: np.ndarray) -> None:
        if hit.drive_file_id is None:
            self.unknown_faces += 1
            return
        s = self._by_id.get(hit.drive_file_id)
        if s is None:
            frame_jpeg, crop_jpeg = encode_evidence(frame, hit.bbox)
            self._by_id[hit.drive_file_id] = Sighting(
                drive_file_id=hit.drive_file_id, best_similarity=hit.similarity, best_ts=ts,
                first_ts=ts, last_ts=ts, frames_seen=1, timestamps=[ts],
                frame_jpeg=frame_jpeg, crop_jpeg=crop_jpeg,
            )
            return
        s.frames_seen += 1
        s.timestamps.append(ts)
        s.first_ts, s.last_ts = min(s.first_ts, ts), max(s.last_ts, ts)
        if hit.similarity > s.best_similarity:
            s.best_similarity, s.best_ts = hit.similarity, ts
            s.frame_jpeg, s.crop_jpeg = encode_evidence(frame, hit.bbox)

    def sightings(self) -> list[Sighting]:
        return sorted(self._by_id.values(), key=lambda s: -s.best_similarity)


def sweep_orphans(upload_dir: str, max_age_s: int = ORPHAN_MAX_AGE_S) -> int:
    """Remove uploads left behind by a killed worker (older than a day)."""
    removed = 0
    try:
        for name in os.listdir(upload_dir):
            p = os.path.join(upload_dir, name)
            if os.path.isfile(p) and time.time() - os.path.getmtime(p) > max_age_s:
                os.remove(p)
                removed += 1
    except FileNotFoundError:
        pass
    return removed
```

- [ ] **Step 4: Run the tests** — `.venv/Scripts/python -m pytest -q backend/test_video.py` → `3 passed`. Full suite → `22 passed`.

- [ ] **Step 5: Stage** — `git add backend/video.py backend/test_video.py`
  ```
  feat(video): frame sampler, evidence encoder and per-student aggregator
  ```

---

### Task 4: Per-frame core, job runner, store and queue

**Files:**
- Modify: `backend/embedding.py` (add `embed_frame` after `embed_many`), `backend/video.py` (append), `backend/queue.py`
- Create: `backend/video_store.py`

- [ ] **Step 1: `embed_frame`** (`backend/embedding.py`, same construction as `embed()`):

```python
def embed_frame(frame_bgr: np.ndarray, profile: str = "match", model: str | None = None) -> list[EmbeddingResult]:
    """All faces in an already-decoded BGR frame at rotation 0 (video frames
    are upright; the rotation search exists for scanned passports)."""
    faces = get_app(profile, model).get(frame_bgr)
    return [
        EmbeddingResult(
            embedding=np.asarray(face.normed_embedding, dtype=np.float32),
            bbox=[int(v) for v in face.bbox],
            det_score=float(face.det_score),
            face_count=len(faces),
            rotation=0,
        )
        for face in faces
    ]
```

- [ ] **Step 2: Store** (`backend/video_store.py`):

```python
"""SQL for video jobs and sightings. The api reads and creates jobs; the
worker-video updates status and writes results. Never touches persons."""
import uuid
from typing import Any

from backend.db import pool

JOB_COLS = ("id, actor, filename, size_bytes, upload_path, status, error, detail, duration_s, fps, "
            "width, height, sampled_frames, faces_seen, unknown_faces, match_threshold, "
            "review_threshold, created_at, started_at, finished_at")
_KEYS = [c.strip() for c in JOB_COLS.split(",")]


def _job(r) -> dict[str, Any]:
    d = dict(zip(_KEYS, r))
    d["id"] = str(d["id"])
    for k in ("created_at", "started_at", "finished_at"):
        d[k] = d[k].isoformat() if d[k] else None
    return d


def create_job(job_id: str, actor: str, filename: str, size_bytes: int, upload_path: str,
               info, match_t: float, review_t: float) -> None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO video_jobs (id, actor, filename, size_bytes, upload_path, status,
                                       duration_s, fps, width, height, match_threshold, review_threshold)
               VALUES (%s, %s, %s, %s, %s, 'queued', %s, %s, %s, %s, %s, %s)""",
            (uuid.UUID(job_id), actor, filename, size_bytes, upload_path,
             info.duration_s, info.fps, info.width, info.height, match_t, review_t),
        )
        conn.commit()


def set_status(job_id: str, status: str, *, error: str | None = None, detail: str | None = None) -> None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE video_jobs SET status = %s, error = %s, detail = %s,
                   started_at = CASE WHEN %s = 'running' THEN NOW() ELSE started_at END,
                   finished_at = CASE WHEN %s IN ('done', 'failed') THEN NOW() ELSE finished_at END,
                   upload_path = CASE WHEN %s IN ('done', 'failed') THEN NULL ELSE upload_path END
               WHERE id = %s""",
            (status, error, detail, status, status, status, uuid.UUID(job_id)),
        )
        conn.commit()


def write_results(job_id: str, sampled_frames: int, faces_seen: int, unknown_faces: int, sightings) -> None:
    jid = uuid.UUID(job_id)
    with pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO video_sightings (job_id, drive_file_id, best_similarity, best_ts, first_ts,
                                            last_ts, frames_seen, timestamps, frame_jpeg, crop_jpeg)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (job_id, drive_file_id) DO UPDATE SET
                   best_similarity = EXCLUDED.best_similarity, best_ts = EXCLUDED.best_ts,
                   first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts,
                   frames_seen = EXCLUDED.frames_seen, timestamps = EXCLUDED.timestamps,
                   frame_jpeg = EXCLUDED.frame_jpeg, crop_jpeg = EXCLUDED.crop_jpeg""",
            [(jid, s.drive_file_id, s.best_similarity, s.best_ts, s.first_ts, s.last_ts,
              s.frames_seen, s.timestamps, s.frame_jpeg, s.crop_jpeg) for s in sightings],
        )
        cur.execute(
            """UPDATE video_jobs SET status = 'done', sampled_frames = %s, faces_seen = %s,
                   unknown_faces = %s, finished_at = NOW(), upload_path = NULL WHERE id = %s""",
            (sampled_frames, faces_seen, unknown_faces, jid),
        )
        conn.commit()


def get_job(job_id: str) -> dict[str, Any] | None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {JOB_COLS} FROM video_jobs WHERE id = %s", (uuid.UUID(job_id),))
        r = cur.fetchone()
    return _job(r) if r else None


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {JOB_COLS} FROM video_jobs ORDER BY created_at DESC LIMIT %s", (limit,))
        return [_job(r) for r in cur.fetchall()]


def results(job_id: str) -> list[dict[str, Any]]:
    """Sightings joined to the enrolled photo name and the student record —
    evidence bytes are served by evidence(), not here."""
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT v.drive_file_id, p.drive_file_name, v.best_similarity, v.best_ts, v.first_ts,
                      v.last_ts, v.frames_seen, v.timestamps,
                      s.full_name, s.student_id, s.location, s.programme
               FROM video_sightings v
               LEFT JOIN persons p ON p.drive_file_id = v.drive_file_id
               LEFT JOIN LATERAL (SELECT full_name, student_id, location, programme FROM students st
                                  WHERE st.photo_drive_file_id = v.drive_file_id ORDER BY st.id LIMIT 1) s ON TRUE
               WHERE v.job_id = %s ORDER BY v.best_similarity DESC""",
            (uuid.UUID(job_id),),
        )
        rows = cur.fetchall()
    return [
        {"drive_file_id": r[0], "title": r[1], "best_similarity": float(r[2]), "best_ts": float(r[3]),
         "first_ts": float(r[4]), "last_ts": float(r[5]), "frames_seen": r[6],
         "timestamps": [float(t) for t in r[7]],
         "student": {"full_name": r[8], "student_id": r[9], "location": r[10], "programme": r[11]} if r[8] else None}
        for r in rows
    ]


def evidence(job_id: str, drive_file_id: str, kind: str) -> bytes | None:
    col = {"frame": "frame_jpeg", "crop": "crop_jpeg"}[kind]
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {col} FROM video_sightings WHERE job_id = %s AND drive_file_id = %s",
                    (uuid.UUID(job_id), drive_file_id))
        r = cur.fetchone()
    return bytes(r[0]) if r else None


def delete_job(job_id: str) -> bool:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM video_jobs WHERE id = %s", (uuid.UUID(job_id),))
        n = cur.rowcount
        conn.commit()
    return n > 0
```

- [ ] **Step 3: Per-frame core and job** (append to `backend/video.py`):

```python
def match_frame(frame: np.ndarray, min_face_px: int, match_t: float, review_t: float, model: str) -> list[Hit]:
    """The shared per-frame core (live webcam in v2 feeds it too): detect,
    drop tiny faces, top-1 gallery search, floor at the review threshold.
    Read-only against the gallery."""
    from backend.embedding import embed_frame
    from backend.gallery import search

    hits: list[Hit] = []
    for face in embed_frame(frame, model=model):
        x1, y1, x2, y2 = face.bbox
        if min(x2 - x1, y2 - y1) < min_face_px:
            continue
        top = next(iter(search(face, 1, model, match_t, review_t)), None)
        if top is not None and top.similarity >= review_t:
            hits.append(Hit(face.bbox, face.det_score, top.drive_file_id, top.similarity))
        else:
            hits.append(Hit(face.bbox, face.det_score, None, top.similarity if top else 0.0))
    return hits


def _progress(job, phase: str, current: int, total: int, faces_seen: int) -> None:
    if job is None:
        return
    job.meta["progress"] = {"phase": phase, "current": current, "total": total, "faces_seen": faces_seen}
    try:
        job.save_meta()
    except Exception:
        logger.debug("progress save failed", exc_info=True)


def run_video_job(job_id: str) -> dict:
    """RQ entrypoint on queue `video`. The upload is removed in `finally`
    whatever happens; results land in one transaction."""
    from backend import video_store
    from backend.config import settings
    from backend.sync import _current_job, _ensure_pool_open

    _ensure_pool_open()
    sweep_orphans(settings.video_upload_dir)
    job = _current_job()
    row = video_store.get_job(job_id)
    if row is None or not row["upload_path"]:
        raise VideoError(f"video job {job_id} has no upload to process")
    path = row["upload_path"]
    faces_seen = sampled = 0
    video_store.set_status(job_id, "running")
    try:
        info = probe(path)
        indices = sample_indices(info.frame_count, info.fps, settings.video_sample_fps)
        total = len(indices)
        agg = Aggregator()
        _progress(job, "matching", 0, total, 0)
        for sampled, (_, ts, frame) in enumerate(iter_frames(path, indices), start=1):
            hits = match_frame(frame, settings.video_min_face_px, row["match_threshold"],
                               row["review_threshold"], settings.insightface_model)
            for hit in hits:
                agg.add(ts, hit, frame)
            faces_seen += len(hits)
            if sampled % 25 == 0 or sampled == total:
                _progress(job, "matching", sampled, total, faces_seen)
        _progress(job, "writing", sampled, total, faces_seen)
        sightings = agg.sightings()
        video_store.write_results(job_id, sampled, faces_seen, agg.unknown_faces, sightings)
        logger.info("[video %s] done: %d frames, %d faces, %d students, %d unidentified",
                    job_id[:8], sampled, faces_seen, len(sightings), agg.unknown_faces)
        return {"ok": True, "sampled_frames": sampled, "faces_seen": faces_seen,
                "students": len(sightings), "unknown_faces": agg.unknown_faces}
    except VideoError as exc:
        video_store.set_status(job_id, "failed", error=str(exc))
        raise
    except Exception as exc:
        video_store.set_status(job_id, "failed",
                               error="Video processing failed unexpectedly — see the worker-video logs.",
                               detail=str(exc)[:500])
        raise
    finally:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
```

- [ ] **Step 4: Queue** (`backend/queue.py`, after `enqueue_students_sync`):

```python
VIDEO_QUEUE = "video"
VIDEO_JOB_TIMEOUT = 30 * 60


def enqueue_video(job_id: str) -> str:
    # RQ job id == video_jobs.id so the API can read progress by the same key.
    job = Queue(VIDEO_QUEUE, connection=get_redis()).enqueue(
        "backend.video.run_video_job", job_id, job_id=job_id, job_timeout=VIDEO_JOB_TIMEOUT,
    )
    return job.id


def fetch_video_job(job_id: str):
    # Queue.fetch_job returns None for jobs whose origin is another queue.
    return Queue(VIDEO_QUEUE, connection=get_redis()).fetch_job(job_id)
```
Put the two constants next to `SYNC_QUEUE` / `SYNC_JOB_TIMEOUT` at the top of the file.

- [ ] **Step 5: Verify** — `python -m py_compile backend/video.py backend/video_store.py backend/queue.py backend/embedding.py`; `.venv/Scripts/python -m pytest -q backend` → `22 passed` (the job needs a live DB; Task 7 exercises it).

- [ ] **Step 6: Stage** — `git add backend/embedding.py backend/video.py backend/video_store.py backend/queue.py`
  ```
  feat(video): per-frame gallery match, job runner, store and queue

  match_frame is the shared core the live-webcam path will reuse. The job
  keeps frames in memory, writes results in one transaction and removes
  the upload in finally.
  ```

---

### Task 5: API endpoints and schemas

**Files:**
- Modify: `backend/schemas.py` (append), `backend/main.py`

- [ ] **Step 1: Schemas**

```python
class VideoEnqueueResponse(BaseModel):
    job_id: str


class VideoJob(BaseModel):
    id: str
    actor: str
    filename: str
    size_bytes: int
    status: str
    error: str | None = None
    detail: str | None = None
    duration_s: float | None = None
    fps: float | None = None
    width: int | None = None
    height: int | None = None
    sampled_frames: int = 0
    faces_seen: int = 0
    unknown_faces: int = 0
    match_threshold: float | None = None
    review_threshold: float | None = None
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    progress: dict | None = None


class VideoSighting(BaseModel):
    drive_file_id: str
    title: str | None = None
    student: StudentRef | None = None
    best_similarity: float
    confidence_pct: float
    verdict: Verdict
    best_ts: float
    first_ts: float
    last_ts: float
    frames_seen: int
    timestamps: list[float]


class VideoResults(BaseModel):
    job: VideoJob
    sightings: list[VideoSighting]
```

- [ ] **Step 2: Endpoints** (`backend/main.py`; add `import os, uuid`, `from fastapi.concurrency import run_in_threadpool`, `from backend import video_store` (and `gallery` is already imported as a module by Task 1), `from backend.video import VideoError, probe`, `enqueue_video, fetch_video_job` to the queue import, and the four schemas):

```python
def _rm(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _video_job(job_id: str) -> VideoJob:
    row = video_store.get_job(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Video job not found")
    row.pop("upload_path", None)
    progress = None
    if row["status"] in ("queued", "running"):
        job = fetch_video_job(job_id)  # Queue.fetch_job filters by origin queue; the sync-queue fetch_job returns None here
        progress = (job.meta or {}).get("progress") if job is not None else None
    return VideoJob(**row, progress=progress)


@app.post("/video", response_model=VideoEnqueueResponse)
@limiter.limit(settings.video_rate_limit)
async def video_upload(request: Request, file: UploadFile = File(...)) -> VideoEnqueueResponse:
    limit = settings.video_max_upload_mb * 1024 * 1024
    too_big = HTTPException(status_code=413, detail=f"Video is too large — the limit is {settings.video_max_upload_mb} MB.")
    if int(request.headers.get("content-length") or 0) > limit + 1024 * 1024:
        raise too_big
    job_id = str(uuid.uuid4())
    ext = os.path.splitext(file.filename or "")[1].lower()[:8] or ".bin"
    os.makedirs(settings.video_upload_dir, exist_ok=True)
    path = os.path.join(settings.video_upload_dir, f"{job_id}{ext}")
    size = 0
    try:
        with open(path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise too_big
                out.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty file")
        info = await run_in_threadpool(probe, path)
        if info.duration_s > settings.video_max_duration_s:
            raise HTTPException(
                status_code=400,
                detail=f"Clip is {info.duration_s / 60:.1f} min long; the limit is {settings.video_max_duration_s // 60} minutes.",
            )
    except VideoError as exc:
        _rm(path)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        _rm(path)
        raise
    match_t, review_t, _ = _effective_config()
    actor = actor_of(request)
    video_store.create_job(job_id, actor, file.filename or "video", size, path, info, match_t, review_t)
    enqueue_video(job_id)
    audit.record(actor, "video_upload", target=job_id,
                 details={"filename": file.filename, "size_bytes": size, "duration_s": round(info.duration_s, 1)})
    return VideoEnqueueResponse(job_id=job_id)


@app.get("/video", response_model=list[VideoJob])
def video_jobs(request: Request) -> list[VideoJob]:
    out = []
    for row in video_store.list_jobs():
        row.pop("upload_path", None)
        out.append(VideoJob(**row))
    return out


@app.get("/video/{job_id}", response_model=VideoJob)
def video_job(request: Request, job_id: str) -> VideoJob:
    return _video_job(job_id)


@app.get("/video/{job_id}/results", response_model=VideoResults)
def video_results(request: Request, job_id: str) -> VideoResults:
    job = _video_job(job_id)
    match_t = job.match_threshold or settings.match_threshold
    review_t = job.review_threshold or settings.review_threshold
    sightings = [
        VideoSighting(
            **{k: v for k, v in r.items() if k != "student"},
            student=StudentRef(**r["student"]) if r["student"] else None,
            confidence_pct=scoring.confidence_pct(r["best_similarity"]),
            verdict=gallery.verdict(r["best_similarity"], match_t, review_t),
        )
        for r in video_store.results(job_id)
    ]
    audit.record(actor_of(request), "video_results", target=job_id, details={"students": len(sightings)})
    return VideoResults(job=job, sightings=sightings)


@app.get("/video/{job_id}/{kind}/{drive_file_id}")
def video_evidence(request: Request, job_id: str, kind: Literal["frame", "crop"], drive_file_id: str) -> Response:
    data = video_store.evidence(job_id, drive_file_id, kind)
    if data is None:
        raise HTTPException(status_code=404, detail="No evidence for this student in this job")
    audit.record(actor_of(request), "image_view", target=drive_file_id, details={"video_job": job_id, "kind": kind})
    return Response(content=data, media_type="image/jpeg")


@app.delete("/video/{job_id}")
def video_delete(request: Request, job_id: str) -> dict:
    if not video_store.delete_job(job_id):
        raise HTTPException(status_code=404, detail="Video job not found")
    audit.record(actor_of(request), "video_delete", target=job_id)
    return {"deleted": job_id}
```
Register `video_evidence` **after** `video_results` (both match `/video/{id}/…`; `results` has no third segment so it's unambiguous, but keep the order for readability).

- [ ] **Step 3: Verify** — `python -m py_compile backend/main.py backend/schemas.py`; full pytest `22 passed`; deploy api and worker-video is not needed yet — call `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/video` → `401` (auth on, route exists). In dev mode (empty Clerk keys) it returns `200 []`.

- [ ] **Step 4: Stage** — `git add backend/main.py backend/schemas.py`
  ```
  feat(api): video upload, job status, results and evidence endpoints
  ```

---

### Task 6: Infrastructure — worker-video, shared volume, nginx, Makefile

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.gpu.yml`, `frontend/nginx.conf`, `Makefile`

- [ ] **Step 1: compose** — after the `worker` service:

```yaml
  worker-video:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    env_file: .env
    volumes:
      - insightface-models:/root/.insightface
      - video-uploads:/data/video-uploads
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: ["rq", "worker", "--url", "redis://redis:6379/0", "video"]
```
Add `- video-uploads:/data/video-uploads` to the `api` service's `volumes` (create the key if the service has none), and `video-uploads:` under top-level `volumes:`.

- [ ] **Step 2: GPU overlay** — add a `worker-video:` block identical to `worker:` (Dockerfile.gpu + the nvidia reservation).

- [ ] **Step 3: nginx** — keep the server-level `client_max_body_size 25m;` and the `/api/` block as they are; add, BEFORE `location /api/`, a dedicated block so only video uploads get the big limit and unbuffered streaming (a server-wide 512 MB would let `/match` swallow a 500 MB image into memory):
```
  # Video uploads: big bodies streamed straight to the api (no nginx buffering).
  location /api/video {
    client_max_body_size 512m;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_pass ${API_BASE_URL}/video;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
```

- [ ] **Step 4: Makefile** — after `logs-worker`:
```
logs-worker-video:  ## Tail logs for the video worker container
	$(COMPOSE) logs -f worker-video
```
(copy the exact recipe form of `logs-worker`).

- [ ] **Step 5: Verify** — `make up` (GPU auto-detected; the two new services build in seconds from cached layers) then `docker compose ps` shows `worker-video Up`; `docker compose logs worker-video | tail -3` shows `*** Listening on video...`; `docker compose exec -T api sh -c "ls -ld /data/video-uploads"` and the same in `worker-video` both succeed.

- [ ] **Step 6: Stage** — `git add docker-compose.yml docker-compose.gpu.yml frontend/nginx.conf Makefile`
  ```
  infra: worker-video service, shared upload volume, 512 MB uploads
  ```

---

### Task 7: End-to-end smoke with a synthesised clip

**Files:**
- Create: `scripts/video_smoke.py`

- [ ] **Step 1: Script** (runs inside `worker-video`; makes a 3 s clip from a random enrolled student's photo, runs the job, asserts the roll):

```python
"""Video match smoke test. Run: docker compose exec -T worker-video python -m scripts.video_smoke
Synthesises a 3 s clip from an enrolled student's passport photo, runs the
job in-process and asserts that student is on the roll and the upload is gone."""
import os
import sys
import uuid

import cv2
import numpy as np

from backend import video_store
from backend.config import settings
from backend.db import pool
from backend.embedding import _decode
from backend.gdrive import download_bytes
from backend.sync import _ensure_pool_open
from backend.video import probe, run_video_job


def main() -> int:
    _ensure_pool_open()
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""SELECT p.drive_file_id, s.full_name FROM persons p
                       JOIN students s ON s.photo_drive_file_id = p.drive_file_id
                       ORDER BY random() LIMIT 1""")
        fid, name = cur.fetchone()
    photo = _decode(download_bytes(fid))                      # BGR ndarray, EXIF-corrected
    h, w = photo.shape[:2]
    canvas = np.full((720, 1280, 3), 40, dtype=np.uint8)      # dark room, photo pasted centre
    scale = min(600 / h, 900 / w)
    face = cv2.resize(photo, (int(w * scale), int(h * scale)))
    y0, x0 = (720 - face.shape[0]) // 2, (1280 - face.shape[1]) // 2
    canvas[y0:y0 + face.shape[0], x0:x0 + face.shape[1]] = face

    job_id = str(uuid.uuid4())
    os.makedirs(settings.video_upload_dir, exist_ok=True)
    path = os.path.join(settings.video_upload_dir, f"{job_id}.mp4")
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (1280, 720))
    for i in range(75):                                        # 3 s; drift the photo so frames differ
        frame = np.roll(canvas, i * 2, axis=1)
        out.write(frame)
    out.release()

    info = probe(path)
    video_store.create_job(job_id, "smoke", "smoke.mp4", os.path.getsize(path), path, info,
                           settings.match_threshold, settings.review_threshold)
    summary = run_video_job(job_id)
    rows = video_store.results(job_id)
    hit = next((r for r in rows if r["drive_file_id"] == fid), None)
    print("summary:", summary)
    print("expected:", name, fid, "| found:", hit and {k: hit[k] for k in ("best_similarity", "frames_seen", "first_ts", "last_ts")})
    ok = hit is not None and hit["frames_seen"] >= 5 and not os.path.exists(path)
    assert video_store.evidence(job_id, fid, "frame")[:2] == b"\xff\xd8"
    video_store.delete_job(job_id)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run** — `docker compose exec -T worker-video python -m scripts.video_smoke` → `PASS`, `frames_seen` ≥ 5 (6 sampled frames at 2 fps over 3 s), `best_similarity` ≥ 0.8 (near-duplicate of the enrolled photo), summary `unknown_faces: 0`. Also run it once against a real clip: copy one of the DVR exports into the volume (`docker compose cp clip.mp4 worker-video:/data/video-uploads/`) and exercise the same path via the API in Task 8.

- [ ] **Step 3: Stage** — `git add scripts/video_smoke.py`
  ```
  test(video): end-to-end smoke with a synthesised clip
  ```

---

### Task 8: Frontend — Video match page (after Task 0 is approved)

**Files:**
- Create: `frontend/src/components/VideoPage.tsx`, `frontend/src/components/CandidateModal.tsx`
- Modify: `frontend/src/api.ts`, `frontend/src/components/SearchPage.tsx` (import the moved modal), `frontend/src/App.tsx`, `frontend/src/ds.tsx`, `frontend/src/index.css`

Visual structure follows the approved design file `screens/video-match.html` (Task 0); the data flow below is fixed.

- [ ] **Step 1: Types** (`api.ts`):

```ts
export interface VideoJob {
  id: string;
  actor: string;
  filename: string;
  size_bytes: number;
  status: "queued" | "running" | "done" | "failed";
  error?: string | null;
  detail?: string | null;
  duration_s?: number | null;
  fps?: number | null;
  sampled_frames: number;
  faces_seen: number;
  unknown_faces: number;
  created_at?: string | null;
  finished_at?: string | null;
  progress?: { phase: string; current: number; total: number; faces_seen: number } | null;
}

export interface VideoSighting {
  drive_file_id: string;
  title?: string | null;
  student?: CandidateStudent | null;
  best_similarity: number;
  confidence_pct: number;
  verdict: "MATCH" | "REVIEW" | "NO_MATCH";
  best_ts: number;
  first_ts: number;
  last_ts: number;
  frames_seen: number;
  timestamps: number[];
}

export interface VideoResults {
  job: VideoJob;
  sightings: VideoSighting[];
}
```

- [ ] **Step 2: Move the modal** — cut `CandidateModal` from `SearchPage.tsx` into `components/CandidateModal.tsx` (export default), add an optional prop `evidence?: { frameUrl: string; timestamps: number[] }`: when present, the photo slot shows `frameUrl` (the boxed video frame) and the enrolled photo becomes a 96 px thumb beside the score; below the score bar render the timestamps as chips (`mm:ss`, `onClick` copies to the clipboard via `navigator.clipboard.writeText`). `SearchPage.tsx` imports it unchanged.

- [ ] **Step 3: Page** (`VideoPage.tsx`; primitives from `ds.tsx`, toasts for errors):

```tsx
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { Cfg } from "../App";
import { apiRequest, apiUrl, errorMessage, type VideoJob, type VideoResults, type VideoSighting } from "../api";
import { Button, Icon, Panel, ScoreBar, Verdict, toast } from "../ds";
import { formatNumber, relativeTime } from "../format";
import CandidateModal from "./CandidateModal";

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function VideoPage({ cfg }: { cfg: Cfg }) {
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [active, setActive] = useState<VideoJob | null>(null);
  const [results, setResults] = useState<VideoResults | null>(null);
  const [filter, setFilter] = useState<"ALL" | "MATCH" | "REVIEW">("ALL");
  const [open, setOpen] = useState<{ s: VideoSighting; rank: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function loadJobs() {
    try { setJobs(await apiRequest<VideoJob[]>("/video")); } catch { /* topbar shows API state */ }
  }
  useEffect(() => { loadJobs(); }, []);

  // Poll the active job until it settles, then fetch the roll.
  useEffect(() => {
    if (!active || (active.status !== "queued" && active.status !== "running")) return;
    const id = window.setInterval(async () => {
      try {
        const j = await apiRequest<VideoJob>(`/video/${active.id}`);
        setActive(j);
        if (j.status === "done") { setResults(await apiRequest<VideoResults>(`/video/${j.id}/results`)); loadJobs(); }
        if (j.status === "failed") { toast("error", "Video processing failed", j.error ?? undefined); loadJobs(); }
      } catch (error) { toast("error", "Lost track of the job", errorMessage(error)); setActive(null); }
    }, 1500);
    return () => window.clearInterval(id);
  }, [active?.id, active?.status]);

  async function upload(file: File | undefined | null) {
    if (!file) return;
    setUploading(true); setResults(null);
    const form = new FormData(); form.append("file", file, file.name);
    try {
      const { job_id } = await apiRequest<{ job_id: string }>("/video", { method: "POST", body: form });
      setActive(await apiRequest<VideoJob>(`/video/${job_id}`));
      toast("ok", "Video queued", `${file.name} — matching starts now.`);
    } catch (error) { toast("error", "Couldn't upload the video", errorMessage(error)); }
    finally { setUploading(false); }
  }

  async function openJob(j: VideoJob) {
    setActive(j); setResults(null);
    if (j.status === "done") setResults(await apiRequest<VideoResults>(`/video/${j.id}/results`));
  }

  const shown = (results?.sightings ?? []).filter((s) => filter === "ALL" || s.verdict === filter);
  const p = active?.progress;
  const pct = p && p.total ? Math.round((p.current / p.total) * 100) : 0;

  return (
    <div className="page">
      {/* page-head, drop zone, processing card, roll grid, recent jobs: markup per the approved design */}
      {/* Drop zone: onDrop={(e: DragEvent) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files[0]); }} */}
      {/* Processing card: <div className="score-track"><div className="score-fill" style={{ width: pct + "%" }} /></div>
          "{p?.current ?? 0} / {p?.total ?? 0} frames · {p?.faces_seen ?? 0} faces seen" */}
      {/* Roll card (one per sighting `s`, rank i+1):
          <img src={apiUrl(`/video/${active!.id}/crop/${encodeURIComponent(s.drive_file_id)}`)} />
          <img src={apiUrl(`/image/${encodeURIComponent(s.drive_file_id)}`)} />   enrolled thumb
          {s.student?.full_name ?? s.title} · {s.student?.student_id} · {s.student?.programme}
          {s.confidence_pct.toFixed(1)}% <Verdict kind={s.verdict === "MATCH" ? "match" : s.verdict === "REVIEW" ? "review" : "no"} />
          first {mmss(s.first_ts)} · last {mmss(s.last_ts)} · seen in {s.frames_seen} frame{s.frames_seen === 1 ? "" : "s"}
          onClick={() => setOpen({ s, rank: i + 1 })} */}
      {open && active && (
        <CandidateModal
          candidate={{ drive_file_id: open.s.drive_file_id, title: open.s.title ?? "", similarity: open.s.best_similarity, student: open.s.student ?? null }}
          rank={open.rank}
          cfg={cfg}
          evidence={{ frameUrl: apiUrl(`/video/${active.id}/frame/${encodeURIComponent(open.s.drive_file_id)}`), timestamps: open.s.timestamps }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
```
The commented blocks are where the approved design's markup goes; the props, URLs and state transitions above are the contract. (`Verdict`'s `kind` values: check `verdictOf` in `ds.tsx` and map the API's `MATCH/REVIEW/NO_MATCH` accordingly.)

- [ ] **Step 4: Nav + icon + styles** — `App.tsx`: `Tab` gains `"video"`, `NAV` gains `["video", "Video match", "video"]`, route `{page === "video" && <VideoPage cfg={cfg} />}`. `ds.tsx`: add a `video` glyph to `GLYPHS` (a 24×24 stroke camera: `<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>`). `index.css`: `.roll-grid` (auto-fill, min 280 px), `.roll-card` (like `.cand`), `.ts-chip`.

- [ ] **Step 5: Verify** — `pnpm build` clean; deploy `ui` (+ `api` if touched); upload one of the DVR clips; watch progress reach 100 %; the roll lists people; clicking a card opens the modal with the boxed frame and timestamp chips; the upload file is gone from `/data/video-uploads` afterwards (`docker compose exec -T worker-video ls /data/video-uploads` → empty); `GET /audit?limit=5` shows `video_upload` and `video_results`.

- [ ] **Step 6: Stage** — `git add frontend/src/components/VideoPage.tsx frontend/src/components/CandidateModal.tsx frontend/src/components/SearchPage.tsx frontend/src/api.ts frontend/src/App.tsx frontend/src/ds.tsx frontend/src/index.css`
  ```
  feat(ui): video match page — upload, progress, attendance roll, evidence modal
  ```

---

### Task 9: Docs and final review

- [ ] **Step 1: README** — a "Video match" section: what it does, the non-negotiables (no frames stored, no writes to the index, upload deleted), accepted formats, the six settings, `make logs-worker-video`, the smoke command.
- [ ] **Step 2: Final review** — dispatch the code reviewer over the whole branch diff against the spec; fix findings.
- [ ] **Step 3: Stage** — `git add README.md`
  ```
  docs: video match section
  ```
- [ ] **Step 4:** Hand the branch to the user for merge (`feat/video-match` → `main`), no force-push, no co-author lines.

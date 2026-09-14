import logging
from contextlib import asynccontextmanager
from typing import Literal

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from psycopg import sql as pgsql

from backend.cache import (
    clear_active_sync,
    get_active_sync,
    get_drive_total,
    get_image,
    get_last_sync_finished_at,
    get_redis,
    get_runtime_config,
    get_students_sync_summary,
    set_image,
    set_runtime_config,
    unlock,
)
from backend.config import settings
from backend.db import bootstrap_schema, pool
from backend.embedding import (
    EmbeddingResult,
    InvalidImage,
    NoFaceDetected,
    embed,
    embed_many,
    get_app,
    to_display_jpeg,
)
from backend.gdrive import DriveError, download_bytes, get_metadata
from backend.queue import (
    enqueue_model_backfill,
    enqueue_retry,
    enqueue_students_sync,
    enqueue_sync,
    fetch_job,
)
from backend import analytics, audit, scoring, students
from backend.auth import actor_of, clerk_middleware
from backend.schemas import (
    AnalyticsSummary,
    AuditPage,
    Candidate,
    ConfigResponse,
    ConfigUpdate,
    ModelInfo,
    FileStatusPage,
    FaceMatchResult,
    HealthResponse,
    MatchResponse,
    MatchManyResponse,
    RetryEnqueueResponse,
    RetryRequest,
    StudentFacets,
    StudentPage,
    StudentRef,
    StudentRow,
    SyncEnqueueResponse,
    SyncJobStatus,
    Verdict,
    WorkerStatus,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

limiter = Limiter(key_func=get_remote_address, storage_uri=settings.redis_url)
scheduler = BackgroundScheduler(daemon=True)


def _scheduled_sync():
    try:
        job_id = enqueue_sync(prune=True)
        logger.info("scheduled sync enqueued: %s", job_id)
    except Exception:
        logger.exception("scheduled sync enqueue failed")


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open()
    pool.wait()
    bootstrap_schema()
    get_app()
    if settings.sync_interval_min > 0:
        scheduler.add_job(
            _scheduled_sync,
            "interval",
            minutes=settings.sync_interval_min,
            id="drive_sync",
            replace_existing=True,
        )
        scheduler.start()
        logger.info("scheduler started: sync every %d min", settings.sync_interval_min)
    logger.info("startup complete: pool=open model=%s", settings.insightface_model)
    try:
        yield
    finally:
        if scheduler.running:
            scheduler.shutdown(wait=False)
        pool.close()


app = FastAPI(title="VisageIQ API", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.middleware("http")(clerk_middleware)


def _effective_config() -> tuple[float, float, int]:
    """(match_threshold, review_threshold, top_k) — Redis dial overrides when
    set (PATCH /config), .env defaults otherwise. Redis errors fall back."""
    overrides = get_runtime_config()
    match_t = float(overrides.get("match_threshold", settings.match_threshold))
    review_t = float(overrides.get("review_threshold", settings.review_threshold))
    top_k = int(overrides.get("top_k", settings.top_k))
    if review_t >= match_t:  # defensive — PATCH validates, but Redis is writable
        review_t = max(0.01, match_t - 0.01)
    return match_t, review_t, top_k


def _verdict(similarity: float, match_t: float, review_t: float) -> Verdict:
    if similarity >= match_t:
        return "MATCH"
    if similarity >= review_t:
        return "REVIEW"
    return "NO_MATCH"


def _resolve_model(model: str | None) -> str:
    """Validate a ?model= query value against the configured packs."""
    if not model:
        return settings.insightface_model
    if model not in settings.available_models:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown model '{model}'. Available: {', '.join(settings.available_models)}",
        )
    return model


def _enrolled_count(model: str | None = None) -> int:
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            if model is None or model == settings.insightface_model:
                cur.execute("SELECT COUNT(*) FROM persons")
            else:
                cur.execute("SELECT COUNT(*) FROM alt_embeddings WHERE model = %s", (model,))
            row = cur.fetchone()
            return int(row[0]) if row else 0
    except Exception:
        logger.exception("enrolled count query failed")
        return 0


_STUDENT_JOIN = (
    "LEFT JOIN LATERAL (SELECT full_name, student_id, location "
    "                   FROM students st WHERE st.photo_drive_file_id = p.drive_file_id "
    "                   ORDER BY st.id LIMIT 1) s ON TRUE "
)

_PRIMARY_SEARCH_SQL = (
    "SELECT p.drive_file_id, p.drive_file_name, "
    "       1 - (p.face_embedding <=> %s) AS similarity, "
    "       s.full_name, s.student_id, s.location "
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
    "       s.full_name, s.student_id, s.location "
    "FROM alt_embeddings a "
    "JOIN persons p ON p.drive_file_id = a.drive_file_id "
    + _STUDENT_JOIN +
    "WHERE a.model = {} "
    "ORDER BY a.embedding <=> %s "
    "LIMIT %s"
)


def _search(
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
    for file_id, title, sim, s_name, s_sid, s_loc in rows:
        sim_f = float(sim)
        out.append(
            Candidate(
                drive_file_id=file_id,
                title=title,
                similarity=sim_f,
                confidence_pct=scoring.confidence_pct(sim_f),
                verdict=_verdict(sim_f, match_t, review_t),
                student=StudentRef(full_name=s_name, student_id=s_sid, location=s_loc) if s_name else None,
            )
        )
    return out


def _lookup_modified_time(file_id: str) -> str | None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT drive_modified_time FROM persons WHERE drive_file_id = %s",
            (file_id,),
        )
        row = cur.fetchone()
    if row and row[0] is not None:
        return row[0].isoformat()
    return None


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        db_status = "ok"
    except Exception as exc:
        logger.exception("health: db error")
        db_status = f"error: {exc}"
    try:
        get_redis().ping()
        redis_status = "ok"
    except Exception as exc:
        redis_status = f"error: {exc}"
    drive_status = "configured" if settings.gdrive_folder_id else "missing folder id"
    return HealthResponse(
        db=db_status,
        redis=redis_status,
        drive=drive_status,
        model=settings.insightface_model,
        providers=settings.providers_list,
        enrolled_count=_enrolled_count(),
        drive_total=get_drive_total(),
        last_sync_finished_at=get_last_sync_finished_at(),
        active_sync_job_id=get_active_sync(),
    )


@app.post("/match", response_model=MatchResponse)
@limiter.limit(settings.match_rate_limit)
async def match(
    request: Request,
    file: UploadFile = File(...),
    top_k: int = Query(default=settings.top_k, ge=1, le=50),
    model: str | None = Query(default=None),
) -> MatchResponse:
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty file")
    model_name = _resolve_model(model)
    match_t, review_t, _ = _effective_config()

    try:
        result = embed(image_bytes, model=model_name)
    except NoFaceDetected as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except InvalidImage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    candidates = _search(result, top_k, model_name, match_t, review_t)
    audit.record(
        actor_of(request), "face_search",
        target=candidates[0].drive_file_id if candidates else None,
        details={"faces": result.face_count, "model": model_name,
                 "top_similarity": candidates[0].similarity if candidates else None},
    )
    return MatchResponse(
        query_face_bbox=result.bbox,
        query_face_count=result.face_count,
        query_det_score=result.det_score,
        query_rotation=result.rotation,
        enrolled_count=_enrolled_count(model_name),
        model=model_name,
        candidates=candidates,
    )


@app.post("/match-many", response_model=MatchManyResponse)
@limiter.limit(settings.match_rate_limit)
async def match_many(
    request: Request,
    file: UploadFile = File(...),
    top_k: int = Query(default=settings.top_k, ge=1, le=50),
    model: str | None = Query(default=None),
) -> MatchManyResponse:
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty file")
    model_name = _resolve_model(model)
    match_t, review_t, _ = _effective_config()

    try:
        result = embed_many(image_bytes, model=model_name)
    except NoFaceDetected as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except InvalidImage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    faces = [
        FaceMatchResult(
            face_index=idx,
            bbox=face.bbox,
            det_score=face.det_score,
            candidates=_search(face, top_k, model_name, match_t, review_t),
        )
        for idx, face in enumerate(result.faces)
    ]
    # Best candidate across ALL detected faces, not just face 0.
    firsts = [f.candidates[0] for f in faces if f.candidates]
    top = max(firsts, key=lambda c: c.similarity) if firsts else None
    audit.record(
        actor_of(request), "face_search",
        target=top.drive_file_id if top else None,
        details={"faces": len(faces), "model": model_name,
                 "top_similarity": top.similarity if top else None},
    )
    return MatchManyResponse(
        query_face_count=len(result.faces),
        query_rotation=result.rotation,
        enrolled_count=_enrolled_count(model_name),
        model=model_name,
        faces=faces,
    )


def _config_response() -> ConfigResponse:
    match_t, review_t, top_k = _effective_config()
    return ConfigResponse(
        match_threshold=match_t,
        review_threshold=review_t,
        top_k=top_k,
        model=settings.insightface_model,
        models=[
            ModelInfo(
                name=name,
                primary=name == settings.insightface_model,
                enrolled_count=_enrolled_count(name),
            )
            for name in settings.available_models
        ],
    )


@app.get("/config", response_model=ConfigResponse)
def read_config() -> ConfigResponse:
    """Shared dial values + available models. UIs initialize from this."""
    return _config_response()


@app.patch("/config", response_model=ConfigResponse)
@limiter.limit("30/minute")
def update_config(request: Request, body: ConfigUpdate) -> ConfigResponse:
    """Write dial values back so every client and the API itself agree."""
    match_t, review_t, top_k = _effective_config()
    new_match = body.match_threshold if body.match_threshold is not None else match_t
    new_review = body.review_threshold if body.review_threshold is not None else review_t
    if new_review >= new_match:
        raise HTTPException(
            status_code=422,
            detail=f"review_threshold ({new_review}) must be below match_threshold ({new_match})",
        )
    updates = {
        "match_threshold": body.match_threshold,
        "review_threshold": body.review_threshold,
        "top_k": body.top_k,
    }
    provided = {k: v for k, v in updates.items() if v is not None}
    if provided:
        set_runtime_config(provided)
        audit.record(actor_of(request), "config_updated", details=provided)
    return _config_response()


@app.post("/models/backfill", response_model=SyncEnqueueResponse)
@limiter.limit(settings.sync_rate_limit)
def trigger_model_backfill(request: Request, model: str = Query(...)) -> SyncEnqueueResponse:
    """Embed every enrolled photo with a compare model (alt_embeddings only).

    The initial catch-up after adding a model to COMPARE_MODELS; regular
    syncs keep both embedding sets current afterwards.
    """
    if model not in settings.compare_models_list:
        raise HTTPException(
            status_code=422,
            detail=f"'{model}' is not in COMPARE_MODELS "
                   f"({', '.join(settings.compare_models_list) or 'none configured'})",
        )
    job_id = enqueue_model_backfill(model)
    audit.record(actor_of(request), "model_backfill_triggered", target=job_id, details={"model": model})
    return SyncEnqueueResponse(job_id=job_id)


@app.post("/sync", response_model=SyncEnqueueResponse)
@limiter.limit(settings.sync_rate_limit)
def trigger_sync(request: Request, prune: bool = Query(default=True)) -> SyncEnqueueResponse:
    job_id = enqueue_sync(prune=prune)
    audit.record(actor_of(request), "sync_triggered", target=job_id, details={"prune": prune})
    return SyncEnqueueResponse(job_id=job_id)


@app.post("/sync/force-unlock")
@limiter.limit("5/minute")
def force_unlock(request: Request) -> dict:
    """Manually clear the sync/retry locks and active-sync marker.

    Rarely needed. The sync lock now uses a short TTL with a heartbeat
    refresh, and the next sync auto-recovers a stale lock when it detects the
    recorded holder job is dead — so a crashed worker self-heals within
    ~2 minutes. This endpoint is the manual override for the impatient case
    (clear it *now*) or if auto-recovery hasn't fired yet.

    Use only when you're sure no sync is actually running.
    """
    from backend.sync import SYNC_LOCK_NAME, SYNC_RETRY_LOCK_NAME

    unlock(SYNC_LOCK_NAME)
    unlock(SYNC_RETRY_LOCK_NAME)
    clear_active_sync()
    logger.warning(
        "force-unlock requested: lock:sync, lock:retry and sync:active_job_id cleared"
    )
    audit.record(actor_of(request), "force_unlock")
    return {"cleared": True}


@app.post("/sync/retry", response_model=RetryEnqueueResponse)
@limiter.limit(settings.sync_rate_limit)
def trigger_retry(request: Request, body: RetryRequest) -> RetryEnqueueResponse:
    """Re-run the embedding pipeline for an explicit list of Drive file IDs.

    Use to recover files previously recorded as `no_face`, `invalid_image`,
    or `drive_error` in `file_status`. Skips the Drive walk; one Drive
    metadata round-trip per file. Holds its own lock (`lock:retry`).
    """
    job_id = enqueue_retry(body.file_ids)
    audit.record(actor_of(request), "retry_triggered", target=job_id, details={"count": len(body.file_ids)})
    return RetryEnqueueResponse(job_id=job_id, count=len(body.file_ids))


@app.get("/worker/status", response_model=WorkerStatus)
def worker_status() -> WorkerStatus:
    from rq.suspension import is_suspended

    return WorkerStatus(suspended=bool(is_suspended(get_redis())))


@app.post("/worker/pause", response_model=WorkerStatus)
@limiter.limit("10/minute")
def worker_pause(request: Request) -> WorkerStatus:
    """Suspend RQ workers — no new jobs are dequeued, in-flight jobs finish."""
    from rq.suspension import suspend

    suspend(get_redis())
    logger.info("worker pause requested: rq:suspended set")
    audit.record(actor_of(request), "worker_paused")
    return WorkerStatus(suspended=True)


@app.post("/worker/resume", response_model=WorkerStatus)
@limiter.limit("10/minute")
def worker_resume(request: Request) -> WorkerStatus:
    from rq.suspension import resume

    resume(get_redis())
    logger.info("worker resume requested: rq:suspended cleared")
    audit.record(actor_of(request), "worker_resumed")
    return WorkerStatus(suspended=False)


@app.get("/sync/{job_id}", response_model=SyncJobStatus)
def sync_status(job_id: str) -> SyncJobStatus:
    job = fetch_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        job.refresh()
        progress = job.meta.get("progress") if job.meta else None
    except Exception:
        progress = None
    return SyncJobStatus(
        job_id=job.id,
        status=job.get_status(refresh=True),
        progress=progress,
        result=job.result if job.is_finished else None,
        error=str(job.exc_info) if job.is_failed else None,
    )


@app.get("/analytics/summary", response_model=AnalyticsSummary)
def analytics_summary() -> AnalyticsSummary:
    return AnalyticsSummary(**analytics.summary())


@app.get("/analytics/files", response_model=FileStatusPage)
def analytics_files(
    outcome: str | None = Query(default=None),
    ext: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> FileStatusPage:
    return FileStatusPage(**analytics.files_page(outcome=outcome, ext=ext, q=q, limit=limit, offset=offset))


@app.get("/audit", response_model=AuditPage)
def audit_page(
    request: Request,
    actor: str | None = Query(default=None),
    action: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> AuditPage:
    return AuditPage(**audit.page(actor=actor, action=action, limit=limit, offset=offset))


@app.get("/students", response_model=StudentPage)
def students_page(
    request: Request,
    q: str | None = Query(default=None, max_length=200),
    # Literal keeps caller text out of audit_log.details (ids/enums only, never free text).
    field: Literal["all", "name", "sid", "email", "location"] = Query(default="all"),
    location: str | None = Query(default=None),
    has_photo: bool = Query(default=False),
    limit: int = Query(default=48, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> StudentPage:
    audit.record(actor_of(request), "student_search",
                 details={"field": field, "filtered": bool(location or has_photo or q)})
    return StudentPage(**students.page(q=q, field=field, location=location, has_photo=has_photo,
                                       limit=limit, offset=offset))


@app.get("/students/facets", response_model=StudentFacets)
def students_facets(request: Request) -> StudentFacets:
    data = students.facets()
    data["last_sync"] = get_students_sync_summary()
    return StudentFacets(**data)


@app.get("/students/{student_pk}", response_model=StudentRow)
def student_detail(request: Request, student_pk: int) -> StudentRow:
    row = students.get(student_pk)
    if row is None:
        raise HTTPException(status_code=404, detail="Student not found")
    audit.record(actor_of(request), "student_view", target=row["natural_key"])
    return StudentRow(**row)


@app.post("/students/sync", response_model=SyncEnqueueResponse)
@limiter.limit(settings.sync_rate_limit)
def trigger_students_sync(request: Request) -> SyncEnqueueResponse:
    job_id = enqueue_students_sync()
    audit.record(actor_of(request), "students_sync_triggered", target=job_id)
    return SyncEnqueueResponse(job_id=job_id)


@app.get("/image/{file_id}")
def get_image_bytes(request: Request, file_id: str) -> Response:
    audit.record(actor_of(request), "image_view", target=file_id)
    modified_time = _lookup_modified_time(file_id)
    cached = get_image(file_id, modified_time)
    if cached:
        return Response(content=cached, media_type="image/jpeg")
    try:
        if modified_time is None:
            meta = get_metadata(file_id)
            modified_time = meta.modified_time.isoformat() if meta.modified_time else None
            mime = meta.mime_type
        else:
            mime = "image/jpeg"
        data = download_bytes(file_id)
    except DriveError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    try:
        # Browsers can't render HEIC/HEIF/TIFF originals; serve a normalized JPEG.
        jpeg = to_display_jpeg(data)
    except Exception:
        # Undecodable original (e.g. DNG). Serve it with its REAL mime — the
        # v2 cache namespace is JPEG-only, so originals are never cached.
        logger.warning("thumbnail transcode failed for %s; serving original bytes", file_id)
        if mime == "image/jpeg":  # placeholder from the known-mtime branch, not the truth
            try:
                mime = get_metadata(file_id).mime_type or "application/octet-stream"
            except DriveError:
                mime = "application/octet-stream"
        return Response(content=data, media_type=mime)
    try:
        set_image(file_id, modified_time, jpeg)
    except Exception:
        # Cache write is best-effort; a Redis blip must not fail the response.
        logger.warning("image cache write failed for %s", file_id, exc_info=True)
    return Response(content=jpeg, media_type="image/jpeg")

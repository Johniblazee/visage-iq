import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

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
    enqueue_video,
    fetch_job,
    fetch_video_job,
)
from backend import analytics, audit, gallery, scoring, students, video_store
from backend.auth import actor_of, clerk_middleware
from backend.schemas import (
    AnalyticsSummary,
    AuditPage,
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
    StudentRow,
    SyncEnqueueResponse,
    SyncJobStatus,
    VideoEnqueueResponse,
    VideoJob,
    VideoResults,
    VideoSighting,
    WorkerStatus,
)
from backend.video import VideoError, probe

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

    candidates = gallery.search(result, top_k, model_name, match_t, review_t)
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
            candidates=gallery.search(face, top_k, model_name, match_t, review_t),
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
    field: Literal["all", "name", "sid", "email", "location", "programme", "cohort"] = Query(default="all"),
    location: str | None = Query(default=None),
    programme: str | None = Query(default=None),
    cohort: str | None = Query(default=None),
    level: str | None = Query(default=None),
    has_photo: bool = Query(default=False),
    limit: int = Query(default=48, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> StudentPage:
    audit.record(actor_of(request), "student_search",
                 details={"field": field,
                          "filtered": bool(location or programme or cohort or level or has_photo or q)})
    return StudentPage(**students.page(q=q, field=field, location=location, programme=programme,
                                       cohort=cohort, level=level, has_photo=has_photo,
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


def _rm(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _video_job(job_id: str) -> VideoJob:
    row = video_store.get_job(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Video job not found")
    progress = None
    if row["status"] in ("queued", "running"):
        job = fetch_video_job(job_id)
        if job is None or job.is_failed:
            # The worker died before recording a terminal state — reconcile on read.
            logger.warning("video %s: RQ job %s while row was %s — marking failed",
                           job_id, "missing" if job is None else "failed", row["status"])
            if row.get("upload_path"):
                _rm(row["upload_path"])
            video_store.set_status(job_id, "failed",
                                   error="The video worker stopped before finishing — please upload again.")
            row = video_store.get_job(job_id) or row
        else:
            progress = (job.meta or {}).get("progress")
    row.pop("upload_path", None)  # never leak a server path
    return VideoJob(**row, progress=progress)


@app.post("/video", response_model=VideoEnqueueResponse)
@limiter.limit(settings.video_rate_limit)
async def video_upload(request: Request, file: UploadFile = File(...)) -> VideoEnqueueResponse:
    limit = settings.video_max_upload_mb * 1024 * 1024
    too_big = HTTPException(status_code=413, detail=f"Video is too large — the limit is {settings.video_max_upload_mb} MB.")
    if int(request.headers.get("content-length") or 0) > limit + 1024 * 1024:
        raise too_big
    job_id = str(uuid.uuid4())
    ext = os.path.splitext(file.filename or "")[1].lower()[:8]
    if not ext[1:].isalnum():  # client-controlled; keep it a plain suffix
        ext = ".bin"
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
        match_t, review_t, _ = _effective_config()
        actor = actor_of(request)
        video_store.create_job(job_id, actor, file.filename or "video", size, path, info, match_t, review_t)
        enqueue_video(job_id)
    except VideoError as exc:
        _rm(path)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        _rm(path)
        raise
    except Exception:
        _rm(path)
        try:  # no-op UPDATE if we failed before create_job
            video_store.set_status(job_id, "failed", error="Couldn't queue the video for processing — please try again.")
        except Exception:
            logger.exception("video %s: could not mark job failed", job_id)
        raise
    audit.record(actor, "video_upload", target=job_id,
                 details={"size_bytes": size, "duration_s": round(info.duration_s, 1)})
    return VideoEnqueueResponse(job_id=job_id)


@app.get("/video", response_model=list[VideoJob])
def video_jobs(request: Request) -> list[VideoJob]:
    out = []
    for row in video_store.list_jobs():
        row.pop("upload_path", None)
        out.append(VideoJob(**row))
    return out


@app.get("/video/{job_id}", response_model=VideoJob)
def video_job(request: Request, job_id: uuid.UUID) -> VideoJob:
    return _video_job(str(job_id))


@app.get("/video/{job_id}/results", response_model=VideoResults)
def video_results(request: Request, job_id: uuid.UUID) -> VideoResults:
    job = _video_job(str(job_id))
    match_t = job.match_threshold or settings.match_threshold
    review_t = job.review_threshold or settings.review_threshold
    sightings = [
        VideoSighting(**r, confidence_pct=scoring.confidence_pct(r["best_similarity"]),
                      verdict=gallery.verdict(r["best_similarity"], match_t, review_t))
        for r in video_store.results(str(job_id))
    ]
    audit.record(actor_of(request), "video_results", target=str(job_id), details={"students": len(sightings)})
    return VideoResults(job=job, sightings=sightings)


@app.get("/video/{job_id}/{kind}/{drive_file_id}")
def video_evidence(request: Request, job_id: uuid.UUID, kind: Literal["frame", "crop"], drive_file_id: str) -> Response:
    data = video_store.evidence(str(job_id), drive_file_id, kind)
    if data is None:
        raise HTTPException(status_code=404, detail="No evidence for this student in this job")
    audit.record(actor_of(request), "image_view", target=drive_file_id, details={"video_job": str(job_id), "kind": kind})
    return Response(content=data, media_type="image/jpeg")


@app.delete("/video/{job_id}")
def video_delete(request: Request, job_id: uuid.UUID) -> dict:
    row = video_store.get_job(str(job_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Video job not found")
    if row["upload_path"]:  # queued job: the worker would never reach its own cleanup
        _rm(row["upload_path"])
    job = fetch_video_job(str(job_id))
    if job is not None and row["status"] == "queued":
        try:
            job.cancel()
        except Exception:
            logger.debug("video %s: cancel skipped", job_id, exc_info=True)
    video_store.delete_job(str(job_id))
    audit.record(actor_of(request), "video_delete", target=str(job_id))
    return {"deleted": str(job_id)}


@app.get("/image/{file_id}")
def get_image_bytes(request: Request, file_id: str, full: bool = Query(default=False)) -> Response:
    audit.record(actor_of(request), "image_view", target=file_id)
    modified_time = _lookup_modified_time(file_id)
    # ponytail: the size variant lives in the cache id; both stay JPEG-only under v2.
    cache_id = f"{file_id}:full" if full else file_id
    cached = get_image(cache_id, modified_time)
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
        jpeg = to_display_jpeg(data, max_side=1600 if full else 512)
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
        set_image(cache_id, modified_time, jpeg)
    except Exception:
        # Cache write is best-effort; a Redis blip must not fail the response.
        logger.warning("image cache write failed for %s", file_id, exc_info=True)
    return Response(content=jpeg, media_type="image/jpeg")

import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from backend.cache import (
    get_active_sync,
    get_drive_total,
    get_image,
    get_last_sync_finished_at,
    get_redis,
    set_image,
)
from backend.config import settings
from backend.db import bootstrap_schema, pool
from backend.embedding import (
    EmbeddingResult,
    InvalidImage,
    NoFaceDetected,
    embed,
    get_app,
)
from backend.gdrive import DriveError, download_bytes, get_metadata
from backend.queue import enqueue_sync, fetch_job
from backend import analytics
from backend.schemas import (
    AnalyticsSummary,
    Candidate,
    FileStatusPage,
    HealthResponse,
    MatchResponse,
    SyncEnqueueResponse,
    SyncJobStatus,
    Verdict,
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


app = FastAPI(title="Face Match API", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


def _verdict(similarity: float) -> Verdict:
    if similarity >= settings.match_threshold:
        return "MATCH"
    if similarity >= settings.review_threshold:
        return "REVIEW"
    return "NO_MATCH"


def _enrolled_count() -> int:
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM persons")
            row = cur.fetchone()
            return int(row[0]) if row else 0
    except Exception:
        logger.exception("enrolled count query failed")
        return 0


def _search(result: EmbeddingResult, top_k: int) -> list[Candidate]:
    sql = (
        "SELECT drive_file_id, drive_file_name, "
        "       1 - (face_embedding <=> %s) AS similarity "
        "FROM persons "
        "ORDER BY face_embedding <=> %s "
        "LIMIT %s"
    )
    emb = result.embedding
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (emb, emb, top_k))
        rows = cur.fetchall()
    out: list[Candidate] = []
    for file_id, title, sim in rows:
        sim_f = float(sim)
        out.append(
            Candidate(
                drive_file_id=file_id,
                title=title,
                similarity=sim_f,
                confidence_pct=round(max(0.0, min(1.0, sim_f)) * 100.0, 1),
                verdict=_verdict(sim_f),
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
) -> MatchResponse:
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        result = embed(image_bytes)
    except NoFaceDetected as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except InvalidImage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    candidates = _search(result, top_k)
    return MatchResponse(
        query_face_bbox=result.bbox,
        query_face_count=result.face_count,
        query_det_score=result.det_score,
        query_rotation=result.rotation,
        enrolled_count=_enrolled_count(),
        candidates=candidates,
    )


@app.post("/sync", response_model=SyncEnqueueResponse)
@limiter.limit(settings.sync_rate_limit)
def trigger_sync(request: Request, prune: bool = Query(default=True)) -> SyncEnqueueResponse:
    job_id = enqueue_sync(prune=prune)
    return SyncEnqueueResponse(job_id=job_id)


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


@app.get("/image/{file_id}")
def get_image_bytes(file_id: str) -> Response:
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
    set_image(file_id, modified_time, data)
    return Response(content=data, media_type=mime)

import logging
from collections import deque
from collections.abc import Iterator
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

from backend.cache import (
    clear_active_sync,
    lock,
    set_drive_total,
    set_last_sync_finished_at,
    unlock,
)
from backend.config import settings
from backend.db import bootstrap_schema, pool
from backend.embedding import (
    EmbeddingResult,
    InvalidImage,
    NoFaceDetected,
    _embed_worker_init,
    embed,
    embed_for_pool,
)
from backend.gdrive import DriveError, download_bytes, get_metadata, list_image_files

logger = logging.getLogger(__name__)

UPSERT_SQL = """
INSERT INTO persons (
    drive_file_id, drive_file_name, drive_modified_time,
    face_embedding, det_score, face_count, updated_at
)
VALUES (%s, %s, %s, %s, %s, %s, NOW())
ON CONFLICT (drive_file_id) DO UPDATE SET
    drive_file_name = EXCLUDED.drive_file_name,
    drive_modified_time = EXCLUDED.drive_modified_time,
    face_embedding = EXCLUDED.face_embedding,
    det_score = EXCLUDED.det_score,
    face_count = EXCLUDED.face_count,
    updated_at = NOW()
"""

DELETE_SQL = "DELETE FROM persons WHERE drive_file_id = ANY(%s)"
DELETE_STATUS_SQL = "DELETE FROM file_status WHERE drive_file_id = ANY(%s)"

UPSERT_STATUS_SQL = """
INSERT INTO file_status (
    drive_file_id, drive_file_name, mime_type, ext,
    outcome, reason, rotation, det_score, last_seen_at
)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
ON CONFLICT (drive_file_id) DO UPDATE SET
    drive_file_name = EXCLUDED.drive_file_name,
    mime_type       = EXCLUDED.mime_type,
    ext             = EXCLUDED.ext,
    outcome         = EXCLUDED.outcome,
    reason          = EXCLUDED.reason,
    rotation        = EXCLUDED.rotation,
    det_score       = EXCLUDED.det_score,
    last_seen_at    = NOW()
"""

EXISTING_SQL = "SELECT drive_file_id, drive_modified_time FROM persons"


def _ext_of(name: str) -> str | None:
    if "." not in name:
        return None
    return name.rsplit(".", 1)[-1].lower() or None


def _record_status(
    cur,
    drive_file,
    outcome: str,
    reason: str | None = None,
    rotation: int | None = None,
    det_score: float | None = None,
) -> None:
    cur.execute(
        UPSERT_STATUS_SQL,
        (
            drive_file.id,
            drive_file.name,
            drive_file.mime_type,
            _ext_of(drive_file.name),
            outcome,
            reason,
            rotation,
            det_score,
        ),
    )

SYNC_LOCK_NAME = "sync"
SYNC_RETRY_LOCK_NAME = "retry"


@dataclass
class SyncStats:
    listed: int = 0
    new: int = 0
    updated: int = 0
    skipped_no_face: int = 0
    skipped_invalid: int = 0
    skipped_drive_error: int = 0
    skipped_unchanged: int = 0
    deleted: int = 0
    duration_seconds: float = 0.0


def _existing() -> dict[str, datetime | None]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(EXISTING_SQL)
        return {row[0]: row[1] for row in cur.fetchall()}


def _job_label() -> str:
    try:
        from rq import get_current_job

        job = get_current_job()
        if job is not None:
            return job.id[:8]
    except Exception:
        pass
    return "foreground"


def _current_job():
    try:
        from rq import get_current_job

        return get_current_job()
    except Exception:
        return None


PROGRESS_WRITE_EVERY = 5      # write to job.meta every N files (processing)
LISTING_WRITE_EVERY = 500     # write to job.meta every N files (listing)


@dataclass
class _WorkItem:
    """A per-file unit of work yielded by `_iter_with_prefetch`.

    Exactly one of `image_bytes` / `download_error` is set, unless `unchanged`
    is True (in which case both are None — no download was issued).
    """
    drive_file: object
    is_new: bool
    is_changed: bool
    idx: int
    image_bytes: bytes | None = None
    download_error: DriveError | None = None
    unchanged: bool = False


def _classify(drive_file, existing: dict) -> tuple[bool, bool]:
    is_new = drive_file.id not in existing
    prior_mtime = existing.get(drive_file.id)
    is_changed = (
        not is_new
        and drive_file.modified_time is not None
        and prior_mtime is not None
        and drive_file.modified_time > prior_mtime
    )
    return is_new, is_changed


def _iter_with_prefetch(
    drive_files: list,
    existing: dict,
    seen: set[str],
) -> Iterator[_WorkItem]:
    """Yield `_WorkItem`s in submission order, with downloads prefetched.

    A `ThreadPoolExecutor` of size `settings.download_workers` pulls upcoming
    Drive files in parallel with the consumer's embedding work — so the GPU
    (or CPU embed pool) never sits idle waiting for the next download.

    Unchanged files (already in `persons` with the same `modified_time`) skip
    the download entirely — they're yielded with `unchanged=True`.

    `settings.download_workers <= 1` returns a synchronous fallback.
    """
    workers = max(1, settings.download_workers)
    max_inflight = max(1, settings.download_max_inflight)

    if workers == 1:
        for idx, drive_file in enumerate(drive_files, start=1):
            seen.add(drive_file.id)
            is_new, is_changed = _classify(drive_file, existing)
            if not is_new and not is_changed:
                yield _WorkItem(drive_file, is_new, is_changed, idx, unchanged=True)
                continue
            try:
                image_bytes = download_bytes(drive_file.id)
                yield _WorkItem(drive_file, is_new, is_changed, idx, image_bytes=image_bytes)
            except DriveError as exc:
                yield _WorkItem(drive_file, is_new, is_changed, idx, download_error=exc)
        return

    inflight: deque[tuple[object, bool, bool, int, Future | None]] = deque()
    files_iter = iter(enumerate(drive_files, start=1))

    def _enqueue_next(ex: ThreadPoolExecutor) -> bool:
        try:
            idx, drive_file = next(files_iter)
        except StopIteration:
            return False
        seen.add(drive_file.id)
        is_new, is_changed = _classify(drive_file, existing)
        if not is_new and not is_changed:
            inflight.append((drive_file, is_new, is_changed, idx, None))
        else:
            fut = ex.submit(download_bytes, drive_file.id)
            inflight.append((drive_file, is_new, is_changed, idx, fut))
        return True

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="dl") as ex:
        while len(inflight) < max_inflight and _enqueue_next(ex):
            pass
        while inflight:
            drive_file, is_new, is_changed, idx, fut = inflight.popleft()
            if fut is None:
                yield _WorkItem(drive_file, is_new, is_changed, idx, unchanged=True)
            else:
                try:
                    image_bytes = fut.result()
                    yield _WorkItem(
                        drive_file, is_new, is_changed, idx, image_bytes=image_bytes,
                    )
                except DriveError as exc:
                    yield _WorkItem(
                        drive_file, is_new, is_changed, idx, download_error=exc,
                    )
            _enqueue_next(ex)


def _finalize_embed_outcome(
    cur,
    drive_file,
    *,
    is_new: bool,
    result_or_exc,
    stats: SyncStats,
    log_pos: str,
) -> None:
    """Apply DB writes + stats updates given the outcome of an embed call.

    Shared by the inline path and the ProcessPoolExecutor drain path. Pass
    either an `EmbeddingResult` (success) or an `Exception` (any of the
    handled failure modes) caught from `embed(...)` / `Future.result()`.
    """
    if isinstance(result_or_exc, EmbeddingResult):
        result = result_or_exc
        cur.execute(
            UPSERT_SQL,
            (
                drive_file.id,
                drive_file.name,
                drive_file.modified_time,
                result.embedding,
                result.det_score,
                result.face_count,
            ),
        )
        if is_new:
            stats.new += 1
            verb = "new"
        else:
            stats.updated += 1
            verb = "updated"
        _record_status(
            cur, drive_file, "enrolled",
            rotation=result.rotation, det_score=result.det_score,
        )
        logger.info(
            "%s %s: %s (det_score=%.3f, rotation=%d°)",
            log_pos, verb, drive_file.name, result.det_score, result.rotation,
        )
        return

    exc = result_or_exc
    if isinstance(exc, NoFaceDetected):
        logger.info("%s no face: %s (skipped)", log_pos, drive_file.name)
        stats.skipped_no_face += 1
        _record_status(cur, drive_file, "no_face")
    elif isinstance(exc, InvalidImage):
        logger.warning("%s invalid image: %s — %s", log_pos, drive_file.name, exc)
        stats.skipped_invalid += 1
        _record_status(cur, drive_file, "invalid_image", reason=str(exc)[:500])
    else:
        logger.exception(
            "%s unexpected embed error: %s — %s", log_pos, drive_file.name, exc,
        )
        stats.skipped_invalid += 1
        _record_status(cur, drive_file, "embed_error", reason=str(exc)[:500])


def _process_file_inline(
    cur,
    drive_file,
    *,
    is_new: bool,
    is_changed: bool,
    stats: SyncStats,
    log_pos: str,
) -> None:
    """Single-file pipeline (synchronous, no prefetch).

    Used by `run_retry()` — small file lists where the prefetch overhead
    isn't worth it. The main `run_sync()` path goes through
    `_iter_with_prefetch()` instead so downloads overlap with embedding.

    Mutates `stats` and writes one row to file_status (and to persons on
    the enrolled path). Caller owns commit() cadence and progress writes.
    """
    if not is_new and not is_changed:
        logger.info("%s skip: unchanged %s", log_pos, drive_file.name)
        stats.skipped_unchanged += 1
        _record_status(cur, drive_file, "unchanged")
        return

    try:
        image_bytes = download_bytes(drive_file.id)
    except DriveError as exc:
        logger.warning(
            "%s drive error: %s (%s) — %s",
            log_pos, drive_file.name, drive_file.id, exc,
        )
        stats.skipped_drive_error += 1
        _record_status(cur, drive_file, "drive_error", reason=str(exc)[:500])
        return

    try:
        result = embed(image_bytes)
    except (NoFaceDetected, InvalidImage, Exception) as exc:
        _finalize_embed_outcome(
            cur, drive_file,
            is_new=is_new, result_or_exc=exc, stats=stats, log_pos=log_pos,
        )
        return

    _finalize_embed_outcome(
        cur, drive_file,
        is_new=is_new, result_or_exc=result, stats=stats, log_pos=log_pos,
    )


def _apply_workitem_inline(
    cur,
    item: _WorkItem,
    *,
    stats: SyncStats,
    log_pos: str,
) -> None:
    """Run the embed-and-finalize step for a prefetched WorkItem (no embed pool).

    Inputs:
      * unchanged → record + return
      * download_error → record drive_error + return
      * image_bytes ready → embed inline, finalize via shared helper.
    """
    if item.unchanged:
        logger.info("%s skip: unchanged %s", log_pos, item.drive_file.name)
        stats.skipped_unchanged += 1
        _record_status(cur, item.drive_file, "unchanged")
        return
    if item.download_error is not None:
        logger.warning(
            "%s drive error: %s (%s) — %s",
            log_pos, item.drive_file.name, item.drive_file.id, item.download_error,
        )
        stats.skipped_drive_error += 1
        _record_status(
            cur, item.drive_file, "drive_error",
            reason=str(item.download_error)[:500],
        )
        return
    try:
        result = embed(item.image_bytes)  # type: ignore[arg-type]
        result_or_exc = result
    except (NoFaceDetected, InvalidImage, Exception) as exc:
        result_or_exc = exc
    _finalize_embed_outcome(
        cur, item.drive_file,
        is_new=item.is_new, result_or_exc=result_or_exc,
        stats=stats, log_pos=log_pos,
    )


def _write_progress(job, stats: "SyncStats", idx: int, total: int) -> None:
    if job is None:
        return
    job.meta["progress"] = {
        "phase": "embedding",
        "current": idx,
        "total": total,
        "new": stats.new,
        "updated": stats.updated,
        "unchanged": stats.skipped_unchanged,
        "skipped_no_face": stats.skipped_no_face,
        "skipped_invalid": stats.skipped_invalid,
        "skipped_drive_error": stats.skipped_drive_error,
    }
    try:
        job.save_meta()
    except Exception:
        # best-effort; never fail a sync because Redis hiccupped
        logger.debug("failed to save job meta", exc_info=True)


def _write_listing_progress(job, listed: int) -> None:
    """Lightweight progress write while we're still walking Drive.

    `total` is unknown until listing finishes, so we report only `listed`.
    The UI uses `phase == "listing"` to render an indeterminate state with
    a "files found so far" counter.
    """
    if job is None:
        return
    job.meta["progress"] = {
        "phase": "listing",
        "current": 0,
        "total": 0,
        "listed": listed,
        "new": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped_no_face": 0,
        "skipped_invalid": 0,
        "skipped_drive_error": 0,
    }
    try:
        job.save_meta()
    except Exception:
        logger.debug("failed to save job meta", exc_info=True)


def _maybe_commit_and_progress(
    conn, stats: SyncStats, idx: int, total: int, prefix: str, job,
) -> None:
    if (stats.new + stats.updated) % settings.sync_batch_commit == 0 \
            and (stats.new + stats.updated) > 0:
        conn.commit()
        logger.info(
            "%s checkpoint: committed %d row(s) so far",
            prefix, stats.new + stats.updated,
        )
    if idx % PROGRESS_WRITE_EVERY == 0 or idx == total:
        _write_progress(job, stats, idx, total)


def _run_inline_loop(
    cur,
    conn,
    drive_files: list,
    existing: dict,
    stats: SyncStats,
    prefix: str,
    total: int,
    job,
    seen: set[str],
) -> None:
    """Single-process embed loop with download prefetch.

    Embeds inline on the main process — used when `EMBED_WORKERS=1`
    (default, and required on GPU). Drive downloads are still prefetched
    in parallel via `_iter_with_prefetch` so the embedder doesn't sit idle
    waiting for I/O. This is the path that gives GPU users the throughput
    win without oversubscribing the device.
    """
    for item in _iter_with_prefetch(drive_files, existing, seen):
        log_pos = f"{prefix} [{item.idx}/{total}]"
        _apply_workitem_inline(cur, item, stats=stats, log_pos=log_pos)
        _maybe_commit_and_progress(conn, stats, item.idx, total, prefix, job)


def _run_pooled_loop(
    cur,
    conn,
    drive_files: list,
    existing: dict,
    stats: SyncStats,
    prefix: str,
    total: int,
    job,
    seen: set[str],
) -> None:
    """ProcessPoolExecutor variant — N embed processes + download prefetch.

    Used when `EMBED_WORKERS > 1` (CPU only). Each subprocess warms its own
    InsightFace instance once via `_embed_worker_init`, then `embed_for_pool`
    is `submit()`ed per file. Drains in submission order so per-file logs
    and DB writes preserve a stable sequence.

    Three inflight knobs cooperate:
      * `download_workers`     — threads pulling Drive bytes
      * `download_max_inflight`— bound on prefetched downloads
      * `embed_worker_max_inflight` — bound on embed-pool submits
    """
    inflight: deque[tuple[object, bool, Future, int]] = deque()  # (drive_file, is_new, future, idx)

    def _drain_one_embed() -> None:
        drive_file, is_new, future, idx = inflight.popleft()
        log_pos = f"{prefix} [{idx}/{total}]"
        try:
            result_or_exc = future.result()
        except (NoFaceDetected, InvalidImage, Exception) as exc:  # noqa: BLE001
            result_or_exc = exc
        _finalize_embed_outcome(
            cur, drive_file,
            is_new=is_new, result_or_exc=result_or_exc,
            stats=stats, log_pos=log_pos,
        )
        _maybe_commit_and_progress(conn, stats, idx, total, prefix, job)

    with ProcessPoolExecutor(
        max_workers=settings.embed_workers,
        initializer=_embed_worker_init,
    ) as ex:
        for item in _iter_with_prefetch(drive_files, existing, seen):
            log_pos = f"{prefix} [{item.idx}/{total}]"

            if item.unchanged:
                logger.info("%s skip: unchanged %s", log_pos, item.drive_file.name)
                stats.skipped_unchanged += 1
                _record_status(cur, item.drive_file, "unchanged")
                _maybe_commit_and_progress(conn, stats, item.idx, total, prefix, job)
                continue

            if item.download_error is not None:
                logger.warning(
                    "%s drive error: %s (%s) — %s",
                    log_pos, item.drive_file.name, item.drive_file.id, item.download_error,
                )
                stats.skipped_drive_error += 1
                _record_status(
                    cur, item.drive_file, "drive_error",
                    reason=str(item.download_error)[:500],
                )
                _maybe_commit_and_progress(conn, stats, item.idx, total, prefix, job)
                continue

            inflight.append((
                item.drive_file, item.is_new,
                ex.submit(embed_for_pool, item.image_bytes), item.idx,
            ))
            while len(inflight) >= settings.embed_worker_max_inflight:
                _drain_one_embed()

        while inflight:
            _drain_one_embed()


def run_sync(prune: bool = True) -> SyncStats:
    stats = SyncStats()
    started = datetime.now(timezone.utc)
    prefix = f"[sync {_job_label()}]"
    job = _current_job()

    if not lock(SYNC_LOCK_NAME, ttl=3600):
        logger.warning("%s already in progress; skipping", prefix)
        # The enqueue path stamped sync:active_job_id; this run isn't doing
        # anything, so clear it so the UI's Active Sync widget hides instead
        # of staying lit on a finished-but-did-nothing job.
        clear_active_sync()
        if job is not None:
            job.meta["progress"] = {
                "phase": "skipped",
                "reason": "another sync is already running",
            }
            try:
                job.save_meta()
            except Exception:
                logger.debug("failed to save skip meta", exc_info=True)
        return stats

    try:
        logger.info(
            "%s starting (folder=%s, prune=%s)",
            prefix, settings.gdrive_folder_id, prune,
        )

        existing = _existing()
        logger.info("%s walking Drive folder...", prefix)
        _write_listing_progress(job, 0)

        drive_files: list = []
        for df in list_image_files():
            drive_files.append(df)
            if len(drive_files) % LISTING_WRITE_EVERY == 0:
                _write_listing_progress(job, len(drive_files))
                logger.info("%s listing... %d files found so far", prefix, len(drive_files))

        total = len(drive_files)
        stats.listed = total
        set_drive_total(total)
        logger.info("%s listed %d image file(s)", prefix, total)
        _write_progress(job, stats, 0, total)

        seen: set[str] = set()
        with pool.connection() as conn, conn.cursor() as cur:
            logger.info(
                "%s loop config: embed_workers=%d max_inflight=%d "
                "download_workers=%d download_max_inflight=%d",
                prefix, settings.embed_workers, settings.embed_worker_max_inflight,
                settings.download_workers, settings.download_max_inflight,
            )
            if settings.embed_workers > 1:
                _run_pooled_loop(
                    cur, conn, drive_files, existing, stats, prefix, total, job, seen,
                )
            else:
                _run_inline_loop(
                    cur, conn, drive_files, existing, stats, prefix, total, job, seen,
                )
            conn.commit()

            if prune:
                logger.info("%s pruning rows for files removed from Drive...", prefix)
                stale_persons = [fid for fid in existing if fid not in seen]
                cur.execute("SELECT drive_file_id FROM file_status")
                fs_ids = {row[0] for row in cur.fetchall()}
                stale_status = [fid for fid in fs_ids if fid not in seen]
                if stale_persons:
                    cur.execute(DELETE_SQL, (stale_persons,))
                if stale_status:
                    cur.execute(DELETE_STATUS_SQL, (stale_status,))
                stats.deleted = len(stale_persons)
                conn.commit()
                logger.info(
                    "%s pruned %d enrolled row(s) and %d status row(s)",
                    prefix, stats.deleted, len(stale_status),
                )
    finally:
        unlock(SYNC_LOCK_NAME)
        clear_active_sync()
        set_last_sync_finished_at(datetime.now(timezone.utc).isoformat())

    stats.duration_seconds = (datetime.now(timezone.utc) - started).total_seconds()
    logger.info(
        "%s done in %.1fs — new=%d updated=%d unchanged=%d deleted=%d "
        "skipped_no_face=%d skipped_invalid=%d skipped_drive_error=%d",
        prefix,
        stats.duration_seconds,
        stats.new,
        stats.updated,
        stats.skipped_unchanged,
        stats.deleted,
        stats.skipped_no_face,
        stats.skipped_invalid,
        stats.skipped_drive_error,
    )
    return stats


_schema_bootstrapped = False


def _ensure_pool_open() -> None:
    global _schema_bootstrapped
    if pool.closed:
        pool.open()
        pool.wait()
    if not _schema_bootstrapped:
        # Idempotent re-run of init_db.sql so workers spun up against an
        # older volume still get the latest tables/indexes (CREATE TABLE
        # IF NOT EXISTS handles the no-op case).
        try:
            bootstrap_schema()
        except Exception:
            logger.exception("schema bootstrap failed in worker; continuing")
        _schema_bootstrapped = True


def run_sync_job(prune: bool = True) -> dict:
    _ensure_pool_open()
    stats = run_sync(prune=prune)
    return stats.__dict__


def run_retry(file_ids: list[str]) -> SyncStats:
    """Re-run the embedding pipeline for an explicit list of Drive file IDs.

    Skips the Drive walk; looks up each file via Drive's files.get(). Treats
    every file as `is_changed=True` so the unchanged short-circuit doesn't
    fire on retry. No prune. Holds its own lock (lock:retry) so a regular
    sync and a retry don't race the same Postgres txn.
    """
    stats = SyncStats()
    started = datetime.now(timezone.utc)
    prefix = f"[retry {_job_label()}]"
    job = _current_job()

    if not lock(SYNC_RETRY_LOCK_NAME, ttl=3600):
        logger.warning("%s already in progress; skipping", prefix)
        clear_active_sync()
        if job is not None:
            job.meta["progress"] = {
                "phase": "skipped",
                "reason": "another retry is already running",
            }
            try:
                job.save_meta()
            except Exception:
                logger.debug("failed to save skip meta", exc_info=True)
        return stats

    try:
        total = len(file_ids)
        stats.listed = total
        logger.info("%s starting (count=%d)", prefix, total)
        _write_progress(job, stats, 0, total)

        existing = _existing()

        with pool.connection() as conn, conn.cursor() as cur:
            for idx, file_id in enumerate(file_ids, start=1):
                pos = f"{prefix} [{idx}/{total}]"
                try:
                    drive_file = get_metadata(file_id)
                except DriveError as exc:
                    # Synthesize a minimal stand-in so we still log a row in
                    # file_status — same row format as the main sync's
                    # drive_error path.
                    @dataclass
                    class _Stub:
                        id: str
                        name: str
                        mime_type: str
                        modified_time: datetime | None = None
                    stub = _Stub(id=file_id, name=file_id, mime_type="")
                    logger.warning("%s drive metadata error: %s — %s", pos, file_id, exc)
                    stats.skipped_drive_error += 1
                    _record_status(cur, stub, "drive_error", reason=str(exc)[:500])
                    if idx % PROGRESS_WRITE_EVERY == 0 or idx == total:
                        _write_progress(job, stats, idx, total)
                    continue

                is_new = drive_file.id not in existing
                # Force the embed path regardless of whether the file already
                # exists in persons; the user explicitly asked to retry.
                _process_file_inline(
                    cur, drive_file,
                    is_new=is_new, is_changed=True,
                    stats=stats, log_pos=pos,
                )

                if (stats.new + stats.updated) % settings.sync_batch_commit == 0 \
                        and (stats.new + stats.updated) > 0:
                    conn.commit()
                    logger.info(
                        "%s checkpoint: committed %d row(s) so far",
                        prefix, stats.new + stats.updated,
                    )

                if idx % PROGRESS_WRITE_EVERY == 0 or idx == total:
                    _write_progress(job, stats, idx, total)
            conn.commit()
    finally:
        unlock(SYNC_RETRY_LOCK_NAME)
        clear_active_sync()
        set_last_sync_finished_at(datetime.now(timezone.utc).isoformat())

    stats.duration_seconds = (datetime.now(timezone.utc) - started).total_seconds()
    logger.info(
        "%s done in %.1fs — new=%d updated=%d "
        "skipped_no_face=%d skipped_invalid=%d skipped_drive_error=%d",
        prefix,
        stats.duration_seconds,
        stats.new,
        stats.updated,
        stats.skipped_no_face,
        stats.skipped_invalid,
        stats.skipped_drive_error,
    )
    return stats


def run_retry_job(file_ids: list[str]) -> dict:
    _ensure_pool_open()
    stats = run_retry(file_ids)
    return stats.__dict__

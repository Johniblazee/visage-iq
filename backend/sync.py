import logging
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from time import perf_counter

from backend.cache import (
    clear_active_sync,
    get_active_sync,
    lock_with_heartbeat,
    set_drive_total,
    set_last_sync_finished_at,
    unlock,
)
from backend.config import settings
from backend.db import bootstrap_schema, pool
from backend.embedding import InvalidImage, NoFaceDetected, embed
from backend.gdrive import DriveError, DriveFile, download_bytes, get_metadata, list_image_files
from backend.queue import is_job_alive

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
WHERE file_status.outcome <> 'enrolled' OR EXCLUDED.outcome = 'enrolled'
"""

# Unchanged files: bump recency only. Keeps the original outcome
# (enrolled / no_face / …) sticky — an enrolled file's recorded reason must
# not flip to "unchanged" on later syncs.
TOUCH_STATUS_SQL = "UPDATE file_status SET last_seen_at = NOW() WHERE drive_file_id = %s"

DELETE_MISSING_SQL = "DELETE FROM persons WHERE NOT (drive_file_id = ANY(%s))"
DELETE_MISSING_STATUS_SQL = "DELETE FROM file_status WHERE NOT (drive_file_id = ANY(%s))"

EXISTING_SQL = "SELECT drive_file_id, drive_modified_time FROM persons"

SYNC_LOCK_NAME = "sync"
SYNC_RETRY_LOCK_NAME = "retry"

# Short TTL so a native crash (SIGSEGV/SIGABRT — no Python `finally`) only
# wedges the scheduler for ~2 min, not 1 h. Heartbeat refreshes every 60s
# while the job lives, so a multi-hour sync keeps the lock as long as it runs.
LOCK_TTL = 120
LOCK_REFRESH = 60

PROGRESS_WRITE_EVERY = 5      # write job.meta every N files (processing)
LISTING_WRITE_EVERY = 500     # write job.meta every N files (listing)


def _ext_of(name: str) -> str | None:
    if "." not in name:
        return None
    return name.rsplit(".", 1)[-1].lower() or None


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
    download_seconds: float = 0.0
    embed_seconds: float = 0.0
    db_flush_seconds: float = 0.0
    duration_seconds: float = 0.0


@dataclass
class _WriteBuffer:
    """Batches DB writes into `executemany` calls. A crash loses at most the
    rows since the last flush (≤ one `sync_batch_commit` window)."""
    person_rows: list[tuple] = field(default_factory=list)
    status_rows: list[tuple] = field(default_factory=list)
    touch_ids: list[str] = field(default_factory=list)

    def flush(self, cur) -> float:
        started = perf_counter()
        if self.person_rows:
            cur.executemany(UPSERT_SQL, self.person_rows)
            self.person_rows.clear()
        if self.status_rows:
            cur.executemany(UPSERT_STATUS_SQL, self.status_rows)
            self.status_rows.clear()
        if self.touch_ids:
            cur.executemany(TOUCH_STATUS_SQL, [(i,) for i in self.touch_ids])
            self.touch_ids.clear()
        return perf_counter() - started


@dataclass
class _DownloadResult:
    image_bytes: bytes | None = None
    error: DriveError | None = None
    elapsed_seconds: float = 0.0


def _download_timed(file_id: str) -> _DownloadResult:
    started = perf_counter()
    try:
        return _DownloadResult(
            image_bytes=download_bytes(file_id),
            elapsed_seconds=perf_counter() - started,
        )
    except DriveError as exc:
        return _DownloadResult(error=exc, elapsed_seconds=perf_counter() - started)


def _record_status(
    writes: _WriteBuffer,
    drive_file,
    outcome: str,
    reason: str | None = None,
    rotation: int | None = None,
    det_score: float | None = None,
) -> None:
    writes.status_rows.append(
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


def _flush_writes(cur, writes: _WriteBuffer, stats: SyncStats) -> None:
    stats.db_flush_seconds += writes.flush(cur)


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


def _write_progress(job, stats: SyncStats, idx: int, total: int) -> None:
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
    if job is None:
        return
    job.meta["progress"] = {"phase": "listing", "listed": listed, "total": 0, "current": 0}
    try:
        job.save_meta()
    except Exception:
        logger.debug("failed to save job meta", exc_info=True)


def _maybe_commit_and_progress(
    conn, cur, writes: _WriteBuffer, stats: SyncStats,
    idx: int, total: int, prefix: str, job,
) -> None:
    if (stats.new + stats.updated) % settings.sync_batch_commit == 0 \
            and (stats.new + stats.updated) > 0:
        _flush_writes(cur, writes, stats)
        conn.commit()
        logger.info(
            "%s checkpoint: committed %d row(s) so far",
            prefix, stats.new + stats.updated,
        )
    if idx % PROGRESS_WRITE_EVERY == 0 or idx == total:
        _write_progress(job, stats, idx, total)


# --- locking -------------------------------------------------------------

def _write_skip_meta(job, reason: str) -> None:
    clear_active_sync()
    if job is not None:
        job.meta["progress"] = {"phase": "skipped", "reason": reason}
        try:
            job.save_meta()
        except Exception:
            logger.debug("failed to save skip meta", exc_info=True)


@contextmanager
def _acquired_or_recovered(name: str, prefix: str, job):
    """Acquire `lock:{name}` with heartbeat; auto-recover a stale lock left
    by a crashed worker. Yields the token when held, or None when a *live*
    job genuinely holds it (caller must skip)."""
    with lock_with_heartbeat(name, ttl=LOCK_TTL, refresh_every=LOCK_REFRESH) as token:
        if token is not None:
            yield token
            return

    holder = get_active_sync()
    if is_job_alive(holder):
        logger.warning("%s already in progress (holder=%s, alive); skipping", prefix, holder)
        _write_skip_meta(job, "another sync is already running")
        yield None
        return

    logger.warning("%s stale lock (holder=%s, dead) — recovering", prefix, holder)
    unlock(name)
    clear_active_sync()
    with lock_with_heartbeat(name, ttl=LOCK_TTL, refresh_every=LOCK_REFRESH) as token2:
        if token2 is not None:
            logger.warning("%s recovered stale lock; proceeding", prefix)
            yield token2
            return
        logger.warning("%s lock re-taken during recovery race; skipping", prefix)
        _write_skip_meta(job, "another sync is already running")
        yield None


# --- per-file pipeline (single, synchronous) -----------------------------

def _process_one(
    writes: _WriteBuffer,
    drive_file,
    *,
    is_new: bool,
    is_changed: bool,
    stats: SyncStats,
    log_pos: str,
    download: _DownloadResult | None = None,
) -> None:
    """Classify → download → embed → record, for one file.

    The single per-file path shared by `run_sync` and `run_retry`. `download`
    may be a pre-fetched result (depth-1 prefetch); otherwise it is fetched
    synchronously here. Unchanged files only bump `last_seen_at` so their
    prior outcome stays sticky.
    """
    if not is_new and not is_changed:
        logger.info("%s skip: unchanged %s", log_pos, drive_file.name)
        stats.skipped_unchanged += 1
        writes.touch_ids.append(drive_file.id)
        return

    if download is None:
        download = _download_timed(drive_file.id)
    stats.download_seconds += download.elapsed_seconds
    if download.error is not None:
        logger.warning(
            "%s drive error: %s (%s) — %s",
            log_pos, drive_file.name, drive_file.id, download.error,
        )
        stats.skipped_drive_error += 1
        _record_status(writes, drive_file, "drive_error", reason=str(download.error)[:500])
        return

    logger.info(
        "%s embedding %s (%d bytes, mime=%s)",
        log_pos, drive_file.name,
        len(download.image_bytes or b""), drive_file.mime_type,
    )
    started = perf_counter()
    try:
        result = embed(download.image_bytes, profile="sync")  # type: ignore[arg-type]
    except NoFaceDetected:
        logger.info("%s no face: %s (skipped)", log_pos, drive_file.name)
        stats.skipped_no_face += 1
        _record_status(writes, drive_file, "no_face")
        return
    except InvalidImage as exc:
        logger.warning("%s invalid image: %s — %s", log_pos, drive_file.name, exc)
        stats.skipped_invalid += 1
        _record_status(writes, drive_file, "invalid_image", reason=str(exc)[:500])
        return
    except Exception as exc:
        logger.exception("%s unexpected embed error: %s — %s", log_pos, drive_file.name, exc)
        stats.skipped_invalid += 1
        _record_status(writes, drive_file, "embed_error", reason=str(exc)[:500])
        return
    finally:
        stats.embed_seconds += perf_counter() - started

    writes.person_rows.append(
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
        writes, drive_file, "enrolled",
        rotation=result.rotation, det_score=result.det_score,
    )
    logger.info(
        "%s %s: %s (det_score=%.3f, rotation=%d°)",
        log_pos, verb, drive_file.name, result.det_score, result.rotation,
    )


def _iter_downloads(items: list, prefetch: bool):
    """Yield `(idx, drive_file, is_new, is_changed, download|None)`.

    `items` is `[(idx, drive_file, is_new, is_changed), …]`. Unchanged files
    need no bytes (download=None). With `prefetch`, a single background thread
    holds at most one outstanding download (the next embed-needing file) while
    the main thread embeds the current one — overlaps Drive I/O with GPU
    compute without the multi-thread surface that destabilised onnxruntime.
    """
    def _needs(it) -> bool:
        return it[2] or it[3]  # is_new or is_changed

    if not prefetch:
        for idx, df, is_new, is_changed in items:
            dl = _download_timed(df.id) if (is_new or is_changed) else None
            yield idx, df, is_new, is_changed, dl
        return

    needing = [pos for pos, it in enumerate(items) if _needs(it)]
    pending: dict[int, Future] = {}
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="dl") as ex:
        np = 0
        if needing:
            pending[needing[0]] = ex.submit(_download_timed, items[needing[0]][1].id)
        for pos, (idx, df, is_new, is_changed) in enumerate(items):
            if pos in pending:
                dl = pending.pop(pos).result()
                np += 1
                if np < len(needing):
                    nxt = needing[np]
                    pending[nxt] = ex.submit(_download_timed, items[nxt][1].id)
                yield idx, df, is_new, is_changed, dl
            elif is_new or is_changed:  # defensive: not prefetched
                yield idx, df, is_new, is_changed, _download_timed(df.id)
            else:
                yield idx, df, is_new, is_changed, None


def _prune_missing_rows(cur, seen: set[str]) -> tuple[int, int]:
    # An empty `seen` means listing produced nothing — almost always a Drive
    # auth blip / folder-id typo / mid-listing crash, not a genuinely empty
    # folder. Pruning would wipe the DB; refuse and let the operator look.
    if not seen:
        logger.error(
            "prune aborted: seen-set empty (Drive listing produced 0 files). "
            "Refusing to DELETE FROM persons/file_status — check Drive access."
        )
        return 0, 0
    seen_ids = list(seen)
    cur.execute(DELETE_MISSING_SQL, (seen_ids,))
    deleted_persons = cur.rowcount
    cur.execute(DELETE_MISSING_STATUS_SQL, (seen_ids,))
    deleted_status = cur.rowcount
    return deleted_persons, deleted_status


def run_sync(prune: bool = True) -> SyncStats:
    stats = SyncStats()
    started = datetime.now(timezone.utc)
    prefix = f"[sync {_job_label()}]"
    job = _current_job()

    with _acquired_or_recovered(SYNC_LOCK_NAME, prefix, job) as token:
        if token is None:
            return stats
        try:
            logger.info(
                "%s starting (folder=%s, prune=%s, prefetch=%s)",
                prefix, settings.gdrive_folder_id, prune, settings.sync_prefetch,
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
            # Set BEFORE the embed loop so the sidebar "In Drive" updates
            # immediately and survives a mid-embed crash.
            set_drive_total(total)
            logger.info("%s listed %d image file(s)", prefix, total)
            _write_progress(job, stats, 0, total)

            seen: set[str] = set()
            items: list = []
            for idx, df in enumerate(drive_files, start=1):
                seen.add(df.id)
                is_new, is_changed = _classify(df, existing)
                items.append((idx, df, is_new, is_changed))

            with pool.connection() as conn, conn.cursor() as cur:
                writes = _WriteBuffer()
                for idx, df, is_new, is_changed, dl in _iter_downloads(
                    items, settings.sync_prefetch
                ):
                    _process_one(
                        writes, df,
                        is_new=is_new, is_changed=is_changed,
                        stats=stats, log_pos=f"{prefix} [{idx}/{total}]",
                        download=dl,
                    )
                    _maybe_commit_and_progress(
                        conn, cur, writes, stats, idx, total, prefix, job,
                    )
                _flush_writes(cur, writes, stats)
                conn.commit()

                if prune:
                    logger.info("%s pruning rows for files removed from Drive...", prefix)
                    deleted_persons, deleted_status = _prune_missing_rows(cur, seen)
                    stats.deleted = deleted_persons
                    conn.commit()
                    logger.info(
                        "%s pruned %d enrolled row(s) and %d status row(s)",
                        prefix, stats.deleted, deleted_status,
                    )
        finally:
            clear_active_sync()
            set_last_sync_finished_at(datetime.now(timezone.utc).isoformat())

    stats.duration_seconds = (datetime.now(timezone.utc) - started).total_seconds()
    logger.info(
        "%s done in %.1fs — committed=%d (new=%d updated=%d) of listed=%d · "
        "unchanged=%d deleted=%d skipped_no_face=%d skipped_invalid=%d "
        "skipped_drive_error=%d timings(download=%.1fs embed=%.1fs db=%.1fs)",
        prefix, stats.duration_seconds,
        stats.new + stats.updated, stats.new, stats.updated, stats.listed,
        stats.skipped_unchanged, stats.deleted,
        stats.skipped_no_face, stats.skipped_invalid, stats.skipped_drive_error,
        stats.download_seconds, stats.embed_seconds, stats.db_flush_seconds,
    )
    return stats


_schema_bootstrapped = False


def _ensure_pool_open() -> None:
    global _schema_bootstrapped
    if pool.closed:
        pool.open()
        pool.wait()
    if not _schema_bootstrapped:
        # Idempotent re-run of init_db.sql so a worker on an older volume
        # still gets the latest tables/indexes (CREATE … IF NOT EXISTS).
        try:
            bootstrap_schema()
        except Exception:
            logger.exception("schema bootstrap failed in worker; continuing")
        _schema_bootstrapped = True


def run_sync_job(prune: bool = True) -> dict:
    _ensure_pool_open()
    return run_sync(prune=prune).__dict__


def run_retry(file_ids: list[str]) -> SyncStats:
    """Re-run the embedding pipeline for an explicit list of Drive file IDs.

    Skips the Drive walk; looks each up via files.get(). Forces the embed
    path (is_changed=True). No prune. Own lock (lock:retry).
    """
    stats = SyncStats()
    started = datetime.now(timezone.utc)
    prefix = f"[retry {_job_label()}]"
    job = _current_job()

    with _acquired_or_recovered(SYNC_RETRY_LOCK_NAME, prefix, job) as token:
        if token is None:
            return stats
        try:
            total = len(file_ids)
            stats.listed = total
            logger.info("%s starting (count=%d)", prefix, total)
            _write_progress(job, stats, 0, total)

            existing = _existing()

            with pool.connection() as conn, conn.cursor() as cur:
                writes = _WriteBuffer()
                for idx, file_id in enumerate(file_ids, start=1):
                    pos = f"{prefix} [{idx}/{total}]"
                    try:
                        drive_file = get_metadata(file_id)
                        is_new = drive_file.id not in existing
                        _process_one(
                            writes, drive_file,
                            is_new=is_new, is_changed=True,
                            stats=stats, log_pos=pos,
                        )
                    except DriveError as exc:
                        # Metadata lookup failed — route through the shared
                        # drive_error path with a stand-in DriveFile.
                        _process_one(
                            writes, DriveFile(file_id, file_id, "", None),
                            is_new=False, is_changed=True,
                            stats=stats, log_pos=pos,
                            download=_DownloadResult(error=exc),
                        )
                    _maybe_commit_and_progress(
                        conn, cur, writes, stats, idx, total, prefix, job,
                    )
                _flush_writes(cur, writes, stats)
                conn.commit()
        finally:
            clear_active_sync()
            set_last_sync_finished_at(datetime.now(timezone.utc).isoformat())

    stats.duration_seconds = (datetime.now(timezone.utc) - started).total_seconds()
    logger.info(
        "%s done in %.1fs — new=%d updated=%d "
        "skipped_no_face=%d skipped_invalid=%d skipped_drive_error=%d "
        "timings(download=%.1fs embed=%.1fs db=%.1fs)",
        prefix, stats.duration_seconds, stats.new, stats.updated,
        stats.skipped_no_face, stats.skipped_invalid, stats.skipped_drive_error,
        stats.download_seconds, stats.embed_seconds, stats.db_flush_seconds,
    )
    return stats


def run_retry_job(file_ids: list[str]) -> dict:
    _ensure_pool_open()
    return run_retry(file_ids).__dict__

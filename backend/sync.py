import logging
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
from backend.db import pool
from backend.embedding import InvalidImage, NoFaceDetected, embed
from backend.gdrive import DriveError, download_bytes, list_image_files

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


PROGRESS_WRITE_EVERY = 5  # write to job.meta every N files


def _write_progress(job, stats: "SyncStats", idx: int, total: int) -> None:
    if job is None:
        return
    job.meta["progress"] = {
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


def run_sync(prune: bool = True) -> SyncStats:
    stats = SyncStats()
    started = datetime.now(timezone.utc)
    prefix = f"[sync {_job_label()}]"
    job = _current_job()

    if not lock(SYNC_LOCK_NAME, ttl=3600):
        logger.warning("%s already in progress; skipping", prefix)
        return stats

    try:
        logger.info(
            "%s starting (folder=%s, prune=%s)",
            prefix, settings.gdrive_folder_id, prune,
        )

        existing = _existing()
        logger.info("%s walking Drive folder...", prefix)
        drive_files = list(list_image_files())
        total = len(drive_files)
        stats.listed = total
        set_drive_total(total)
        logger.info("%s listed %d image file(s)", prefix, total)
        _write_progress(job, stats, 0, total)

        seen: set[str] = set()
        with pool.connection() as conn, conn.cursor() as cur:
            for idx, drive_file in enumerate(drive_files, start=1):
                pos = f"{prefix} [{idx}/{total}]"
                seen.add(drive_file.id)
                prior_mtime = existing.get(drive_file.id)
                is_new = drive_file.id not in existing
                is_changed = (
                    not is_new
                    and drive_file.modified_time is not None
                    and prior_mtime is not None
                    and drive_file.modified_time > prior_mtime
                )

                if not is_new and not is_changed:
                    logger.info("%s skip: unchanged %s", pos, drive_file.name)
                    stats.skipped_unchanged += 1
                    _record_status(cur, drive_file, "unchanged")
                    continue

                try:
                    image_bytes = download_bytes(drive_file.id)
                except DriveError as exc:
                    logger.warning(
                        "%s drive error: %s (%s) — %s",
                        pos, drive_file.name, drive_file.id, exc,
                    )
                    stats.skipped_drive_error += 1
                    _record_status(cur, drive_file, "drive_error", reason=str(exc)[:500])
                    continue

                try:
                    result = embed(image_bytes)
                except NoFaceDetected:
                    logger.info("%s no face: %s (skipped)", pos, drive_file.name)
                    stats.skipped_no_face += 1
                    _record_status(cur, drive_file, "no_face")
                    continue
                except InvalidImage as exc:
                    logger.warning(
                        "%s invalid image: %s — %s", pos, drive_file.name, exc,
                    )
                    stats.skipped_invalid += 1
                    _record_status(cur, drive_file, "invalid_image", reason=str(exc)[:500])
                    continue
                except Exception as exc:
                    # Defense in depth: an unexpected exception in the embed
                    # pipeline (e.g. an obscure cv2/onnxruntime error) should
                    # skip this one file, not kill the whole job.
                    logger.exception(
                        "%s unexpected embed error: %s — %s", pos, drive_file.name, exc,
                    )
                    stats.skipped_invalid += 1
                    _record_status(cur, drive_file, "embed_error", reason=str(exc)[:500])
                    continue

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
                    pos, verb, drive_file.name, result.det_score, result.rotation,
                )

                if (stats.new + stats.updated) % settings.sync_batch_commit == 0:
                    conn.commit()
                    logger.info(
                        "%s checkpoint: committed %d row(s) so far",
                        prefix, stats.new + stats.updated,
                    )

                if idx % PROGRESS_WRITE_EVERY == 0 or idx == total:
                    _write_progress(job, stats, idx, total)
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


def _ensure_pool_open() -> None:
    if pool.closed:
        pool.open()
        pool.wait()


def run_sync_job(prune: bool = True) -> dict:
    _ensure_pool_open()
    stats = run_sync(prune=prune)
    return stats.__dict__

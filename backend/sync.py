import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from backend.cache import lock, unlock
from backend.config import settings
from backend.db import pool
from backend.embedding import InvalidImage, NoFaceDetected, embed
from backend.gdrive import DriveError, DriveFile, download_bytes, list_image_files

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

EXISTING_SQL = "SELECT drive_file_id, drive_modified_time FROM persons"

SYNC_LOCK_NAME = "sync"


@dataclass
class SyncStats:
    listed: int = 0
    new: int = 0
    updated: int = 0
    skipped_no_face: int = 0
    skipped_invalid: int = 0
    skipped_drive_error: int = 0
    deleted: int = 0
    duration_seconds: float = 0.0


def _existing() -> dict[str, datetime | None]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(EXISTING_SQL)
        return {row[0]: row[1] for row in cur.fetchall()}


def run_sync(prune: bool = True) -> SyncStats:
    stats = SyncStats()
    started = datetime.now(timezone.utc)
    if not lock(SYNC_LOCK_NAME, ttl=3600):
        logger.warning("sync already in progress; skipping")
        return stats
    try:
        existing = _existing()
        seen: set[str] = set()
        with pool.connection() as conn, conn.cursor() as cur:
            for drive_file in list_image_files():
                stats.listed += 1
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
                    continue
                try:
                    image_bytes = download_bytes(drive_file.id)
                except DriveError as exc:
                    logger.warning("drive error for %s: %s", drive_file.id, exc)
                    stats.skipped_drive_error += 1
                    continue
                try:
                    result = embed(image_bytes)
                except NoFaceDetected:
                    logger.info("no face: %s (%s)", drive_file.name, drive_file.id)
                    stats.skipped_no_face += 1
                    continue
                except InvalidImage as exc:
                    logger.warning("invalid image %s: %s", drive_file.id, exc)
                    stats.skipped_invalid += 1
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
                else:
                    stats.updated += 1
                if (stats.new + stats.updated) % settings.sync_batch_commit == 0:
                    conn.commit()
            conn.commit()
            if prune:
                stale = [fid for fid in existing if fid not in seen]
                if stale:
                    cur.execute(DELETE_SQL, (stale,))
                    stats.deleted = len(stale)
                    conn.commit()
    finally:
        unlock(SYNC_LOCK_NAME)
    stats.duration_seconds = (datetime.now(timezone.utc) - started).total_seconds()
    logger.info(
        "sync done in %.1fs: listed=%d new=%d updated=%d deleted=%d "
        "skipped_no_face=%d skipped_invalid=%d skipped_drive_error=%d",
        stats.duration_seconds,
        stats.listed,
        stats.new,
        stats.updated,
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

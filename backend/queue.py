import logging
from datetime import datetime, timezone
from functools import lru_cache

from rq import Queue

from backend.cache import get_redis, set_active_sync

logger = logging.getLogger(__name__)

SYNC_QUEUE = "sync"
SYNC_JOB_TIMEOUT = 60 * 60


@lru_cache(maxsize=1)
def get_queue() -> Queue:
    return Queue(SYNC_QUEUE, connection=get_redis())


def enqueue_sync(prune: bool = True) -> str:
    job = get_queue().enqueue(
        "backend.sync.run_sync_job",
        prune,
        job_timeout=SYNC_JOB_TIMEOUT,
    )
    # Mark as active immediately so the UI's progress widget lights up
    # even before the worker has picked the job up.
    set_active_sync(job.id)
    return job.id


def enqueue_retry(file_ids: list[str]) -> str:
    job = get_queue().enqueue(
        "backend.sync.run_retry_job",
        file_ids,
        job_timeout=SYNC_JOB_TIMEOUT,
    )
    set_active_sync(job.id)
    return job.id


def fetch_job(job_id: str):
    return get_queue().fetch_job(job_id)


def is_job_alive(job_id: str | None) -> bool:
    """True if `job_id` refers to an RQ job that is plausibly still running.

    Used to decide whether a held sync lock is genuine or stale leftover from
    a crashed worker. Conservative: returns False (→ "stale, safe to clear")
    only when we're confident the job is dead — never-recorded, RQ-evicted,
    explicitly failed/stopped, or `started` but heartbeat-stale beyond
    2× job_timeout (the worker died without RQ transitioning the state yet).
    """
    if not job_id:
        return False
    try:
        job = get_queue().fetch_job(job_id)
    except Exception:
        logger.debug("is_job_alive: fetch_job failed for %s", job_id, exc_info=True)
        # Be conservative the other way on transient Redis errors: assume
        # alive so we don't clear a lock we can't verify.
        return True
    if job is None:
        return False
    try:
        status = job.get_status(refresh=True)
    except Exception:
        return True
    if status in ("failed", "stopped", "canceled"):
        return False
    if status in ("queued", "deferred", "scheduled"):
        return True
    # status == "started": trust it only if the heartbeat is recent.
    last_hb = getattr(job, "last_heartbeat", None)
    if last_hb is None:
        return True
    if last_hb.tzinfo is None:
        last_hb = last_hb.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - last_hb).total_seconds()
    return age <= 2 * SYNC_JOB_TIMEOUT

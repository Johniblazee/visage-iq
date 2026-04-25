from functools import lru_cache

from rq import Queue

from backend.cache import get_redis

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
    return job.id


def fetch_job(job_id: str):
    return get_queue().fetch_job(job_id)

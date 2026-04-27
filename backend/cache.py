from functools import lru_cache

import redis

from backend.config import settings


@lru_cache(maxsize=1)
def get_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=False)


def image_key(file_id: str, modified_time: str | None) -> str:
    return f"gdrive:img:{file_id}:{modified_time or 'na'}"


def get_image(file_id: str, modified_time: str | None) -> bytes | None:
    val = get_redis().get(image_key(file_id, modified_time))
    return val if isinstance(val, (bytes, bytearray)) else None


def set_image(file_id: str, modified_time: str | None, data: bytes) -> None:
    get_redis().setex(
        image_key(file_id, modified_time),
        settings.image_cache_ttl_seconds,
        data,
    )


def lock(name: str, ttl: int = 60) -> bool:
    return bool(get_redis().set(f"lock:{name}", b"1", nx=True, ex=ttl))


def unlock(name: str) -> None:
    get_redis().delete(f"lock:{name}")


# --- Drive-folder stats (set by sync, read by /health) ---

DRIVE_TOTAL_KEY = "drive:total"
DRIVE_LAST_SYNC_KEY = "drive:last_sync_finished_at"


def set_drive_total(n: int) -> None:
    get_redis().set(DRIVE_TOTAL_KEY, str(n))


def get_drive_total() -> int | None:
    val = get_redis().get(DRIVE_TOTAL_KEY)
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray)):
        val = val.decode("utf-8", errors="ignore")
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def set_last_sync_finished_at(iso_ts: str) -> None:
    get_redis().set(DRIVE_LAST_SYNC_KEY, iso_ts)


def get_last_sync_finished_at() -> str | None:
    val = get_redis().get(DRIVE_LAST_SYNC_KEY)
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray)):
        return val.decode("utf-8", errors="ignore")
    return val


# --- Active sync tracking (set on enqueue, cleared in run_sync's finally) ---

ACTIVE_SYNC_KEY = "sync:active_job_id"
ACTIVE_SYNC_TTL = 60 * 60  # 1h safety net if worker crashes without clearing


def set_active_sync(job_id: str) -> None:
    get_redis().set(ACTIVE_SYNC_KEY, job_id, ex=ACTIVE_SYNC_TTL)


def get_active_sync() -> str | None:
    val = get_redis().get(ACTIVE_SYNC_KEY)
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray)):
        return val.decode("utf-8", errors="ignore")
    return val


def clear_active_sync() -> None:
    get_redis().delete(ACTIVE_SYNC_KEY)

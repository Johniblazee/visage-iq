import logging
import threading
import uuid
from contextlib import contextmanager
from functools import lru_cache

import redis

from backend.config import settings

logger = logging.getLogger(__name__)


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


def unlock(name: str) -> None:
    get_redis().delete(f"lock:{name}")


# --- Crash-safe lock: short TTL + heartbeat refresh + token-scoped release ---
#
# A native abort (SIGSEGV/SIGABRT from onnxruntime/CUDA) kills the worker
# process without running Python `finally`, so a plain `lock(..., ttl=3600)`
# stays held for a full hour and every scheduled sync in that window skips.
# With a short TTL plus a daemon thread that refreshes it while the job is
# alive: if the process dies, refreshes stop and the lock self-expires within
# `ttl` seconds. Release is token-scoped so a sync that legitimately acquired
# the lock after a prior holder's TTL lapsed is never released by the dead
# holder's late cleanup.

# Atomic compare-and-delete: only delete if the value still matches our token.
_RELEASE_LUA = """
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
"""

# Atomic compare-and-refresh: only extend TTL if we still own the lock.
_REFRESH_LUA = """
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0
"""


def _set_nx_with_token(name: str, token: str, ttl: int) -> bool:
    return bool(get_redis().set(f"lock:{name}", token, nx=True, ex=ttl))


def _release_if_owner(name: str, token: str) -> None:
    try:
        get_redis().eval(_RELEASE_LUA, 1, f"lock:{name}", token)
    except redis.RedisError:
        logger.debug("lock release failed for %s", name, exc_info=True)


def _refresh_loop(
    name: str, token: str, ttl: int, refresh_every: int, stop: threading.Event
) -> None:
    while not stop.wait(refresh_every):
        try:
            ok = get_redis().eval(_REFRESH_LUA, 1, f"lock:{name}", token, ttl)
            if not ok:
                # We no longer own the lock (expired + re-acquired elsewhere).
                # Stop refreshing; nothing useful left to extend.
                logger.warning(
                    "lock:%s no longer owned by this job; stopping heartbeat", name
                )
                return
        except redis.RedisError:
            logger.debug("lock refresh failed for %s", name, exc_info=True)


@contextmanager
def lock_with_heartbeat(name: str, ttl: int = 120, refresh_every: int = 60):
    """Acquire `lock:{name}` with a short TTL, refresh it from a daemon thread
    while the with-block runs, and release it (token-scoped) on exit.

    Yields the lock token on success, or `None` if the lock is already held.
    Crash-safe: if the holder process dies, the heartbeat thread dies with it
    and the lock expires within `ttl` seconds instead of the old 1-hour TTL.
    """
    token = uuid.uuid4().hex
    if not _set_nx_with_token(name, token, ttl):
        yield None
        return
    stop = threading.Event()
    t = threading.Thread(
        target=_refresh_loop,
        args=(name, token, ttl, refresh_every, stop),
        name=f"lock-hb-{name}",
        daemon=True,
    )
    t.start()
    try:
        yield token
    finally:
        stop.set()
        _release_if_owner(name, token)


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

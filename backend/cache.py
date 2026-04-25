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

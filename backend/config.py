from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://postgres:pg@db:5432/postgres"
    redis_url: str = "redis://redis:6379/0"

    gdrive_sa_json: str = ""
    gdrive_folder_id: str = ""
    gdrive_recursive: bool = True

    insightface_model: str = "buffalo_l"
    det_size: int = 640
    onnx_providers: str = "CPUExecutionProvider"
    # Comma-separated InsightFace sub-modules to load. Defaults to detection +
    # recognition only — skips genderage / landmark_2d_106 / landmark_3d_68
    # for ~30–40% lower worker RAM. Set empty (or to all five) to restore the
    # full default loadout.
    insightface_modules: str = "detection,recognition"
    # Per-sync embedding parallelism. 1 = current synchronous behavior.
    # Use >1 only on CPU; on GPU keep at 1 (multiple processes oversubscribe
    # one GPU and thrash VRAM).
    embed_workers: int = 1
    # Bounded inflight queue for the ProcessPoolExecutor. Prevents reading
    # all image bytes for a 22k-file sync into memory at once.
    embed_worker_max_inflight: int = 8
    # Drive-download prefetch: a ThreadPoolExecutor pulls upcoming files in
    # parallel with embedding so I/O and inference overlap. This is the
    # main GPU win — embedding is fast on GPU but Drive download is the
    # bottleneck. Set to 1 to disable prefetch (synchronous downloads).
    download_workers: int = 4
    # Cap on simultaneously prefetched downloads. Each pending download
    # buffers ~1–5 MB of image bytes; 8 inflight ≈ 40 MB upper bound.
    download_max_inflight: int = 8
    rotation_enabled: bool = True
    # rotation_mode: "off" | "fallback" | "always"
    #   off       — only 0° is ever tried.
    #   fallback  — try 0°; only try 90/180/270 if 0° found no face.
    #   always    — iterate all four; pick highest det_score (with early-exit).
    # `rotation_enabled=false` is a kill-switch that forces "off" regardless of mode.
    rotation_mode: str = "fallback"
    rotation_early_exit_score: float = 0.85

    match_threshold: float = 0.40
    review_threshold: float = 0.30
    top_k: int = 3

    sync_interval_min: int = 30
    sync_batch_commit: int = 50

    image_cache_ttl_seconds: int = 86400
    listing_cache_ttl_seconds: int = 300

    match_rate_limit: str = "30/minute"
    sync_rate_limit: str = "5/minute"

    api_base_url: str = "http://api:8000"

    @property
    def providers_list(self) -> list[str]:
        return [p.strip() for p in self.onnx_providers.split(",") if p.strip()]

    @property
    def insightface_modules_list(self) -> list[str] | None:
        parts = [m.strip() for m in self.insightface_modules.split(",") if m.strip()]
        return parts or None


settings = Settings()

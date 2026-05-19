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
    # Sync embeds one file at a time (single-throughput — stable on GPU).
    # When true, a single background thread pre-fetches the next file's
    # bytes while the current file is embedding, overlapping Drive I/O with
    # GPU compute (~up to 2x when download-bound). One thread, one inflight.
    sync_prefetch: bool = False
    # Optional sync-specific embedding settings. Leave blank / unset to reuse
    # the interactive `/match` settings above.
    sync_insightface_model: str = ""
    sync_det_size: int | None = None
    sync_insightface_modules: str = ""
    # Sync-only ONNX providers. Leave blank to reuse ONNX_PROVIDERS. Set to
    # "CPUExecutionProvider" to force the worker onto CPU while /match stays on
    # GPU — the escape hatch for when the GPU stack (onnxruntime-gpu/CUDA)
    # crashes the worker mid-sync (native SIGSEGV/SIGABRT).
    sync_onnx_providers: str = ""
    rotation_enabled: bool = True
    # rotation_mode: "off" | "fallback" | "always"
    #   off       — only 0° is ever tried.
    #   fallback  — try 0°; only try 90/180/270 if 0° found no face.
    #   always    — iterate all four; pick highest det_score (with early-exit).
    # `rotation_enabled=false` is a kill-switch that forces "off" regardless of mode.
    rotation_mode: str = "fallback"
    rotation_early_exit_score: float = 0.85
    sync_rotation_enabled: bool | None = None
    sync_rotation_mode: str = ""
    sync_rotation_early_exit_score: float | None = None

    match_threshold: float = 0.40
    review_threshold: float = 0.30
    top_k: int = 3

    sync_interval_min: int = 30
    sync_batch_commit: int = 50

    image_cache_ttl_seconds: int = 86400

    match_rate_limit: str = "30/minute"
    sync_rate_limit: str = "5/minute"

    @property
    def providers_list(self) -> list[str]:
        return [p.strip() for p in self.onnx_providers.split(",") if p.strip()]

    @property
    def insightface_modules_list(self) -> list[str] | None:
        parts = [m.strip() for m in self.insightface_modules.split(",") if m.strip()]
        return parts or None

    @property
    def sync_providers_list(self) -> list[str]:
        raw = self.sync_onnx_providers.strip()
        if not raw:
            return self.providers_list
        return [p.strip() for p in raw.split(",") if p.strip()]

    @property
    def sync_insightface_model_value(self) -> str:
        return self.sync_insightface_model.strip() or self.insightface_model

    @property
    def sync_det_size_value(self) -> int:
        return self.sync_det_size or self.det_size

    @property
    def sync_insightface_modules_list(self) -> list[str] | None:
        if not self.sync_insightface_modules.strip():
            return self.insightface_modules_list
        parts = [m.strip() for m in self.sync_insightface_modules.split(",") if m.strip()]
        return parts or None

    @property
    def sync_rotation_enabled_value(self) -> bool:
        if self.sync_rotation_enabled is None:
            return self.rotation_enabled
        return self.sync_rotation_enabled

    @property
    def sync_rotation_mode_value(self) -> str:
        return self.sync_rotation_mode.strip() or self.rotation_mode

    @property
    def sync_rotation_early_exit_score_value(self) -> float:
        if self.sync_rotation_early_exit_score is None:
            return self.rotation_early_exit_score
        return self.sync_rotation_early_exit_score


settings = Settings()

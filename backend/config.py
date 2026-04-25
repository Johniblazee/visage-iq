from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://postgres:pg@db:5432/postgres"
    redis_url: str = "redis://redis:6379/0"

    gdrive_sa_json_path: str = "/run/secrets/gdrive-sa"
    gdrive_sa_json: str = ""
    gdrive_folder_id: str = ""
    gdrive_recursive: bool = True

    insightface_model: str = "buffalo_l"
    det_size: int = 640
    onnx_providers: str = "CPUExecutionProvider"

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


settings = Settings()

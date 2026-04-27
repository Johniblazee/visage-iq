from typing import Literal

from pydantic import BaseModel, Field

Verdict = Literal["MATCH", "REVIEW", "NO_MATCH"]


class Candidate(BaseModel):
    drive_file_id: str
    title: str
    similarity: float = Field(ge=-1.0, le=1.0)
    confidence_pct: float = Field(ge=0.0, le=100.0)
    verdict: Verdict


class MatchResponse(BaseModel):
    query_face_bbox: list[int]
    query_face_count: int
    query_det_score: float
    query_rotation: int
    enrolled_count: int
    candidates: list[Candidate]


class HealthResponse(BaseModel):
    db: str
    redis: str
    drive: str
    model: str
    providers: list[str]
    enrolled_count: int
    drive_total: int | None = None
    last_sync_finished_at: str | None = None
    active_sync_job_id: str | None = None


class SyncEnqueueResponse(BaseModel):
    job_id: str
    status: str = "queued"


class SyncJobStatus(BaseModel):
    job_id: str
    status: str
    progress: dict | None = None
    result: dict | None = None
    error: str | None = None


class OutcomeExtCount(BaseModel):
    outcome: str
    ext: str
    count: int


class AnalyticsSummary(BaseModel):
    by_outcome: dict[str, int]
    by_ext: dict[str, int]
    by_outcome_and_ext: list[OutcomeExtCount]
    totals: dict[str, int]


class FileStatusRow(BaseModel):
    drive_file_id: str
    drive_file_name: str
    mime_type: str | None = None
    ext: str | None = None
    outcome: str
    reason: str | None = None
    rotation: int | None = None
    det_score: float | None = None
    last_seen_at: str | None = None


class FileStatusPage(BaseModel):
    rows: list[FileStatusRow]
    total: int
    limit: int
    offset: int

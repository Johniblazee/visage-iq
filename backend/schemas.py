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
    candidates: list[Candidate]


class HealthResponse(BaseModel):
    db: str
    redis: str
    drive: str
    model: str
    providers: list[str]


class SyncEnqueueResponse(BaseModel):
    job_id: str
    status: str = "queued"


class SyncJobStatus(BaseModel):
    job_id: str
    status: str
    result: dict | None = None
    error: str | None = None

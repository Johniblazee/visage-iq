from typing import Literal

from pydantic import BaseModel, Field

Verdict = Literal["MATCH", "REVIEW", "NO_MATCH"]


class StudentRef(BaseModel):
    full_name: str
    student_id: str | None = None
    location: str | None = None


class Candidate(BaseModel):
    drive_file_id: str
    title: str
    similarity: float = Field(ge=-1.0, le=1.0)
    confidence_pct: float = Field(ge=0.0, le=100.0)
    verdict: Verdict
    student: StudentRef | None = None


class MatchResponse(BaseModel):
    query_face_bbox: list[int]
    query_face_count: int
    query_det_score: float
    query_rotation: int
    enrolled_count: int
    model: str
    candidates: list[Candidate]


class FaceMatchResult(BaseModel):
    face_index: int
    bbox: list[int]
    det_score: float
    candidates: list[Candidate]


class MatchManyResponse(BaseModel):
    query_face_count: int
    query_rotation: int
    enrolled_count: int
    model: str
    faces: list[FaceMatchResult]


class ModelInfo(BaseModel):
    name: str
    primary: bool
    enrolled_count: int


class ConfigResponse(BaseModel):
    match_threshold: float
    review_threshold: float
    top_k: int
    model: str  # primary embedding model
    models: list[ModelInfo]


class ConfigUpdate(BaseModel):
    match_threshold: float | None = Field(default=None, ge=0.05, le=0.98)
    review_threshold: float | None = Field(default=None, ge=0.01, le=0.95)
    top_k: int | None = Field(default=None, ge=1, le=50)


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


class RetryRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1, max_length=1000)


class RetryEnqueueResponse(BaseModel):
    job_id: str
    count: int
    status: str = "queued"


class WorkerStatus(BaseModel):
    suspended: bool


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


class AuditRow(BaseModel):
    id: int
    ts: str | None = None
    actor: str
    action: str
    target: str | None = None
    details: dict | None = None


class AuditPage(BaseModel):
    rows: list[AuditRow]
    total: int
    limit: int
    offset: int


class StudentRow(BaseModel):
    id: int
    natural_key: str
    student_id: str | None = None
    full_name: str
    email: str | None = None
    location: str | None = None
    photo_drive_file_id: str | None = None


class StudentPage(BaseModel):
    rows: list[StudentRow]
    total: int
    limit: int
    offset: int


class StudentFacets(BaseModel):
    locations: list[str]
    total: int
    last_sync: dict | None = None

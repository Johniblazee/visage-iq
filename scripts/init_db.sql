CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS persons (
    id                  BIGSERIAL PRIMARY KEY,
    drive_file_id       TEXT UNIQUE NOT NULL,
    drive_file_name     TEXT NOT NULL,
    drive_modified_time TIMESTAMPTZ,
    face_embedding      vector(512) NOT NULL,
    det_score           REAL,
    face_count          INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS persons_embedding_hnsw
    ON persons USING hnsw (face_embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS persons_modified_idx
    ON persons (drive_modified_time);

-- Compare-model embeddings (dual enrollment). The primary model's vectors
-- live in persons.face_embedding; each COMPARE_MODELS pack gets its own rows
-- here — embedding spaces are incompatible across packs, so they are never
-- mixed in one column. Per-model partial HNSW indexes are created at
-- bootstrap (backend/db.py) because the model names come from env config.
CREATE TABLE IF NOT EXISTS alt_embeddings (
    drive_file_id TEXT NOT NULL,
    model         TEXT NOT NULL,
    embedding     vector(512) NOT NULL,
    det_score     REAL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (drive_file_id, model)
);

-- Per-file sync outcome log. One row per Drive file (latest-state).
-- Drives the analytics page: counts by outcome, by extension, skipped-file browser.
CREATE TABLE IF NOT EXISTS file_status (
    drive_file_id   TEXT PRIMARY KEY,
    drive_file_name TEXT NOT NULL,
    mime_type       TEXT,
    ext             TEXT,
    outcome         TEXT NOT NULL,
    reason          TEXT,
    rotation        INTEGER,
    det_score       REAL,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS file_status_outcome_idx ON file_status (outcome);
CREATE INDEX IF NOT EXISTS file_status_ext_idx     ON file_status (ext);

-- Heal rows damaged by pre-48a3782 syncs: every resync used to UPSERT
-- unchanged files as outcome='unchanged' with NULL reason/rotation/det_score,
-- wiping the recorded enrolled/no_face/error details. Current sync code never
-- writes 'unchanged' (it only bumps last_seen_at), so any such row is damage.
-- Restore 'enrolled' + det_score from persons; failed files (no persons row)
-- re-process on the next sync and rewrite their own records. Idempotent —
-- bootstrap_schema runs this file on every worker start.
UPDATE file_status fs
SET outcome = 'enrolled', det_score = p.det_score
FROM persons p
WHERE p.drive_file_id = fs.drive_file_id AND fs.outcome = 'unchanged';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Student directory, synced from the "Students Passport" workbook ('passports' tab).
-- Identity + enrolment columns only: id, email, name, location, programme,
-- cohort, level-semester, passport photo.
CREATE TABLE IF NOT EXISTS students (
    id                  BIGSERIAL PRIMARY KEY,
    natural_key         TEXT UNIQUE NOT NULL,   -- first non-blank of student_id | email
    student_id          TEXT,
    full_name           TEXT NOT NULL,
    email               TEXT,
    location            TEXT,
    programme           TEXT,
    cohort              TEXT,
    level_semester      TEXT,
    photo_drive_file_id TEXT,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Sheet changed 2026-09: matric/timestamp columns are gone; location,
-- programme, cohort and level-semester were added.
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS location TEXT,
    ADD COLUMN IF NOT EXISTS programme TEXT,
    ADD COLUMN IF NOT EXISTS cohort TEXT,
    ADD COLUMN IF NOT EXISTS level_semester TEXT,
    DROP COLUMN IF EXISTS matric,
    DROP COLUMN IF EXISTS row_ts;
CREATE INDEX IF NOT EXISTS students_photo_idx ON students (photo_drive_file_id);
CREATE INDEX IF NOT EXISTS students_name_trgm ON students USING gin (full_name gin_trgm_ops);

-- Append-only audit trail. `details` carries ids/counts only — never names,
-- emails, or free text (the audit log must not become a second PII store).
CREATE TABLE IF NOT EXISTS audit_log (
    id       BIGSERIAL PRIMARY KEY,
    ts       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    target   TEXT,
    details  JSONB
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log (actor);

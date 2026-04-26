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

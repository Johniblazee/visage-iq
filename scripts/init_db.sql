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

"""Gallery search shared by the API (/match, /match-many) and the video worker.

Importable without the FastAPI app (no fastapi/slowapi imports).
"""
from psycopg import sql as pgsql

from backend import scoring
from backend.config import settings
from backend.db import pool
from backend.embedding import EmbeddingResult
from backend.schemas import Candidate, StudentRef, Verdict

_STUDENT_JOIN = (
    "LEFT JOIN LATERAL (SELECT full_name, student_id, location, programme "
    "                   FROM students st WHERE st.photo_drive_file_id = p.drive_file_id "
    "                   ORDER BY st.id LIMIT 1) s ON TRUE "
)

_PRIMARY_SEARCH_SQL = (
    "SELECT p.drive_file_id, p.drive_file_name, "
    "       1 - (p.face_embedding <=> %s) AS similarity, "
    "       s.full_name, s.student_id, s.location, s.programme "
    "FROM persons p "
    + _STUDENT_JOIN +
    "ORDER BY p.face_embedding <=> %s "
    "LIMIT %s"
)

# Compare-model search. The model name is inlined as a literal (validated
# against the COMPARE_MODELS allowlist first) so the planner can match the
# per-model partial HNSW index — a bind parameter would force a full scan.
_ALT_SEARCH_SQL = pgsql.SQL(
    "SELECT p.drive_file_id, p.drive_file_name, "
    "       1 - (a.embedding <=> %s) AS similarity, "
    "       s.full_name, s.student_id, s.location, s.programme "
    "FROM alt_embeddings a "
    "JOIN persons p ON p.drive_file_id = a.drive_file_id "
    + _STUDENT_JOIN +
    "WHERE a.model = {} "
    "ORDER BY a.embedding <=> %s "
    "LIMIT %s"
)


def verdict(similarity: float, match_t: float, review_t: float) -> Verdict:
    if similarity >= match_t:
        return "MATCH"
    if similarity >= review_t:
        return "REVIEW"
    return "NO_MATCH"


def search(
    result: EmbeddingResult, top_k: int, model: str, match_t: float, review_t: float
) -> list[Candidate]:
    emb = result.embedding
    with pool.connection() as conn, conn.cursor() as cur:
        if model == settings.insightface_model:
            cur.execute(_PRIMARY_SEARCH_SQL, (emb, emb, top_k))
        else:
            cur.execute(_ALT_SEARCH_SQL.format(pgsql.Literal(model)), (emb, emb, top_k))
        rows = cur.fetchall()
    out: list[Candidate] = []
    for file_id, title, sim, s_name, s_sid, s_loc, s_prog in rows:
        sim_f = float(sim)
        out.append(
            Candidate(
                drive_file_id=file_id,
                title=title,
                similarity=sim_f,
                confidence_pct=scoring.confidence_pct(sim_f),
                verdict=verdict(sim_f, match_t, review_t),
                student=StudentRef(
                    full_name=s_name, student_id=s_sid, location=s_loc, programme=s_prog
                ) if s_name else None,
            )
        )
    return out

"""Aggregate queries for the analytics page.

Reads from the `file_status` table (latest-state per Drive file) and
`persons` (the actual vector store).
"""
from __future__ import annotations

from typing import Any

from backend.db import pool

OUTCOME_SQL = "SELECT outcome, COUNT(*) FROM file_status GROUP BY outcome"
EXT_SQL = "SELECT COALESCE(ext, '(none)') AS ext, COUNT(*) FROM file_status GROUP BY ext"
OUTCOME_EXT_SQL = (
    "SELECT outcome, COALESCE(ext, '(none)') AS ext, COUNT(*) "
    "FROM file_status GROUP BY outcome, ext ORDER BY outcome, COUNT(*) DESC"
)
TOTALS_SQL_FILES = "SELECT COUNT(*) FROM file_status"
TOTALS_SQL_PERSONS = "SELECT COUNT(*) FROM persons"


def summary() -> dict[str, Any]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(OUTCOME_SQL)
        by_outcome = {row[0]: int(row[1]) for row in cur.fetchall()}

        cur.execute(EXT_SQL)
        by_ext = {row[0]: int(row[1]) for row in cur.fetchall()}

        cur.execute(OUTCOME_EXT_SQL)
        by_outcome_and_ext = [
            {"outcome": row[0], "ext": row[1], "count": int(row[2])}
            for row in cur.fetchall()
        ]

        cur.execute(TOTALS_SQL_FILES)
        files_total = int((cur.fetchone() or [0])[0])
        cur.execute(TOTALS_SQL_PERSONS)
        persons_total = int((cur.fetchone() or [0])[0])

    return {
        "by_outcome": by_outcome,
        "by_ext": by_ext,
        "by_outcome_and_ext": by_outcome_and_ext,
        "totals": {"file_status_total": files_total, "persons_total": persons_total},
    }


def files_page(
    outcome: str | None = None,
    ext: str | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    where: list[str] = []
    params: list[Any] = []
    if outcome:
        where.append("outcome = %s")
        params.append(outcome)
    if ext:
        where.append("ext = %s")
        params.append(ext.lower())
    if q:
        where.append("drive_file_name ILIKE %s")
        params.append(f"%{q}%")
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    count_sql = f"SELECT COUNT(*) FROM file_status {where_sql}"
    page_sql = (
        "SELECT drive_file_id, drive_file_name, mime_type, ext, outcome, "
        "       reason, rotation, det_score, last_seen_at "
        f"FROM file_status {where_sql} "
        "ORDER BY last_seen_at DESC, drive_file_name "
        "LIMIT %s OFFSET %s"
    )

    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(count_sql, params)
        total = int((cur.fetchone() or [0])[0])
        cur.execute(page_sql, [*params, limit, offset])
        rows = [
            {
                "drive_file_id": r[0],
                "drive_file_name": r[1],
                "mime_type": r[2],
                "ext": r[3],
                "outcome": r[4],
                "reason": r[5],
                "rotation": r[6],
                "det_score": float(r[7]) if r[7] is not None else None,
                "last_seen_at": r[8].isoformat() if r[8] else None,
            }
            for r in cur.fetchall()
        ]

    return {"rows": rows, "total": total, "limit": limit, "offset": offset}

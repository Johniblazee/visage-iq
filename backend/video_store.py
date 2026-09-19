"""SQL for video jobs and sightings. The api creates jobs, reads them and
reconciles dead ones; worker-video updates status and writes results.
Never touches persons."""
import uuid
from typing import Any

from backend.db import pool

JOB_COLS = ("id, actor, filename, size_bytes, upload_path, status, error, detail, duration_s, fps, "
            "width, height, sampled_frames, faces_seen, unknown_faces, match_threshold, "
            "review_threshold, created_at, started_at, finished_at")
# Reads also carry how many students the job put on the roll (Recent videos shows it).
_READ_COLS = JOB_COLS + ", (SELECT count(*) FROM video_sightings vs WHERE vs.job_id = video_jobs.id)"
_KEYS = [c.strip() for c in JOB_COLS.split(",")] + ["students"]


def _job(r) -> dict[str, Any]:
    d = dict(zip(_KEYS, r))
    d["id"] = str(d["id"])
    for k in ("created_at", "started_at", "finished_at"):
        d[k] = d[k].isoformat() if d[k] else None
    return d


def create_job(job_id: str, actor: str, filename: str, size_bytes: int, upload_path: str,
               info, match_t: float, review_t: float) -> None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO video_jobs (id, actor, filename, size_bytes, upload_path, status,
                                       duration_s, fps, width, height, match_threshold, review_threshold)
               VALUES (%s, %s, %s, %s, %s, 'queued', %s, %s, %s, %s, %s, %s)""",
            (uuid.UUID(job_id), actor, filename, size_bytes, upload_path,
             info.duration_s, info.fps, info.width, info.height, match_t, review_t),
        )
        conn.commit()


def set_status(job_id: str, status: str, *, error: str | None = None, detail: str | None = None) -> None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE video_jobs SET status = %s, error = %s, detail = %s,
                   started_at = CASE WHEN %s = 'running' THEN NOW() ELSE started_at END,
                   finished_at = CASE WHEN %s IN ('done', 'failed') THEN NOW() ELSE finished_at END,
                   upload_path = CASE WHEN %s IN ('done', 'failed') THEN NULL ELSE upload_path END
               WHERE id = %s""",
            (status, error, detail, status, status, status, uuid.UUID(job_id)),
        )
        conn.commit()


def write_results(job_id: str, sampled_frames: int, faces_seen: int, unknown_faces: int, sightings,
                  unknowns=()) -> None:
    jid = uuid.UUID(job_id)
    with pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO video_sightings (job_id, drive_file_id, best_similarity, best_ts, first_ts,
                                            last_ts, frames_seen, timestamps, frame_jpeg, crop_jpeg,
                                            det_score, face_px)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (job_id, drive_file_id) DO UPDATE SET
                   best_similarity = EXCLUDED.best_similarity, best_ts = EXCLUDED.best_ts,
                   first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts,
                   frames_seen = EXCLUDED.frames_seen, timestamps = EXCLUDED.timestamps,
                   frame_jpeg = EXCLUDED.frame_jpeg, crop_jpeg = EXCLUDED.crop_jpeg,
                   det_score = EXCLUDED.det_score, face_px = EXCLUDED.face_px""",
            [(jid, s.drive_file_id, s.best_similarity, s.best_ts, s.first_ts, s.last_ts,
              s.frames_seen, s.timestamps, s.frame_jpeg, s.crop_jpeg, s.det_score, s.face_px) for s in sightings],
        )
        cur.execute("DELETE FROM video_unknowns WHERE job_id = %s", (jid,))  # a re-run replaces them
        cur.executemany(
            """INSERT INTO video_unknowns (job_id, idx, reason, near_file_id, best_similarity, det_score, face_px,
                                           best_ts, first_ts, last_ts, frames_seen, timestamps, frame_jpeg, crop_jpeg)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [(jid, u.idx, u.reason, u.near_file_id, u.best_similarity, u.det_score, u.face_px, u.best_ts,
              u.first_ts, u.last_ts, u.frames_seen, u.timestamps, u.frame_jpeg, u.crop_jpeg) for u in unknowns],
        )
        cur.execute(
            """UPDATE video_jobs SET status = 'done', sampled_frames = %s, faces_seen = %s,
                   unknown_faces = %s, finished_at = NOW(), upload_path = NULL WHERE id = %s""",
            (sampled_frames, faces_seen, unknown_faces, jid),
        )
        conn.commit()


def get_job(job_id: str) -> dict[str, Any] | None:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {_READ_COLS} FROM video_jobs WHERE id = %s", (uuid.UUID(job_id),))
        r = cur.fetchone()
    return _job(r) if r else None


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {_READ_COLS} FROM video_jobs ORDER BY created_at DESC LIMIT %s", (limit,))
        return [_job(r) for r in cur.fetchall()]


def results(job_id: str) -> list[dict[str, Any]]:
    """Sightings joined to the enrolled photo name and the student record —
    evidence bytes are served by evidence(), not here."""
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT v.drive_file_id, p.drive_file_name, v.best_similarity, v.best_ts, v.first_ts,
                      v.last_ts, v.frames_seen, v.timestamps,
                      s.full_name, s.student_id, s.location, s.programme, v.det_score, v.face_px
               FROM video_sightings v
               LEFT JOIN persons p ON p.drive_file_id = v.drive_file_id
               LEFT JOIN LATERAL (SELECT full_name, student_id, location, programme FROM students st
                                  WHERE st.photo_drive_file_id = v.drive_file_id ORDER BY st.id LIMIT 1) s ON TRUE
               WHERE v.job_id = %s ORDER BY v.best_similarity DESC""",
            (uuid.UUID(job_id),),
        )
        rows = cur.fetchall()
    return [
        {"drive_file_id": r[0], "title": r[1], "best_similarity": float(r[2]), "best_ts": float(r[3]),
         "first_ts": float(r[4]), "last_ts": float(r[5]), "frames_seen": r[6],
         "timestamps": [float(t) for t in r[7]],
         "student": {"full_name": r[8], "student_id": r[9], "location": r[10], "programme": r[11]} if r[8] else None,
         "det_score": float(r[12]) if r[12] is not None else None, "face_px": r[13]}   # null on jobs from before
        for r in rows
    ]


SCORED_REASON = "low"   # the only unidentified faces whose similarity means anything


def unknowns(job_id: str) -> list[dict[str, Any]]:
    """Unidentified faces, most-seen first. A face that was clear enough to score
    carries its closest enrolled photo (`near`) and similarity; one that was kept
    off the roll for being too unreliable (small, weak, dark, ambiguous) carries
    neither — its nearest neighbour is noise, and naming a student beside a
    stranger's crop is how false identifications happen."""
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT u.idx, u.reason, u.face_px, u.det_score, u.best_similarity, u.best_ts, u.first_ts,
                      u.last_ts, u.frames_seen, u.timestamps, u.near_file_id, p.drive_file_name,
                      s.full_name, s.student_id, s.location, s.programme
               FROM video_unknowns u
               LEFT JOIN persons p ON p.drive_file_id = u.near_file_id
               LEFT JOIN LATERAL (SELECT full_name, student_id, location, programme FROM students st
                                  WHERE st.photo_drive_file_id = u.near_file_id ORDER BY st.id LIMIT 1) s ON TRUE
               WHERE u.job_id = %s ORDER BY u.idx""",
            (uuid.UUID(job_id),),
        )
        rows = cur.fetchall()
    return [
        {"idx": r[0], "reason": r[1], "scored": r[1] == SCORED_REASON, "face_px": r[2], "det_score": float(r[3]),
         "best_similarity": float(r[4]) if r[1] == SCORED_REASON else None,
         "best_ts": float(r[5]), "first_ts": float(r[6]), "last_ts": float(r[7]), "frames_seen": r[8],
         "timestamps": [float(t) for t in r[9]],
         "near": {"drive_file_id": r[10], "title": r[11],
                  "student": {"full_name": r[12], "student_id": r[13], "location": r[14], "programme": r[15]}
                  if r[12] else None} if r[10] and r[1] == SCORED_REASON else None}
        for r in rows
    ]


def unknown_evidence(job_id: str, idx: int, kind: str) -> bytes | None:
    col = {"frame": "frame_jpeg", "crop": "crop_jpeg"}[kind]
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {col} FROM video_unknowns WHERE job_id = %s AND idx = %s", (uuid.UUID(job_id), idx))
        r = cur.fetchone()
    return bytes(r[0]) if r else None


def evidence(job_id: str, drive_file_id: str, kind: str) -> bytes | None:
    col = {"frame": "frame_jpeg", "crop": "crop_jpeg"}[kind]
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {col} FROM video_sightings WHERE job_id = %s AND drive_file_id = %s",
                    (uuid.UUID(job_id), drive_file_id))
        r = cur.fetchone()
    return bytes(r[0]) if r else None


def delete_job(job_id: str) -> bool:
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM video_jobs WHERE id = %s", (uuid.UUID(job_id),))
        n = cur.rowcount
        conn.commit()
    return n > 0

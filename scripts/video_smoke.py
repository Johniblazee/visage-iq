"""Video match smoke test. Run: docker compose -p facial-recognition exec -T worker-video python -m scripts.video_smoke
Synthesises a 3 s clip from an enrolled student's passport photo, runs the
job in-process and asserts that student is on the roll and the upload is gone."""
import os
import sys
import uuid

import cv2
import numpy as np

from backend import video_store
from backend.config import settings
from backend.db import pool
from backend.embedding import _decode
from backend.gdrive import download_bytes
from backend.sync import _ensure_pool_open
from backend.video import probe, run_video_job


def main() -> int:
    _ensure_pool_open()
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""SELECT p.drive_file_id, s.full_name FROM persons p
                       JOIN students s ON s.photo_drive_file_id = p.drive_file_id
                       ORDER BY random() LIMIT 1""")
        fid, name = cur.fetchone()
    photo = _decode(download_bytes(fid))                      # BGR ndarray, EXIF-corrected
    h, w = photo.shape[:2]
    canvas = np.full((720, 1280, 3), 40, dtype=np.uint8)      # dark room, photo pasted centre
    scale = min(600 / h, 900 / w)
    face = cv2.resize(photo, (int(w * scale), int(h * scale)))
    y0, x0 = (720 - face.shape[0]) // 2, (1280 - face.shape[1]) // 2
    canvas[y0:y0 + face.shape[0], x0:x0 + face.shape[1]] = face

    job_id = str(uuid.uuid4())
    os.makedirs(settings.video_upload_dir, exist_ok=True)
    path = os.path.join(settings.video_upload_dir, f"{job_id}.mp4")
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (1280, 720))
    for i in range(75):                                        # 3 s; drift the photo so frames differ
        out.write(np.roll(canvas, i * 2, axis=1))
    out.release()

    try:
        info = probe(path)
        video_store.create_job(job_id, "smoke", "smoke.mp4", os.path.getsize(path), path, info,
                               settings.match_threshold, settings.review_threshold)
        summary = run_video_job(job_id)
        rows = video_store.results(job_id)
        hit = next((r for r in rows if r["drive_file_id"] == fid), None)
        print("summary:", summary)
        print("expected:", name, fid, "| found:",
              hit and {k: hit[k] for k in ("best_similarity", "frames_seen", "first_ts", "last_ts")})
        ok = hit is not None and hit["frames_seen"] >= summary["sampled_frames"] - 2 and not os.path.exists(path)
        ok = ok and all(video_store.evidence(job_id, fid, k)[:2] == b"\xff\xd8" for k in ("frame", "crop"))
    finally:
        video_store.delete_job(job_id)  # never leave a smoke row or its evidence behind
        try:
            os.remove(path)  # only reached if probe/create_job failed before the job's own cleanup
        except FileNotFoundError:
            pass
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

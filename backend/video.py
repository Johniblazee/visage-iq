"""Video match: sample an uploaded clip, match every face against the gallery,
keep per-student evidence. Runs on the `video` RQ queue (worker-video).

Hard rules (docs/superpowers/specs/2026-09-17-video-match-design.md): frames
stay in memory, nothing is written to the enrolled index, the upload is
deleted when the job ends.
"""
import logging
import os
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

logger = logging.getLogger(__name__)

FRAME_MAX_SIDE = 1280   # evidence frame, longest side
CROP_SIDE = 256         # evidence face crop, longest side
CROP_PAD = 0.30         # padding around the bbox as a fraction of its size
BOX_BGR = (170, 218, 92)  # --miva-thrive #5CDAAA, the same green Face search draws its box in
ORPHAN_MAX_AGE_S = 24 * 3600
UNKNOWN_MERGE_T = 0.45  # cosine between two unidentified faces to treat them as the same person
MAX_UNKNOWNS = 60       # unidentified faces kept with evidence per job; beyond that they are only counted
DARK_LUMA = 60          # mean grey level of the face box below which low light is the likely cause


class VideoError(Exception):
    """Human-readable; becomes the upload/job error message."""


@dataclass
class VideoInfo:
    fps: float
    frame_count: int
    duration_s: float
    width: int
    height: int


def probe(path: str) -> VideoInfo:
    """Open with OpenCV's bundled ffmpeg and read one frame; anything that
    fails here is rejected before a job is queued."""
    if not os.path.exists(path):
        raise VideoError("Upload expired before it was processed — please upload again.")
    cap = cv2.VideoCapture(path)
    try:
        ok, _ = cap.read()
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()
    if not ok or fps <= 0 or frames <= 0 or width <= 0 or height <= 0:
        raise VideoError("Couldn't decode this video — export it as MP4 (H.264) and try again.")
    return VideoInfo(fps=fps, frame_count=frames, duration_s=frames / fps, width=width, height=height)


def sample_indices(frame_count: int, fps: float, sample_fps: float) -> list[int]:
    """Frame indices to analyse: one every fps/sample_fps frames (never denser
    than every frame), always starting at 0."""
    if frame_count <= 0:
        return []
    step = max(1, int(round(fps / sample_fps))) if sample_fps > 0 else 1
    return list(range(0, frame_count, step))


def iter_frames(path: str, indices: list[int]):
    """Yield (index, ts_seconds, frame_bgr) for the requested indices using a
    sequential grab/retrieve — seeking in long-GOP CCTV files is slow and
    inexact; decoding only the wanted frames keeps it linear and cheap."""
    if not indices:
        return
    wanted, last = set(indices), max(indices)
    cap = cv2.VideoCapture(path)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    try:
        i = 0
        while i <= last and cap.grab():
            if i in wanted:
                ok, frame = cap.retrieve()
                if ok:
                    yield i, i / fps, frame
            i += 1
    finally:
        cap.release()


def _jpeg(img: np.ndarray, quality: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise VideoError("Couldn't encode an evidence frame")
    return buf.tobytes()


def _fit(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1:
        return img
    return cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)


def encode_evidence(frame: np.ndarray, bbox: list[int]) -> tuple[bytes, bytes]:
    """(full frame with the face box drawn, padded face crop) as JPEG bytes."""
    x1, y1, x2, y2 = bbox
    h, w = frame.shape[:2]
    boxed = frame.copy()
    cv2.rectangle(boxed, (x1, y1), (x2, y2), BOX_BGR, 3)
    pad_x, pad_y = int((x2 - x1) * CROP_PAD), int((y2 - y1) * CROP_PAD)
    crop = frame[max(0, y1 - pad_y):min(h, y2 + pad_y), max(0, x1 - pad_x):min(w, x2 + pad_x)]
    if crop.size == 0:
        crop = frame
    return _jpeg(_fit(boxed, FRAME_MAX_SIDE), 80), _jpeg(_fit(crop, CROP_SIDE), 85)


@dataclass
class Hit:
    bbox: list[int]
    det_score: float
    drive_file_id: str | None      # None = unidentified, see `reason`
    similarity: float              # to the closest enrolled photo, identified or not
    near_file_id: str | None = None        # that closest photo — shown beside an unidentified face
    # Why it stayed off the roll. "low" = a clear face that is simply not close to anyone: its
    # score is meaningful. small | weak | dark | ambiguous = the view was too unreliable to score.
    reason: str = ""
    embedding: np.ndarray | None = None    # groups unidentified faces in memory; never stored


@dataclass
class Sighting:
    drive_file_id: str
    best_similarity: float
    best_ts: float
    first_ts: float
    last_ts: float
    frames_seen: int
    timestamps: list[float] = field(default_factory=list)
    frame_jpeg: bytes = b""
    crop_jpeg: bytes = b""
    det_score: float = 0.0      # of the face in the evidence frame (the one with the box)
    face_px: int = 0


@dataclass
class Unknown:
    """One unidentified person: faces grouped across frames by embedding similarity."""
    idx: int
    reason: str
    near_file_id: str | None
    best_similarity: float
    det_score: float
    face_px: int
    best_ts: float
    first_ts: float
    last_ts: float
    frames_seen: int
    timestamps: list[float] = field(default_factory=list)
    frame_jpeg: bytes = b""
    crop_jpeg: bytes = b""
    emb_sum: np.ndarray | None = None      # sum of the group's unit embeddings; memory only


class Aggregator:
    """Per-enrolled-photo roll, plus the unidentified faces grouped per person.
    Evidence is re-encoded only when it improves, so memory stays ~150 KB per
    student (or unidentified face) regardless of clip length."""

    def __init__(self) -> None:
        self._by_id: dict[str, Sighting] = {}
        self._unknowns: list[Unknown] = []
        self.unknown_faces = 0

    def add(self, ts: float, hit: Hit, frame: np.ndarray) -> None:
        if hit.drive_file_id is None:
            self.unknown_faces += 1
            self._add_unknown(ts, hit, frame)
            return
        s = self._by_id.get(hit.drive_file_id)
        if s is None:
            frame_jpeg, crop_jpeg = encode_evidence(frame, hit.bbox)
            self._by_id[hit.drive_file_id] = Sighting(
                drive_file_id=hit.drive_file_id, best_similarity=hit.similarity, best_ts=ts,
                first_ts=ts, last_ts=ts, frames_seen=1, timestamps=[ts],
                frame_jpeg=frame_jpeg, crop_jpeg=crop_jpeg,
                det_score=hit.det_score, face_px=_short_side(hit.bbox),
            )
            return
        # frames_seen counts frames, not faces: a second face in the same frame
        # resolving to the same id is not a new sighting (timestamps arrive in order).
        if ts != s.timestamps[-1]:
            s.frames_seen += 1
            s.timestamps.append(ts)
            s.first_ts, s.last_ts = min(s.first_ts, ts), max(s.last_ts, ts)
        if hit.similarity > s.best_similarity:
            s.best_similarity, s.best_ts = hit.similarity, ts
            s.det_score, s.face_px = hit.det_score, _short_side(hit.bbox)
            s.frame_jpeg, s.crop_jpeg = encode_evidence(frame, hit.bbox)

    def sightings(self) -> list[Sighting]:
        return sorted(self._by_id.values(), key=lambda s: -s.best_similarity)

    def _add_unknown(self, ts: float, hit: Hit, frame: np.ndarray) -> None:
        if hit.embedding is None:
            return
        emb = hit.embedding

        def cos(u: Unknown) -> float:
            return float(u.emb_sum @ emb / np.linalg.norm(u.emb_sum))

        u = max(self._unknowns, key=cos, default=None)
        if u is None or cos(u) < UNKNOWN_MERGE_T:
            # ponytail: first-come cap. A crowd clip keeps evidence for the first
            # MAX_UNKNOWNS people; later ones are still counted in unknown_faces.
            if len(self._unknowns) >= MAX_UNKNOWNS:
                return
            frame_jpeg, crop_jpeg = encode_evidence(frame, hit.bbox)
            self._unknowns.append(Unknown(
                idx=len(self._unknowns), reason=hit.reason, near_file_id=hit.near_file_id,
                best_similarity=hit.similarity, det_score=hit.det_score, face_px=_short_side(hit.bbox),
                best_ts=ts, first_ts=ts, last_ts=ts, frames_seen=1, timestamps=[ts],
                frame_jpeg=frame_jpeg, crop_jpeg=crop_jpeg, emb_sum=emb.astype(np.float32).copy(),
            ))
            return
        u.emb_sum = u.emb_sum + emb
        if ts != u.timestamps[-1]:
            u.frames_seen += 1
            u.timestamps.append(ts)
            u.last_ts = ts
        if hit.similarity > u.best_similarity:
            u.best_similarity, u.near_file_id = hit.similarity, hit.near_file_id
        if hit.det_score > u.det_score:
            # The clearest view becomes the evidence, and its reason explains the verdict:
            # "even at its best, this face was small / turned away / not close to anyone".
            u.det_score, u.face_px, u.reason, u.best_ts = hit.det_score, _short_side(hit.bbox), hit.reason, ts
            u.frame_jpeg, u.crop_jpeg = encode_evidence(frame, hit.bbox)

    def unknowns(self) -> list[Unknown]:
        """Most-seen first, then clearest; idx is that rank (the UI numbers faces by it).
        Not by score: for most of these faces the score is exactly what cannot be trusted."""
        out = sorted(self._unknowns, key=lambda u: (-u.frames_seen, -u.det_score))
        for i, u in enumerate(out):
            u.idx = i
        return out


def _short_side(bbox: list[int]) -> int:
    x1, y1, x2, y2 = bbox
    return int(min(x2 - x1, y2 - y1))


def sweep_orphans(upload_dir: str, max_age_s: int = ORPHAN_MAX_AGE_S) -> int:
    """Remove uploads left behind by a killed worker (older than a day)."""
    # ponytail: mtime-only. A worker outage longer than a day sweeps still-queued
    # uploads too; those jobs then fail with the "upload expired" message.
    removed = 0
    try:
        names = os.listdir(upload_dir)
    except FileNotFoundError:
        return 0
    for name in names:
        p = os.path.join(upload_dir, name)
        try:
            if os.path.isfile(p) and time.time() - os.path.getmtime(p) > max_age_s:
                os.remove(p)
                removed += 1
        except FileNotFoundError:
            continue
    return removed


def match_frame(frame: np.ndarray, min_face_px: int, match_t: float, review_t: float, model: str,
                min_det_score: float = 0.0, min_margin: float = 0.0) -> list[Hit]:
    """The shared per-frame core (live webcam in v2 feeds it too): detect, search
    the gallery, and decide per face whether it goes on the roll. A face that
    does not is still returned — unidentified, with the reason and its closest
    enrolled photo — so the operator can see what was found. Read-only against
    the gallery."""
    from backend.embedding import embed_frame
    from backend.gallery import search

    hits: list[Hit] = []
    for face in embed_frame(frame, model=model):
        # top-3 so one duplicate photo of the same student still leaves a rival to compare against
        cands = search(face, 3, model, match_t, review_t)
        top = cands[0] if cands else None
        rival = next((c for c in cands[1:] if not _same_student(c, top)), None)
        if _short_side(face.bbox) < min_face_px:
            reason = "small"       # upscaled several times into the 112 px recognizer: the score is noise
        elif face.det_score < min_det_score:
            reason = "weak"        # tops of heads, turned-away or half-hidden faces
        elif top is None or top.similarity < review_t:
            reason = "low"
        elif rival is not None and top.similarity - rival.similarity < min_margin:
            reason = "ambiguous"   # a junk embedding sits equally far from everyone
        else:
            reason = ""
        if reason == "weak" and _is_dark(frame, face.bbox):
            reason = "dark"
        hits.append(Hit(face.bbox, face.det_score, top.drive_file_id if top and not reason else None,
                        top.similarity if top else 0.0, near_file_id=top.drive_file_id if top else None,
                        reason=reason, embedding=face.embedding if reason else None))
    return hits


def _is_dark(frame: np.ndarray, bbox: list[int]) -> bool:
    x1, y1, x2, y2 = (max(0, v) for v in bbox)
    box = frame[y1:y2, x1:x2]
    return box.size > 0 and float(cv2.cvtColor(box, cv2.COLOR_BGR2GRAY).mean()) < DARK_LUMA


def _same_student(a, b) -> bool:
    return bool(a.student and b.student and a.student.student_id
                and a.student.student_id == b.student.student_id)


def _progress(job, phase: str, current: int, total: int, faces_seen: int) -> None:
    if job is None:
        return
    job.meta["progress"] = {"phase": phase, "current": current, "total": total, "faces_seen": faces_seen}
    try:
        job.save_meta()
    except Exception:
        logger.debug("progress save failed", exc_info=True)


def run_video_job(job_id: str) -> dict:
    """RQ entrypoint on queue `video`. The upload is removed in `finally`
    whatever happens; results land in one transaction."""
    from backend import video_store
    from backend.config import settings
    from backend.sync import _current_job, _ensure_pool_open

    _ensure_pool_open()
    sweep_orphans(settings.video_upload_dir)
    job = _current_job()
    row = video_store.get_job(job_id)
    if row is None or not row["upload_path"]:
        raise VideoError(f"video job {job_id} has no upload to process")
    path = row["upload_path"]
    faces_seen = sampled = 0
    try:
        _progress(job, "probing", 0, 0, 0)
        video_store.set_status(job_id, "running")
        info = probe(path)
        indices = sample_indices(info.frame_count, info.fps, settings.video_sample_fps)
        total = len(indices)
        agg = Aggregator()
        _progress(job, "matching", 0, total, 0)
        for sampled, (_, ts, frame) in enumerate(iter_frames(path, indices), start=1):
            hits = match_frame(frame, settings.video_min_face_px, row["match_threshold"],
                               row["review_threshold"], settings.insightface_model,
                               settings.video_min_det_score, settings.video_min_margin)
            for hit in hits:
                agg.add(ts, hit, frame)
            faces_seen += len(hits)
            if sampled % 25 == 0 or sampled == total:
                _progress(job, "matching", sampled, total, faces_seen)
        _progress(job, "writing", sampled, total, faces_seen)
        sightings, unknowns = agg.sightings(), agg.unknowns()
        video_store.write_results(job_id, sampled, faces_seen, agg.unknown_faces, sightings, unknowns)
        logger.info("[video %s] done: %d frames, %d faces, %d students, %d unidentified faces in %d groups",
                    job_id[:8], sampled, faces_seen, len(sightings), agg.unknown_faces, len(unknowns))
        return {"ok": True, "sampled_frames": sampled, "faces_seen": faces_seen,
                "students": len(sightings), "unknown_faces": agg.unknown_faces, "unknowns": len(unknowns)}
    except VideoError as exc:
        video_store.set_status(job_id, "failed", error=str(exc))
        raise
    except Exception as exc:
        video_store.set_status(job_id, "failed",
                               error="Video processing failed unexpectedly — see the worker-video logs.",
                               detail=str(exc)[:500])
        raise
    finally:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

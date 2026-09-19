import io
import os

import numpy as np
from PIL import Image

from backend.embedding import EmbeddingResult
from backend.schemas import Candidate, StudentRef
from backend.video import Aggregator, Hit, encode_evidence, match_frame, sample_indices, sweep_orphans


def test_sample_indices_spacing_and_bounds():
    idx = sample_indices(frame_count=250, fps=25.0, sample_fps=2.0)
    assert idx[0] == 0
    assert idx == sorted(set(idx))
    assert all(0 <= i < 250 for i in idx)
    assert 19 <= len(idx) <= 21                          # ~2 per second over 10 s
    assert sample_indices(5, 25.0, 2.0) == [0]           # shorter than one interval
    assert sample_indices(0, 25.0, 2.0) == []
    assert len(sample_indices(100, 25.0, 1000.0)) == 100  # never denser than every frame


def test_encode_evidence_is_jpeg_and_capped():
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    frame_jpeg, crop_jpeg = encode_evidence(frame, [800, 200, 1300, 800])
    assert frame_jpeg[:2] == b"\xff\xd8" and crop_jpeg[:2] == b"\xff\xd8"
    with Image.open(io.BytesIO(frame_jpeg)) as im:
        assert max(im.size) == 1280          # 1920 wide -> actually downscaled
    with Image.open(io.BytesIO(crop_jpeg)) as im:
        assert max(im.size) == 256           # padded crop is 800x960 -> downscaled


def _hit(fid, sim):
    return Hit(bbox=[10, 10, 90, 110], det_score=0.9, drive_file_id=fid, similarity=sim)


def test_aggregator_keeps_best_evidence_and_all_timestamps():
    frame = np.zeros((200, 200, 3), dtype=np.uint8)
    frame2 = np.full((200, 200, 3), 200, dtype=np.uint8)
    bbox = [10, 10, 90, 110]
    agg = Aggregator()
    agg.add(1.0, _hit("A", 0.50), frame)
    agg.add(1.5, _hit("A", 0.62), frame2)  # better -> evidence replaced
    agg.add(2.0, _hit("A", 0.55), frame)
    agg.add(2.0, _hit("A", 0.40), frame)   # second face, same frame -> not a new sighting
    agg.add(2.0, _hit(None, 0.20), frame)  # unidentified face
    agg.add(3.0, _hit("B", 0.48), frame)
    s = {x.drive_file_id: x for x in agg.sightings()}
    assert s["A"].best_similarity == 0.62 and s["A"].best_ts == 1.5
    assert s["A"].frame_jpeg == encode_evidence(frame2, bbox)[0]   # evidence from the best hit
    assert s["A"].frame_jpeg != encode_evidence(frame, bbox)[0]
    assert s["A"].first_ts == 1.0 and s["A"].last_ts == 2.0
    assert s["A"].timestamps == [1.0, 1.5, 2.0] and s["A"].frames_seen == 3
    assert s["B"].frames_seen == 1
    assert agg.unknown_faces == 1
    assert [x.drive_file_id for x in agg.sightings()] == ["A", "B"]  # best first


def _face(bbox, det):
    return EmbeddingResult(embedding=np.zeros(512, np.float32), bbox=bbox, det_score=det, face_count=1, rotation=0)


def _cand(fid, sim, sid):
    return Candidate(drive_file_id=fid, title=fid, similarity=sim, confidence_pct=0, verdict="MATCH",
                     student=StudentRef(full_name=fid, student_id=sid))


def test_match_frame_gates(monkeypatch):
    import backend.embedding as emb
    import backend.gallery as gal

    faces = [_face([0, 0, 100, 100], 0.9),   # clear winner
             _face([0, 0, 100, 100], 0.6),   # weak detection
             _face([0, 0, 30, 30], 0.9),     # tiny
             _face([0, 0, 100, 100], 0.9),   # flat neighbours
             _face([0, 0, 100, 100], 0.9),   # duplicate photo of the same student is not a rival
             _face([0, 0, 100, 100], 0.9)]   # nobody close
    galleries = iter([
        [_cand("a", 0.60, "s1"), _cand("b", 0.50, "s2")],
        [_cand("w", 0.70, "s7")],
        [_cand("t", 0.70, "s8")],
        [_cand("c", 0.52, "s3"), _cand("d", 0.50, "s4")],
        [_cand("e", 0.60, "s5"), _cand("e2", 0.59, "s5"), _cand("f", 0.40, "s6")],
        [_cand("z", 0.30, "s9")],
        [_cand("w", 0.70, "s7")],
    ])
    monkeypatch.setattr(emb, "embed_frame", lambda frame, model=None: faces)
    monkeypatch.setattr(gal, "search", lambda *a, **k: next(galleries))

    bright = np.full((200, 200, 3), 200, np.uint8)
    hits = match_frame(bright, 80, 0.5, 0.4, "m", min_det_score=0.7, min_margin=0.05)
    # every detected face comes back; the ones kept off the roll say why and who was closest
    assert [h.drive_file_id for h in hits] == ["a", None, None, None, "e", None]
    assert [h.reason for h in hits] == ["", "weak", "small", "ambiguous", "", "low"]
    assert [h.near_file_id for h in hits] == ["a", "w", "t", "c", "e", "z"]
    assert all((h.embedding is None) == (h.drive_file_id is not None) for h in hits)

    faces[:] = [_face([0, 0, 100, 100], 0.6)]
    dark = match_frame(np.zeros((200, 200, 3), np.uint8), 80, 0.5, 0.4, "m", min_det_score=0.7)
    assert [h.reason for h in dark] == ["dark"]    # a weak detection in a dark box blames the light


def _unit(*v):
    e = np.zeros(512, np.float32)
    e[:len(v)] = v
    return e / np.linalg.norm(e)


def _unk(emb, sim, det=0.8, near="N", reason="low"):
    return Hit(bbox=[10, 10, 90, 110], det_score=det, drive_file_id=None, similarity=sim,
               near_file_id=near, reason=reason, embedding=emb)


def test_aggregator_groups_unidentified_faces(monkeypatch):
    import backend.video as video

    frame = np.zeros((200, 200, 3), dtype=np.uint8)
    frame2 = np.full((200, 200, 3), 200, dtype=np.uint8)
    agg = Aggregator()
    agg.add(1.0, _unk(_unit(1, 0), 0.30, det=0.6, reason="weak"), frame)
    agg.add(1.5, _unk(_unit(0.9, 0.2), 0.36, det=0.9, near="M"), frame2)  # same person, clearer view
    agg.add(2.0, _unk(_unit(0, 1), 0.41), frame)                          # someone else, higher score
    first, second = agg.unknowns()
    assert (first.idx, first.frames_seen, first.timestamps) == (0, 2, [1.0, 1.5])  # most seen first, not top score
    assert (first.best_similarity, first.near_file_id) == (0.36, "M")
    assert (first.reason, first.det_score, first.best_ts) == ("low", 0.9, 1.5)     # from the clearest view
    assert first.frame_jpeg == encode_evidence(frame2, [10, 10, 90, 110])[0]
    assert (second.idx, second.best_similarity, second.frames_seen) == (1, 0.41, 1)
    assert agg.unknown_faces == 3 and agg.sightings() == []

    monkeypatch.setattr(video, "MAX_UNKNOWNS", 2)
    agg.add(3.0, _unk(_unit(0, 0, 1), 0.2), frame)     # a third person, over the cap: counted, not kept
    assert len(agg.unknowns()) == 2 and agg.unknown_faces == 4


def test_sweep_orphans_removes_only_old(tmp_path):
    old, new = tmp_path / "old.mp4", tmp_path / "new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    os.utime(old, (0, 0))
    assert sweep_orphans(str(tmp_path)) == 1
    assert new.exists() and not old.exists()

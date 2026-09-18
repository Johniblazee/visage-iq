import io
import os

import numpy as np
from PIL import Image

from backend.video import Aggregator, Hit, encode_evidence, sample_indices, sweep_orphans


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


def test_sweep_orphans_removes_only_old(tmp_path):
    old, new = tmp_path / "old.mp4", tmp_path / "new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    os.utime(old, (0, 0))
    assert sweep_orphans(str(tmp_path)) == 1
    assert new.exists() and not old.exists()

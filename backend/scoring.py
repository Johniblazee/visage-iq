"""Score normalization for display.

Raw model outputs are not probabilities and never reach 1.0:
  - ArcFace cosine similarity: impostor pairs sit near 0 (p99 = 0.23 over
    31k sampled pairs from this DB), genuine pairs ~0.45-0.80 and virtually
    never above 0.85 except near-duplicate images.
  - SCRFD det_score: floored at det_thresh 0.5, empirical max 0.957 over
    27.9k enrolled photos (median 0.863).

confidence_pct() rescales cosine piecewise-linearly onto one FIXED
0-100 scale: impostor ceiling -> 0%, cosine 0.40 -> 50%, cosine 0.50 -> 75%,
genuine ceiling -> 100%. The anchors are calibration constants (the stock
thresholds), not the live thresholds, so the match/review knobs live on the
same scale as the candidates: default knobs read 75% / 50%, and a candidate
is a match exactly when candidate% >= match knob%.

Display-layer only: the DB, the API's `similarity` field, and the verdict
thresholds all stay in raw cosine. The UIs mirror this mapping client-side
(frontend-test/streamlit_app.py, frontend/src/format.ts) — keep the three
in sync.
"""

IMPOSTOR_CEILING = 0.23  # p99 cosine over 31,125 random different-person pairs
GENUINE_CEILING = 0.85   # practical ArcFace genuine-pair max (non-duplicate)
REVIEW_ANCHOR = 0.40     # cosine that displays as 50% (stock review threshold)
MATCH_ANCHOR = 0.50      # cosine that displays as 75% (stock match threshold)
DET_FLOOR = 0.5          # FaceAnalysis det_thresh — lower scores never surface
DET_CEILING = 0.95       # empirical max det_score over 27,925 enrolled photos


_XS = [IMPOSTOR_CEILING, REVIEW_ANCHOR, MATCH_ANCHOR, GENUINE_CEILING]
_YS = [0.0, 50.0, 75.0, 100.0]


def confidence_pct(similarity: float) -> float:
    """Map raw cosine similarity to a 0-100 display confidence."""
    if similarity <= _XS[0]:
        return 0.0
    for x0, x1, y0, y1 in zip(_XS, _XS[1:], _YS, _YS[1:]):
        if similarity <= x1:
            return round(y0 + (similarity - x0) / (x1 - x0) * (y1 - y0), 1)
    return 100.0


def det_pct(det_score: float) -> float:
    """Map SCRFD det_score to a 0-100 display quality percentage."""
    frac = (det_score - DET_FLOOR) / (DET_CEILING - DET_FLOOR)
    return round(max(0.0, min(1.0, frac)) * 100.0, 1)


if __name__ == "__main__":
    assert confidence_pct(0.0) == 0.0
    assert confidence_pct(0.23) == 0.0
    assert confidence_pct(0.40) == 50.0   # stock review threshold
    assert confidence_pct(0.45) == 62.5
    assert confidence_pct(0.50) == 75.0   # stock match threshold
    assert confidence_pct(0.724) == 91.0
    assert confidence_pct(0.85) == 100.0
    assert confidence_pct(1.0) == 100.0
    assert det_pct(0.4) == 0.0
    assert det_pct(0.5) == 0.0
    assert det_pct(0.863) == 80.7
    assert det_pct(0.95) == 100.0
    assert det_pct(0.99) == 100.0
    print("scoring self-check OK")

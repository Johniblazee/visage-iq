"""Score normalization for display.

Raw model outputs are not probabilities and never reach 1.0:
  - ArcFace cosine similarity: impostor pairs sit near 0 (p99 = 0.23 over
    31k sampled pairs from this DB), genuine pairs ~0.45-0.80 and virtually
    never above 0.85 except near-duplicate images.
  - SCRFD det_score: floored at det_thresh 0.5, empirical max 0.957 over
    27.9k enrolled photos (median 0.863).

confidence_pct() rescales cosine piecewise-linearly so the displayed
percentage aligns with the verdict bands: impostor ceiling -> 0%,
REVIEW threshold -> 50%, MATCH threshold -> 75%, genuine ceiling -> 100%.

Display-layer only: the DB, the API's `similarity` field, and the verdict
thresholds all stay in raw cosine. The UIs mirror this mapping client-side
(frontend-test/streamlit_app.py, frontend/src/components/SearchView.tsx)
so their live threshold sliders stay consistent — keep the three in sync.
"""

IMPOSTOR_CEILING = 0.23  # p99 cosine over 31,125 random different-person pairs
GENUINE_CEILING = 0.85   # practical ArcFace genuine-pair max (non-duplicate)
DET_FLOOR = 0.5          # FaceAnalysis det_thresh — lower scores never surface
DET_CEILING = 0.95       # empirical max det_score over 27,925 enrolled photos


def confidence_pct(similarity: float, review_threshold: float, match_threshold: float) -> float:
    """Map raw cosine similarity to a 0-100 display confidence."""
    xs = [IMPOSTOR_CEILING, review_threshold, match_threshold, GENUINE_CEILING]
    ys = [0.0, 50.0, 75.0, 100.0]
    # Misconfigured thresholds (e.g. review below the impostor ceiling) must
    # degrade gracefully: force strictly increasing anchors.
    for i in range(1, 4):
        xs[i] = max(xs[i], xs[i - 1] + 1e-6)
    if similarity <= xs[0]:
        return 0.0
    for x0, x1, y0, y1 in zip(xs, xs[1:], ys, ys[1:]):
        if similarity <= x1:
            return round(y0 + (similarity - x0) / (x1 - x0) * (y1 - y0), 1)
    return 100.0


def det_pct(det_score: float) -> float:
    """Map SCRFD det_score to a 0-100 display quality percentage."""
    frac = (det_score - DET_FLOOR) / (DET_CEILING - DET_FLOOR)
    return round(max(0.0, min(1.0, frac)) * 100.0, 1)


if __name__ == "__main__":
    assert confidence_pct(0.0, 0.40, 0.50) == 0.0
    assert confidence_pct(0.23, 0.40, 0.50) == 0.0
    assert confidence_pct(0.40, 0.40, 0.50) == 50.0
    assert confidence_pct(0.45, 0.40, 0.50) == 62.5
    assert confidence_pct(0.50, 0.40, 0.50) == 75.0
    assert confidence_pct(0.85, 0.40, 0.50) == 100.0
    assert confidence_pct(1.0, 0.40, 0.50) == 100.0
    # degenerate thresholds: no crash, still monotonic
    vals = [confidence_pct(x / 100, 0.1, 0.1) for x in range(-100, 101)]
    assert vals == sorted(vals)
    assert det_pct(0.4) == 0.0
    assert det_pct(0.5) == 0.0
    assert det_pct(0.863) == 80.7
    assert det_pct(0.95) == 100.0
    assert det_pct(0.99) == 100.0
    print("scoring self-check OK")

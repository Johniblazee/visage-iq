import hashlib
import io
import os
from datetime import datetime, timezone

import pillow_heif
import requests
import streamlit as st
from PIL import Image, ImageDraw, ImageOps

from _shared import render_active_sync_panel

# Register HEIF/HEIC support so PIL.Image.open can decode iPhone photos.
pillow_heif.register_heif_opener()

API_BASE_URL = os.getenv("API_BASE_URL", "http://api:8000")

# We always fetch this many candidates from the API; the UI slider just slices.
# This keeps the top_k slider instantaneous (no re-fetch needed).
FETCH_TOP_K = 20

VERDICT_COLORS = {
    "MATCH": "#16a34a",
    "REVIEW": "#ca8a04",
    "NO_MATCH": "#dc2626",
}


def _verdict(similarity: float, match_t: float, review_t: float) -> str:
    if similarity >= match_t:
        return "MATCH"
    if similarity >= review_t:
        return "REVIEW"
    return "NO_MATCH"


def _draw_bbox(image: Image.Image, bbox: list[int]) -> Image.Image:
    annotated = image.copy()
    draw = ImageDraw.Draw(annotated)
    draw.rectangle(bbox, outline="#22c55e", width=4)
    return annotated


# api uses cv2 clockwise rotations; PIL rotate is CCW. Map api degrees -> PIL angle.
_PIL_ROTATIONS = {0: 0, 90: -90, 180: 180, 270: 90}


def _prepare_query_image(image_bytes: bytes, rotation: int) -> Image.Image:
    """Mirror the api's decode pipeline so the bbox aligns visually:
    EXIF-transpose, then apply the same rotation the api picked.
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    img = ImageOps.exif_transpose(img)
    if rotation:
        img = img.rotate(_PIL_ROTATIONS.get(rotation, 0), expand=True)
    return img


@st.cache_data(ttl=600, show_spinner=False)
def _fetch_candidate_bytes(file_id: str) -> bytes | None:
    """Fetch image bytes from the api server-side and cache them.

    The compose hostname `api` is unreachable from the browser, so we can't
    let the browser fetch /image/{file_id} directly via an <img src=...> tag.
    The Streamlit server (which can resolve `api`) fetches once and embeds.
    """
    try:
        resp = requests.get(f"{API_BASE_URL}/image/{file_id}", timeout=15)
        if resp.status_code == 200:
            return resp.content
    except requests.RequestException:
        return None
    return None


def _render_candidate(idx: int, cand: dict, match_t: float, review_t: float) -> None:
    similarity = cand["similarity"]
    confidence = max(0.0, similarity) * 100.0
    verdict = _verdict(similarity, match_t, review_t)
    color = VERDICT_COLORS.get(verdict, "#64748b")
    with st.container(border=True):
        cols = st.columns([1, 3])
        with cols[0]:
            img_bytes = _fetch_candidate_bytes(cand["drive_file_id"])
            if img_bytes:
                st.image(img_bytes, width=140)
            else:
                st.caption("(thumbnail unavailable)")
        with cols[1]:
            st.markdown(f"**#{idx + 1} — {cand['title']}**")
            st.markdown(f"Confidence: **{confidence:.1f}%**")
            st.progress(max(0.0, min(1.0, similarity)))
            st.markdown(
                f"<span style='background:{color};color:white;padding:2px 10px;"
                f"border-radius:4px;font-weight:600;font-size:0.85em'>"
                f"{verdict}</span>",
                unsafe_allow_html=True,
            )


def _fetch_health() -> dict | None:
    try:
        resp = requests.get(f"{API_BASE_URL}/health", timeout=5)
        if resp.status_code == 200:
            return resp.json()
    except requests.RequestException:
        return None
    return None


def _do_match(image_bytes: bytes, name: str, content_type: str | None, top_k: int):
    return requests.post(
        f"{API_BASE_URL}/match",
        files={"file": (name, image_bytes, content_type or "image/jpeg")},
        params={"top_k": top_k},
        timeout=60,
    )


def _relative_time(iso_ts: str | None) -> str | None:
    if not iso_ts:
        return None
    try:
        ts = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    secs = int((datetime.now(timezone.utc) - ts).total_seconds())
    if secs < 0:
        return "just now"
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def _sidebar_status() -> None:
    with st.sidebar:
        st.subheader("Database")
        health = _fetch_health()
        if health is None:
            st.error("API unreachable")
            return

        enrolled = int(health.get("enrolled_count") or 0)
        drive_total = health.get("drive_total")  # may be None until first sync
        last_sync_iso = health.get("last_sync_finished_at")

        if enrolled == 0 and not drive_total:
            st.warning(
                "**0 photos enrolled.** Click *Sync now* below to import "
                "your Drive folder."
            )
        else:
            cols = st.columns(2)
            cols[0].metric("Enrolled", f"{enrolled:,}")
            if drive_total is not None:
                cols[1].metric("In Drive", f"{int(drive_total):,}")
                if int(drive_total) > 0:
                    pct = 100.0 * enrolled / int(drive_total)
                    st.caption(f"Coverage: **{pct:.1f}%** of Drive folder")
                if int(drive_total) - enrolled > 0:
                    delta = int(drive_total) - enrolled
                    st.caption(
                        f"{delta:,} file(s) in Drive not yet enrolled "
                        "(skipped during last sync — no face / unsupported / Drive error)."
                    )
            else:
                cols[1].metric("In Drive", "—")
                st.caption("Run *Sync now* to populate the Drive total.")

        rel = _relative_time(last_sync_iso)
        if rel:
            st.caption(f"Last sync: **{rel}**")

        st.caption(f"Model: `{health.get('model', '?')}`")


def _sync_section() -> None:
    """Enqueue a sync and return immediately.

    Live progress is rendered by the shared `render_active_sync_panel`
    fragment, which auto-refreshes every 2s and is visible from every page.
    """
    with st.sidebar:
        st.subheader("Drive Sync")
        prune = st.checkbox("Remove rows for files deleted in Drive", value=True)
        if st.button("Sync now"):
            try:
                resp = requests.post(
                    f"{API_BASE_URL}/sync",
                    params={"prune": str(prune).lower()},
                    timeout=10,
                )
            except requests.RequestException as exc:
                st.error(f"Could not reach API: {exc}")
                return
            if resp.status_code != 200:
                try:
                    detail = resp.json().get("detail", resp.text)
                except ValueError:
                    detail = resp.text
                st.error(f"Sync failed ({resp.status_code}): {detail}")
                return
            job_id = resp.json()["job_id"]
            st.success(f"Sync queued: `{job_id[:8]}` — see *Active Sync* panel below.")
            st.rerun()

        with st.expander("Force unlock (advanced)", expanded=False):
            st.caption(
                "Use only when a previous sync was killed mid-flight and "
                "every new attempt logs *already in progress; skipping*. "
                "Releases the Redis lock and clears the active-sync key."
            )
            if st.button("⚠ Force unlock"):
                try:
                    resp = requests.post(
                        f"{API_BASE_URL}/sync/force-unlock", timeout=10
                    )
                except requests.RequestException as exc:
                    st.error(f"Could not reach API: {exc}")
                    return
                if resp.status_code != 200:
                    st.error(f"Force unlock failed ({resp.status_code}): {resp.text}")
                    return
                st.success("Lock cleared. You can click *Sync now* again.")
                st.rerun()


def _threshold_sliders() -> tuple[float, float]:
    with st.sidebar:
        st.subheader("Thresholds")
        match_t = st.slider(
            "Match floor (cosine similarity)",
            min_value=0.0, max_value=1.0,
            value=float(os.getenv("UI_DEFAULT_MATCH", "0.60")),
            step=0.01,
            help="Similarity ≥ this → MATCH",
        )
        review_max = max(0.01, match_t)
        review_default = min(float(os.getenv("UI_DEFAULT_REVIEW", "0.40")), review_max)
        review_t = st.slider(
            "Review floor (cosine similarity)",
            min_value=0.0, max_value=review_max,
            value=review_default, step=0.01,
            help="Similarity ≥ this but < match floor → REVIEW",
        )
    return match_t, review_t


def _run_match_and_cache(top_k: int) -> None:
    with st.spinner("Detecting face and searching..."):
        try:
            resp = _do_match(
                st.session_state["upload_bytes"],
                st.session_state["upload_name"],
                st.session_state.get("upload_type"),
                FETCH_TOP_K,
            )
        except requests.RequestException as exc:
            st.error(f"Could not reach API at {API_BASE_URL}: {exc}")
            st.session_state["match_response"] = None
            return
    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        st.error(f"API error ({resp.status_code}): {detail}")
        st.session_state["match_response"] = None
        return
    st.session_state["match_response"] = resp.json()


def main() -> None:
    st.set_page_config(page_title="VisageIQ", layout="wide")
    st.title("VisageIQ")
    st.caption(
        "Decision-support tool. The human operator makes the final match call — "
        "the similarity score surfaces candidates; it does not decide identity."
    )

    _sidebar_status()
    _sync_section()
    render_active_sync_panel()
    match_t, review_t = _threshold_sliders()
    top_k = st.sidebar.slider("Top K candidates", 1, FETCH_TOP_K, 3)
    st.sidebar.write(f"API: `{API_BASE_URL}`")

    uploaded = st.file_uploader(
        "Upload a portrait, passport, or ID photo",
        type=["jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff", "heic", "heif"],
    )

    # Detect a new upload via content hash; persist across reruns.
    if uploaded is not None:
        b = uploaded.getvalue()
        h = hashlib.sha256(b).hexdigest()
        if st.session_state.get("upload_hash") != h:
            st.session_state["upload_hash"] = h
            st.session_state["upload_bytes"] = b
            st.session_state["upload_name"] = uploaded.name
            st.session_state["upload_type"] = uploaded.type
            st.session_state["match_response"] = None  # invalidate prior result

    has_upload = "upload_bytes" in st.session_state

    # Action row above results
    action_cols = st.columns([1, 1, 1, 4])
    with action_cols[0]:
        retry = st.button(
            "🔁 Search again",
            disabled=not has_upload,
            help="Re-run /match with the current upload",
        )
    with action_cols[1]:
        clear = st.button(
            "✕ Clear",
            disabled=not has_upload,
            help="Forget the current upload and result",
        )

    if clear:
        for key in ("upload_hash", "upload_bytes", "upload_name", "upload_type", "match_response"):
            st.session_state.pop(key, None)
        st.rerun()

    if not has_upload:
        st.info("Upload an image to search the database.")
        return

    # Fetch from API only when we have no cached result, or when user clicks Search again.
    needs_fetch = retry or st.session_state.get("match_response") is None
    if needs_fetch:
        _run_match_and_cache(top_k)

    data = st.session_state.get("match_response")
    if not data:
        return

    left, right = st.columns([1, 1])
    with left:
        st.subheader("Query")
        rotation = data.get("query_rotation", 0)
        img = _prepare_query_image(st.session_state["upload_bytes"], rotation)
        st.image(_draw_bbox(img, data["query_face_bbox"]), width="stretch")
        rotation_note = f" · Rotation applied: {rotation}°" if rotation else ""
        st.caption(
            f"Detection score: {data['query_det_score']:.3f} · "
            f"Faces found: {data['query_face_count']}{rotation_note}"
        )

    with right:
        st.subheader("Top candidates")
        enrolled = data.get("enrolled_count", 0)
        if enrolled == 0:
            st.warning(
                "Database is empty — no photos to compare against. "
                "Run a Drive sync from the sidebar first."
            )
        else:
            st.caption(
                f"Searched against **{enrolled:,}** enrolled photo(s). "
                f"Verdicts use the sliders: MATCH ≥ {match_t:.2f}, "
                f"REVIEW ≥ {review_t:.2f}."
            )

        candidates = data["candidates"][:top_k]
        if candidates:
            top_sim = candidates[0]["similarity"]
            top_pct = max(0.0, top_sim) * 100.0
            top_verdict = _verdict(top_sim, match_t, review_t)
            top_color = VERDICT_COLORS.get(top_verdict, "#64748b")
            st.markdown(
                f"<div style='font-size:1.4em;margin:0.5em 0 0.75em 0;'>"
                f"<strong>Top match: {top_pct:.1f}%</strong>"
                f"&nbsp;&nbsp;<span style='background:{top_color};color:white;"
                f"padding:2px 10px;border-radius:4px;font-weight:600;font-size:0.65em;"
                f"vertical-align:middle'>{top_verdict}</span>"
                f"</div>",
                unsafe_allow_html=True,
            )

        for idx, cand in enumerate(candidates):
            _render_candidate(idx, cand, match_t, review_t)


if __name__ == "__main__":
    main()

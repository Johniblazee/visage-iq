import io
import os
import time

import requests
import streamlit as st
from PIL import Image, ImageDraw

API_BASE_URL = os.getenv("API_BASE_URL", "http://api:8000")

VERDICT_COLORS = {
    "MATCH": "#16a34a",
    "REVIEW": "#ca8a04",
    "NO_MATCH": "#dc2626",
}


def _draw_bbox(image: Image.Image, bbox: list[int]) -> Image.Image:
    annotated = image.copy()
    draw = ImageDraw.Draw(annotated)
    draw.rectangle(bbox, outline="#22c55e", width=4)
    return annotated


def _candidate_image_url(file_id: str) -> str:
    return f"{API_BASE_URL}/image/{file_id}"


def _render_candidate(idx: int, cand: dict) -> None:
    color = VERDICT_COLORS.get(cand["verdict"], "#64748b")
    with st.container(border=True):
        cols = st.columns([1, 3])
        with cols[0]:
            st.image(_candidate_image_url(cand["drive_file_id"]), width=140)
        with cols[1]:
            st.markdown(f"**#{idx + 1} — {cand['title']}**")
            st.markdown(f"Confidence: **{cand['confidence_pct']:.1f}%**")
            similarity = cand["similarity"]
            st.progress(max(0.0, min(1.0, similarity)))
            st.markdown(
                f"<span style='background:{color};color:white;padding:2px 10px;"
                f"border-radius:4px;font-weight:600;font-size:0.85em'>"
                f"{cand['verdict']}</span>",
                unsafe_allow_html=True,
            )


def _poll_sync(job_id: str, max_seconds: int = 300) -> dict:
    deadline = time.time() + max_seconds
    placeholder = st.empty()
    while time.time() < deadline:
        try:
            resp = requests.get(f"{API_BASE_URL}/sync/{job_id}", timeout=10)
        except requests.RequestException as exc:
            placeholder.error(f"Job poll error: {exc}")
            return {"status": "error"}
        if resp.status_code != 200:
            placeholder.error(f"Job poll API error: {resp.status_code}")
            return {"status": "error"}
        data = resp.json()
        placeholder.info(f"Sync status: **{data['status']}**")
        if data["status"] in ("finished", "failed"):
            return data
        time.sleep(2)
    placeholder.warning("Polling timed out.")
    return {"status": "timeout"}


def _sync_section() -> None:
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
            st.success(f"Sync queued: `{job_id}`")
            data = _poll_sync(job_id)
            if data.get("status") == "finished" and data.get("result"):
                st.success(
                    f"Sync done in {data['result']['duration_seconds']:.1f}s — "
                    f"new {data['result']['new']}, updated {data['result']['updated']}, "
                    f"deleted {data['result']['deleted']}"
                )
            elif data.get("status") == "failed":
                st.error(f"Sync failed: {data.get('error')}")


def main() -> None:
    st.set_page_config(page_title="Face Match", layout="wide")
    st.title("Face Match")
    st.caption(
        "Decision-support tool. The human operator makes the final match call — "
        "the similarity score surfaces candidates; it does not decide identity."
    )

    _sync_section()
    top_k = st.sidebar.slider("Top K candidates", 1, 20, 3)
    st.sidebar.write(f"API: `{API_BASE_URL}`")

    uploaded = st.file_uploader(
        "Upload a portrait, passport, or ID photo",
        type=["jpg", "jpeg", "png", "webp", "bmp"],
    )
    if uploaded is None:
        st.info("Upload an image to search the Drive-backed database.")
        return

    image_bytes = uploaded.getvalue()

    with st.spinner("Detecting face and searching..."):
        try:
            resp = requests.post(
                f"{API_BASE_URL}/match",
                files={"file": (uploaded.name, image_bytes, uploaded.type or "image/jpeg")},
                params={"top_k": top_k},
                timeout=60,
            )
        except requests.RequestException as exc:
            st.error(f"Could not reach API at {API_BASE_URL}: {exc}")
            return

    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        st.error(f"API error ({resp.status_code}): {detail}")
        return

    data = resp.json()
    left, right = st.columns([1, 1])
    with left:
        st.subheader("Query")
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        st.image(_draw_bbox(img, data["query_face_bbox"]), width="stretch")
        st.caption(
            f"Detection score: {data['query_det_score']:.3f} · "
            f"Faces found: {data['query_face_count']}"
        )
    with right:
        st.subheader("Top candidates")
        if not data["candidates"]:
            st.warning("No candidates in the database. Run a sync first.")
        for idx, cand in enumerate(data["candidates"]):
            _render_candidate(idx, cand)


if __name__ == "__main__":
    main()

import os
import sys
from pathlib import Path

import pandas as pd
import requests
import streamlit as st

# Ensure the parent `frontend/` directory is on sys.path so the shared
# helpers module is importable when this page is loaded by Streamlit's
# multi-page router.
_FRONTEND_DIR = str(Path(__file__).resolve().parent.parent)
if _FRONTEND_DIR not in sys.path:
    sys.path.insert(0, _FRONTEND_DIR)

from _shared import render_active_sync_panel, render_worker_panel  # noqa: E402

API_BASE_URL = os.getenv("API_BASE_URL", "http://api:8000")

OUTCOME_LABELS = {
    "enrolled": "Enrolled",
    "unchanged": "Unchanged",
    "no_face": "No face detected",
    "invalid_image": "Invalid image",
    "drive_error": "Drive download error",
    "embed_error": "Unexpected embed error",
}

OUTCOME_COLORS = {
    "enrolled": "#16a34a",
    "unchanged": "#3b82f6",
    "no_face": "#ca8a04",
    "invalid_image": "#ea580c",
    "drive_error": "#dc2626",
    "embed_error": "#dc2626",
}


@st.cache_data(ttl=10, show_spinner=False)
def _fetch_summary() -> dict | None:
    try:
        resp = requests.get(f"{API_BASE_URL}/analytics/summary", timeout=15)
        if resp.status_code == 200:
            return resp.json()
    except requests.RequestException:
        return None
    return None


def _fetch_files(outcome: str | None, ext: str | None, q: str | None, limit: int, offset: int) -> dict | None:
    params = {"limit": limit, "offset": offset}
    if outcome:
        params["outcome"] = outcome
    if ext:
        params["ext"] = ext
    if q:
        params["q"] = q
    try:
        resp = requests.get(f"{API_BASE_URL}/analytics/files", params=params, timeout=20)
        if resp.status_code == 200:
            return resp.json()
    except requests.RequestException:
        return None
    return None


def _outcome_table(by_outcome: dict[str, int]) -> pd.DataFrame:
    rows = [
        {"Outcome": OUTCOME_LABELS.get(k, k), "_key": k, "Count": v}
        for k, v in sorted(by_outcome.items(), key=lambda kv: -kv[1])
    ]
    return pd.DataFrame(rows)


def _ext_table(by_ext: dict[str, int]) -> pd.DataFrame:
    rows = [
        {"Extension": k, "Count": v}
        for k, v in sorted(by_ext.items(), key=lambda kv: -kv[1])
    ]
    return pd.DataFrame(rows)


def _matrix_table(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    pivot = df.pivot_table(
        index="ext", columns="outcome", values="count", fill_value=0, aggfunc="sum"
    )
    return pivot.sort_values(by=pivot.columns.tolist(), ascending=False)


def main() -> None:
    st.set_page_config(page_title="VisageIQ — Analytics", layout="wide")
    render_worker_panel()
    render_active_sync_panel()  # sidebar widget; auto-hides if no sync running

    st.title("Sync Analytics")
    st.caption(
        "Per-file outcomes from the most recent sync. Updates every ~10s "
        "(values cached client-side)."
    )

    summary = _fetch_summary()
    if summary is None:
        st.error(f"API unreachable at `{API_BASE_URL}`.")
        return

    totals = summary.get("totals") or {}
    by_outcome: dict[str, int] = summary.get("by_outcome") or {}
    by_ext: dict[str, int] = summary.get("by_ext") or {}

    cols = st.columns(3)
    cols[0].metric("Files seen", f"{totals.get('file_status_total', 0):,}")
    cols[1].metric("Enrolled", f"{totals.get('persons_total', 0):,}")
    skipped = sum(v for k, v in by_outcome.items() if k not in ("enrolled", "unchanged"))
    cols[2].metric("Skipped (any reason)", f"{skipped:,}")

    if not by_outcome:
        st.info("No sync data yet. Run a sync from the home page.")
        return

    st.divider()

    # Outcome breakdown
    left, right = st.columns([1, 1])
    with left:
        st.subheader("By outcome")
        outcome_df = _outcome_table(by_outcome)
        st.dataframe(
            outcome_df[["Outcome", "Count"]],
            hide_index=True,
            width="stretch",
        )
        # Quick color-coded bars
        for _, row in outcome_df.iterrows():
            key = row["_key"]
            label = row["Outcome"]
            count = int(row["Count"])
            color = OUTCOME_COLORS.get(key, "#64748b")
            pct = (count / totals.get("file_status_total", 1)) * 100 if totals.get("file_status_total") else 0
            st.markdown(
                f"<div style='margin:6px 0;'>"
                f"<span style='display:inline-block;width:11em'>{label}</span>"
                f"<span style='display:inline-block;width:6em;text-align:right'><b>{count:,}</b></span>"
                f"<span style='color:#94a3b8'> · {pct:.1f}%</span>"
                f"<div style='margin-top:2px;height:6px;background:#1e293b;border-radius:3px;overflow:hidden'>"
                f"<div style='width:{pct:.2f}%;height:6px;background:{color}'></div>"
                f"</div></div>",
                unsafe_allow_html=True,
            )

    with right:
        st.subheader("By file extension")
        ext_df = _ext_table(by_ext)
        st.dataframe(ext_df, hide_index=True, width="stretch")

    st.divider()

    st.subheader("Outcome × extension")
    matrix = _matrix_table(summary.get("by_outcome_and_ext") or [])
    if matrix.empty:
        st.caption("No data.")
    else:
        st.dataframe(matrix, width="stretch")

    st.divider()

    st.subheader("Browse files")
    filt_cols = st.columns([2, 2, 4, 1.2])
    outcome_options = ["(any)"] + sorted(by_outcome.keys())
    sel_outcome = filt_cols[0].selectbox("Outcome", outcome_options, index=0)
    ext_options = ["(any)"] + sorted(by_ext.keys())
    sel_ext = filt_cols[1].selectbox("Extension", ext_options, index=0)
    sel_q = filt_cols[2].text_input("Filename contains", "")
    page_size = filt_cols[3].selectbox(
        "Per page", [50, 100, 200, 500], index=0,
        help="Rows shown per page below.",
    )

    # Page size in the key so changing it resets pagination naturally.
    page_key = f"analytics_offset:{sel_outcome}:{sel_ext}:{sel_q}:{page_size}"
    offset = int(st.session_state.get(page_key, 0))

    page = _fetch_files(
        outcome=None if sel_outcome == "(any)" else sel_outcome,
        ext=None if sel_ext in ("(any)", "(none)") else sel_ext,
        q=sel_q.strip() or None,
        limit=page_size,
        offset=offset,
    )

    if page is None:
        st.error("Could not fetch file list.")
        return

    total = page.get("total", 0)
    rows = page.get("rows", [])
    st.caption(f"{total:,} match(es). Showing {offset + 1}–{min(offset + page_size, total)}.")

    page_file_ids: list[str] = []
    if rows:
        files_df = pd.DataFrame(rows)
        display_cols = [
            "drive_file_name",
            "ext",
            "outcome",
            "reason",
            "rotation",
            "det_score",
            "last_seen_at",
            "drive_file_id",
        ]
        view = files_df[[c for c in display_cols if c in files_df.columns]].copy()
        # Render NULL / None as blank cells instead of the literal string "None".
        # Round det_score to 3 decimals to keep the column readable.
        if "det_score" in view.columns:
            view["det_score"] = view["det_score"].apply(
                lambda v: f"{v:.3f}" if isinstance(v, (int, float)) else ""
            )
        for col in ("reason", "rotation", "ext", "mime_type"):
            if col in view.columns:
                view[col] = view[col].apply(lambda v: "" if v is None else v)
        page_file_ids = files_df["drive_file_id"].astype(str).tolist() \
            if "drive_file_id" in files_df.columns else []

        # Key embeds the filter+page so changing them resets the selection.
        table_key = f"files_table:{sel_outcome}:{sel_ext}:{sel_q}:{page_size}:{offset}"
        event = st.dataframe(
            view, hide_index=True, width="stretch",
            on_select="rerun", selection_mode="multi-row", key=table_key,
        )
        selected_idxs: list[int] = []
        try:
            selected_idxs = list(event.selection.rows)  # type: ignore[attr-defined]
        except AttributeError:
            selected_idxs = list(
                (st.session_state.get(table_key) or {})
                .get("selection", {})
                .get("rows", [])
            )
        selected_ids = [page_file_ids[i] for i in selected_idxs if 0 <= i < len(page_file_ids)]

        retry_cols = st.columns([1.4, 1.4, 5])
        with retry_cols[0]:
            if st.button(
                f"🔁 Retry selected ({len(selected_ids)})",
                disabled=not selected_ids,
                help="Re-run the embedding pipeline for the rows checked above.",
            ):
                _trigger_retry(selected_ids)
        with retry_cols[1]:
            if st.button(
                f"🔁 Retry all on page ({len(page_file_ids)})",
                disabled=not page_file_ids,
                help="Re-run for every row on this page (after current filters).",
            ):
                _trigger_retry(page_file_ids)

    nav = st.columns([1, 1, 6])
    with nav[0]:
        if st.button("◀ Previous", disabled=offset == 0):
            st.session_state[page_key] = max(0, offset - page_size)
            st.rerun()
    with nav[1]:
        if st.button("Next ▶", disabled=offset + page_size >= total):
            st.session_state[page_key] = offset + page_size
            st.rerun()


def _trigger_retry(file_ids: list[str]) -> None:
    if not file_ids:
        return
    try:
        resp = requests.post(
            f"{API_BASE_URL}/sync/retry",
            json={"file_ids": file_ids},
            timeout=15,
        )
    except requests.RequestException as exc:
        st.error(f"Could not reach API: {exc}")
        return
    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        st.error(f"Retry enqueue failed ({resp.status_code}): {detail}")
        return
    body = resp.json()
    st.success(
        f"Retry queued for {body.get('count', len(file_ids))} file(s) — "
        f"job `{body['job_id'][:8]}`. Watch the *Active Sync* panel."
    )
    st.rerun()


if __name__ == "__main__":
    main()

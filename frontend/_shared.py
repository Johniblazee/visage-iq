"""Shared Streamlit utilities — imported by the home page and the
multi-page entries under `pages/`.

Lives outside `pages/` so Streamlit's auto-discovery does NOT treat it as
a routable page.
"""
from __future__ import annotations

import os

import requests
import streamlit as st

API_BASE_URL = os.getenv("API_BASE_URL", "http://api:8000")


@st.fragment(run_every=2)
def _render_active_sync_fragment() -> None:
    """Inner fragment: writes elements to the *current* container.

    Streamlit forbids `st.sidebar` (or other context managers) inside a
    fragment, so the caller is responsible for opening the sidebar before
    invoking us. See `render_active_sync_panel()` below.
    """
    try:
        h = requests.get(f"{API_BASE_URL}/health", timeout=3).json()
    except Exception:
        return

    job_id = h.get("active_sync_job_id") if isinstance(h, dict) else None
    if not job_id:
        return

    try:
        resp = requests.get(f"{API_BASE_URL}/sync/{job_id}", timeout=5)
        if resp.status_code != 200:
            return
        data = resp.json()
    except Exception:
        return

    status = data.get("status")
    prog = data.get("progress") or {}
    total = int(prog.get("total") or 0)
    current = int(prog.get("current") or 0)

    st.subheader("Active Sync")
    st.caption(f"Job `{job_id[:8]}` · status: **{status}**")
    if total > 0:
        pct = max(0.0, min(1.0, current / total))
        st.progress(
            pct,
            text=f"{current:,} / {total:,} ({pct * 100:.1f}%)",
        )
        skipped = (
            int(prog.get("skipped_no_face", 0))
            + int(prog.get("skipped_invalid", 0))
            + int(prog.get("skipped_drive_error", 0))
        )
        st.caption(
            f"new: **{int(prog.get('new', 0)):,}** · "
            f"updated: **{int(prog.get('updated', 0)):,}** · "
            f"unchanged: **{int(prog.get('unchanged', 0)):,}** · "
            f"skipped: **{skipped:,}**"
        )
    elif status in ("queued", "started"):
        # No total yet (worker hasn't finished listing). Indeterminate state.
        st.caption("listing Drive folder…")


def render_active_sync_panel() -> None:
    """Public entry point — wraps the fragment inside the sidebar context."""
    with st.sidebar:
        _render_active_sync_fragment()

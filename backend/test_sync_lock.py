from contextlib import contextmanager
from types import SimpleNamespace

import pytest

pytest.importorskip("pillow_heif")

from backend import sync  # noqa: E402


def _fake_lock(outcomes):
    """lock_with_heartbeat stand-in: yields the next scripted token (None = held)."""
    it = iter(outcomes)

    @contextmanager
    def lock(name, ttl, refresh_every):
        yield next(it)

    return lock


def test_own_marker_waits_for_dead_holder_lock_to_lapse(monkeypatch):
    calls = []
    job = SimpleNamespace(id="job-new", meta={}, save_meta=lambda: None)
    monkeypatch.setattr(sync, "lock_with_heartbeat", _fake_lock([None, "tok2"]))
    monkeypatch.setattr(sync, "get_active_sync", lambda: "job-new")  # enqueue pointed it at us
    monkeypatch.setattr(sync, "is_job_alive", lambda h: calls.append(("alive?", h)) or True)
    monkeypatch.setattr(sync, "sleep", lambda s: calls.append(("sleep", s)))
    monkeypatch.setattr(sync, "unlock", lambda n: calls.append(("unlock", n)))
    monkeypatch.setattr(sync, "clear_active_sync", lambda: calls.append(("clear",)))

    with sync._acquired_or_recovered("sync", "[t]", job) as token:
        assert token == "tok2"

    assert ("sleep", sync.LOCK_TTL + 1) in calls
    assert not any(c[0] in ("unlock", "clear", "alive?") for c in calls)


def test_live_foreign_holder_still_skips(monkeypatch):
    job = SimpleNamespace(id="job-new", meta={}, save_meta=lambda: None)
    monkeypatch.setattr(sync, "lock_with_heartbeat", _fake_lock([None]))
    monkeypatch.setattr(sync, "get_active_sync", lambda: "job-other")
    monkeypatch.setattr(sync, "is_job_alive", lambda h: True)
    monkeypatch.setattr(sync, "sleep", lambda s: pytest.fail("must not wait on a live holder"))
    monkeypatch.setattr(sync, "clear_active_sync", lambda: None)

    with sync._acquired_or_recovered("sync", "[t]", job) as token:
        assert token is None
    assert job.meta["progress"]["phase"] == "skipped"

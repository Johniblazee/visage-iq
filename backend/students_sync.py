"""Sync the students table from the 'passports' worksheet.
Runs in the worker: after every Drive photo sync, and standalone via
POST /students/sync. Sheet is the source of truth: upsert by natural key,
delete keys that vanished. Empty reads abort (same guard as photo prune)."""
import json
import logging
from datetime import datetime, timezone

from backend.cache import set_students_sync_summary
from backend.config import settings
from backend.db import pool
from backend.sheets import SheetsError, get_columns, get_headers
from backend.students_map import HeaderError, map_rows, resolve_headers

logger = logging.getLogger(__name__)

UPSERT_SQL = """
INSERT INTO students (natural_key, student_id, full_name, email, location,
                      photo_drive_file_id, synced_at)
VALUES (%(natural_key)s, %(student_id)s, %(full_name)s, %(email)s, %(location)s,
        %(photo_drive_file_id)s, NOW())
ON CONFLICT (natural_key) DO UPDATE SET
    student_id = EXCLUDED.student_id,
    full_name = EXCLUDED.full_name,
    email = EXCLUDED.email,
    location = EXCLUDED.location,
    photo_drive_file_id = EXCLUDED.photo_drive_file_id,
    synced_at = NOW()
"""
DELETE_MISSING_SQL = "DELETE FROM students WHERE NOT (natural_key = ANY(%s))"


def _sa_email() -> str:
    try:
        return json.loads(settings.gdrive_sa_json).get("client_email", "the service account")
    except (TypeError, ValueError):
        return "the service account"


def _friendly_error(exc: Exception) -> tuple[str, str | None]:
    """Map raw Sheets/Google failures to a message that names the fix.
    Returns (human message, technical detail)."""
    raw = str(exc)
    if "does not have permission" in raw:
        return (
            f"Google denied access to the spreadsheet. Share the workbook with {_sa_email()} as Viewer.",
            raw,
        )
    if "has not been used" in raw or "it is disabled" in raw:
        return (
            "The Google Sheets API is not enabled on the service account's Google Cloud project.",
            raw,
        )
    if "Requested entity was not found" in raw:
        return ("Spreadsheet not found — check STUDENTS_SHEET_ID against the workbook URL.", raw)
    if "Unable to parse range" in raw:
        return (
            f"Worksheet '{settings.students_worksheet}' was not found in the workbook — "
            "check STUDENTS_WORKSHEET against the tab name.",
            raw,
        )
    return (raw[:300], raw)


def run_students_sync() -> dict:
    started = datetime.now(timezone.utc)
    summary = {"at": started.isoformat(), "ok": False, "rows": 0, "upserted": 0,
               "deleted": 0, "skipped_no_key": 0, "error": None, "detail": None}
    if not settings.students_sheet_id:
        summary["error"] = "The student directory is not configured — set STUDENTS_SHEET_ID in .env."
        _write_summary(summary)
        return summary
    try:
        headers = get_headers(settings.students_sheet_id, settings.students_worksheet)
        cols = resolve_headers(headers)
        data = get_columns(settings.students_sheet_id, settings.students_worksheet, sorted(set(cols.values())))
        length = max((len(v) for v in data.values()), default=0)
        raw_rows = [
            {canon: (data[idx][i] if i < len(data[idx]) else "") for canon, idx in cols.items()}
            for i in range(length)
        ]
        records, skipped = map_rows(raw_rows)
        summary["rows"] = length
        summary["skipped_no_key"] = skipped
        if not records:
            raise SheetsError("sheet read produced 0 usable rows — refusing to wipe the students table")
        with pool.connection() as conn, conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, records)
            cur.execute(DELETE_MISSING_SQL, ([r["natural_key"] for r in records],))
            summary["deleted"] = cur.rowcount
            conn.commit()
        summary["upserted"] = len(records)
        summary["ok"] = True
        logger.info("students sync ok: upserted=%d deleted=%d skipped=%d of %d rows",
                    summary["upserted"], summary["deleted"], skipped, length)
    except HeaderError as exc:
        summary["error"] = str(exc)  # already human: names the missing columns
        logger.error("students sync failed: %s", exc)
    except SheetsError as exc:
        summary["error"], summary["detail"] = _friendly_error(exc)
        logger.error("students sync failed: %s", exc)
    except Exception as exc:  # unexpected — still record, never raise into the photo sync
        summary["error"] = "Student sync failed unexpectedly — see the worker logs."
        summary["detail"] = str(exc)[:500]
        logger.exception("students sync failed unexpectedly")
    _write_summary(summary)
    return summary


def _write_summary(summary: dict) -> None:
    # run_sync_job calls run_students_sync() bare on the "never raises"
    # contract — a Redis blip on the summary write must not fail the photo sync.
    try:
        set_students_sync_summary(summary)
    except Exception:
        logger.exception("failed to write students sync summary")


def run_students_sync_job() -> dict:
    from backend.sync import _ensure_pool_open

    _ensure_pool_open()
    return run_students_sync()

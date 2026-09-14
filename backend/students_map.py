"""Pure mapping from the 'passports' sheet rows to student records.
No I/O here — everything is unit-testable."""
import re

# canonical name -> exact sheet header (headers are stripped before matching)
CANONICAL_HEADERS = {
    "student_id": "Student ID",
    "email": "Student Email",
    "name": "Student Name",
    "photo": "Upload Passport Photograph",
    "location": "Location",
}

_DRIVE_ID = re.compile(r"(?:/d/|[?&]id=)([A-Za-z0-9_-]{10,})")
_BARE_ID = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_WS = re.compile(r"\s+")


class HeaderError(Exception):
    pass


def _clean(value: str | None) -> str:
    return _WS.sub(" ", (value or "").strip())


def parse_drive_id(url: str | None) -> str | None:
    url = _clean(url)
    if not url:
        return None
    m = _DRIVE_ID.search(url)
    if m:
        return m.group(1)
    if _BARE_ID.match(url):
        return url
    return None


def resolve_headers(headers: list[str]) -> dict[str, int]:
    stripped = [h.strip() for h in headers]
    out: dict[str, int] = {}
    missing: list[str] = []
    for canon, header in CANONICAL_HEADERS.items():
        try:
            out[canon] = stripped.index(header)
        except ValueError:
            missing.append(header)
    if missing:
        raise HeaderError("worksheet is missing expected column(s): " + ", ".join(missing))
    return out


def map_rows(rows: list[dict[str, str]]) -> tuple[list[dict], int]:
    """rows: canonical-keyed raw strings. Returns (records, skipped_no_key).
    Dedupe by natural key; the sheet has no timestamp, so the last row wins."""
    by_key: dict[str, dict] = {}
    skipped = 0
    for raw in rows:
        student_id = _clean(raw.get("student_id"))
        email = _clean(raw.get("email"))
        key = student_id or email
        full_name = _clean(raw.get("name"))
        if not key or not full_name:
            skipped += 1
            continue
        by_key[key] = {
            "natural_key": key,
            "student_id": student_id or None,
            "full_name": full_name,
            "email": email or None,
            "location": _clean(raw.get("location")) or None,
            "photo_drive_file_id": parse_drive_id(raw.get("photo")),
        }
    return list(by_key.values()), skipped

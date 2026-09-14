import pytest

from backend.students_map import (
    HeaderError,
    map_rows,
    parse_drive_id,
    resolve_headers,
)

HEADERS = ["Student ID ", "Student Email", "Student Name ", "Upload Passport Photograph", "Location"]


def test_resolve_headers_strips_and_maps():
    assert resolve_headers(HEADERS) == {"student_id": 0, "email": 1, "name": 2, "photo": 3, "location": 4}


def test_resolve_headers_missing_required_raises_named():
    with pytest.raises(HeaderError) as err:
        resolve_headers(["Student ID", "Student Name"])
    assert "Student Email" in str(err.value)
    assert "Location" in str(err.value)


def test_parse_drive_id_variants():
    fid = "1AbC-def_9xyzLMNOPQRSTUVWXyz01234"
    assert parse_drive_id(f"https://drive.google.com/open?id={fid}") == fid
    assert parse_drive_id(f"https://drive.google.com/file/d/{fid}/view") == fid
    assert parse_drive_id(fid) == fid
    assert parse_drive_id("not a link") is None
    assert parse_drive_id("") is None


def _row(**kw):
    base = {"student_id": "30059430", "email": "ada@miva.university", "name": "Ada  Obi",
            "photo": "https://drive.google.com/open?id=1AbC-def_9xyzLMNOPQRSTUVWXyz01234",
            "location": "Abuja "}
    base.update(kw)
    return base


def test_map_rows_normalizes():
    out, skipped = map_rows([_row()])
    assert out == [{
        "natural_key": "30059430",
        "student_id": "30059430",
        "full_name": "Ada Obi",  # whitespace collapsed
        "email": "ada@miva.university",
        "location": "Abuja",
        "photo_drive_file_id": "1AbC-def_9xyzLMNOPQRSTUVWXyz01234",
    }]
    assert skipped == 0


def test_map_rows_key_priority_and_skip():
    out, skipped = map_rows([
        _row(student_id=""),                      # falls to email
        _row(student_id="", email="", name="X"),  # no key -> skipped
        _row(name=""),                            # no name -> skipped
    ])
    assert out[0]["natural_key"] == "ada@miva.university"
    assert len(out) == 1 and skipped == 2


def test_map_rows_dedupe_last_row_wins():
    out, _ = map_rows([_row(name="Old Name"), _row(name="New Name")])
    assert len(out) == 1
    assert out[0]["full_name"] == "New Name"

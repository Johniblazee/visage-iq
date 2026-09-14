import io

import pytest
from PIL import Image

pytest.importorskip("pypdfium2")
pytest.importorskip("insightface")
pytest.importorskip("pillow_heif")

from backend.embedding import _decode, to_display_jpeg  # noqa: E402


def _pdf_of(color, size=(300, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PDF")
    return buf.getvalue()


def test_pdf_rasterizes_for_display_and_decode():
    pdf = _pdf_of((200, 30, 30))
    assert pdf.startswith(b"%PDF-")

    jpeg = to_display_jpeg(pdf, max_side=150)
    with Image.open(io.BytesIO(jpeg)) as im:
        assert im.format == "JPEG"
        assert im.size == (150, 100)  # aspect preserved, longest side capped
        r, g, b = im.resize((1, 1)).getpixel((0, 0))
        assert r > 150 and g < 80 and b < 80

    bgr = _decode(pdf)
    assert bgr.shape[0] < bgr.shape[1] and bgr.shape[2] == 3

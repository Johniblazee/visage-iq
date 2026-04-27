import io
import logging
from dataclasses import dataclass

import cv2
import numpy as np
import pillow_heif
from insightface.app import FaceAnalysis
from PIL import Image, ImageOps, UnidentifiedImageError

from backend.config import settings

# Register HEIF/HEIC support so Pillow's Image.open transparently handles them
# (iPhones default to HEIC; without this they fail to decode).
pillow_heif.register_heif_opener()

logger = logging.getLogger(__name__)


class NoFaceDetected(Exception):
    pass


class InvalidImage(Exception):
    pass


@dataclass
class EmbeddingResult:
    embedding: np.ndarray
    bbox: list[int]
    det_score: float
    face_count: int
    rotation: int  # 0 / 90 / 180 / 270 — degrees applied to find this face


_app: FaceAnalysis | None = None

ROTATIONS = (0, 90, 180, 270)

_ROTATION_OPS = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}


def get_app() -> FaceAnalysis:
    global _app
    if _app is None:
        logger.info(
            "Loading InsightFace model '%s' (providers=%s). "
            "First run downloads weights to ~/.insightface/models/",
            settings.insightface_model,
            settings.providers_list,
        )
        app = FaceAnalysis(
            name=settings.insightface_model,
            providers=settings.providers_list,
        )
        ctx_id = -1 if "CPUExecutionProvider" in settings.providers_list and len(settings.providers_list) == 1 else 0
        app.prepare(ctx_id=ctx_id, det_size=(settings.det_size, settings.det_size))
        _app = app
    return _app


def _decode(image_bytes: bytes) -> np.ndarray:
    """Decode JPG / PNG / WEBP / BMP / GIF / TIFF / HEIC / HEIF -> BGR ndarray.

    Honors EXIF Orientation via Pillow's exif_transpose so phone-shot photos
    arrive upright instead of sideways. Returns a BGR uint8 ndarray, the same
    convention InsightFace expects.
    """
    if not image_bytes:
        raise InvalidImage("Empty image buffer (zero bytes)")
    try:
        with Image.open(io.BytesIO(image_bytes)) as pil:
            pil = ImageOps.exif_transpose(pil).convert("RGB")
            rgb = np.array(pil)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise InvalidImage(f"Could not decode image: {exc}") from exc
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _rotate(img: np.ndarray, deg: int) -> np.ndarray:
    if deg == 0:
        return img
    return cv2.rotate(img, _ROTATION_OPS[deg])


def _largest(faces):
    def area(face) -> float:
        x1, y1, x2, y2 = face.bbox
        return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))

    return max(faces, key=area)


def embed(image_bytes: bytes) -> EmbeddingResult:
    """Detect + embed the largest face, trying 0/90/180/270 rotations.

    The rotation that produces the highest-confidence detection is treated as
    canonical. Both ingestion (sync) and inference (/match) call this, so a
    photo enrolled at rotation R is queried at rotation R later — cosine
    self-similarity for the same photo is preserved.
    """
    base = _decode(image_bytes)
    app = get_app()
    best: tuple[float, int, object, int] | None = None  # (score, deg, face, n_faces)
    early_exit = settings.rotation_early_exit_score
    rotations = ROTATIONS if settings.rotation_enabled else (0,)

    for deg in rotations:
        rotated = _rotate(base, deg)
        faces = app.get(rotated)
        if not faces:
            continue
        face = _largest(faces)
        score = float(face.det_score)
        if best is None or score > best[0]:
            best = (score, deg, face, len(faces))
        # Detector is confident; no need to spend cycles on further rotations.
        if score >= early_exit:
            break

    if best is None:
        msg = (
            "No face detected at any of 0/90/180/270 rotations"
            if settings.rotation_enabled
            else "No face detected (rotation iteration disabled)"
        )
        raise NoFaceDetected(msg)

    score, rotation, face, count = best
    return EmbeddingResult(
        embedding=np.asarray(face.normed_embedding, dtype=np.float32),
        bbox=[int(v) for v in face.bbox],
        det_score=score,
        face_count=count,
        rotation=rotation,
    )

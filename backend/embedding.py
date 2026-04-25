import logging
from dataclasses import dataclass

import cv2
import numpy as np
from insightface.app import FaceAnalysis

from backend.config import settings

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


_app: FaceAnalysis | None = None


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
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise InvalidImage("Could not decode image bytes")
    return img


def embed(image_bytes: bytes) -> EmbeddingResult:
    img = _decode(image_bytes)
    faces = get_app().get(img)
    if not faces:
        raise NoFaceDetected("No face detected in the uploaded image")

    def area(face) -> float:
        x1, y1, x2, y2 = face.bbox
        return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))

    face = max(faces, key=area)
    bbox = [int(v) for v in face.bbox]
    return EmbeddingResult(
        embedding=np.asarray(face.normed_embedding, dtype=np.float32),
        bbox=bbox,
        det_score=float(face.det_score),
        face_count=len(faces),
    )

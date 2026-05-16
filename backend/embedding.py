import faulthandler
import io
import logging
import sys
from dataclasses import dataclass

import cv2
import numpy as np
import pillow_heif
from insightface.app import FaceAnalysis
from PIL import Image, ImageOps, UnidentifiedImageError

from backend.config import settings

# Dump a C-level traceback to stderr on SIGSEGV/SIGABRT/SIGFPE. The InsightFace
# + onnxruntime + CUDA native stack can abort the process (signal 6/11) without
# raising a Python exception — `finally` never runs and the only log line is
# something like "corrupted size vs. prev_size". With faulthandler enabled the
# crashing C frames hit `make logs-worker`, which is the only way to bisect
# which file / op triggered the abort.
faulthandler.enable(file=sys.stderr, all_threads=True)

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
_sync_app: FaceAnalysis | None = None

ROTATIONS = (0, 90, 180, 270)

_ROTATION_OPS = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}


def _load_app(
    *,
    profile: str,
    model_name: str,
    modules: list[str] | None,
    det_size: int,
    providers: list[str],
) -> FaceAnalysis:
    logger.info(
        "Loading InsightFace [%s] model '%s' (providers=%s, modules=%s, det_size=%d). "
        "First run downloads weights to ~/.insightface/models/",
        profile,
        model_name,
        providers,
        modules or "all",
        det_size,
    )
    kwargs: dict = {
        "name": model_name,
        "providers": providers,
    }
    if modules is not None:
        kwargs["allowed_modules"] = modules
    app = FaceAnalysis(**kwargs)
    ctx_id = -1 if "CPUExecutionProvider" in providers and len(providers) == 1 else 0
    app.prepare(ctx_id=ctx_id, det_size=(det_size, det_size))
    return app


def get_app(profile: str = "match") -> FaceAnalysis:
    global _app, _sync_app
    if profile == "sync":
        if _sync_app is None:
            _sync_app = _load_app(
                profile="sync",
                model_name=settings.sync_insightface_model_value,
                modules=settings.sync_insightface_modules_list,
                det_size=settings.sync_det_size_value,
                providers=settings.sync_providers_list,
            )
        return _sync_app

    if _app is None:
        _app = _load_app(
            profile="match",
            model_name=settings.insightface_model,
            modules=settings.insightface_modules_list,
            det_size=settings.det_size,
            providers=settings.providers_list,
        )
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


def embed(image_bytes: bytes, profile: str = "match") -> EmbeddingResult:
    """Detect + embed the largest face, trying 0/90/180/270 rotations.

    The rotation that produces the highest-confidence detection is treated as
    canonical. Both ingestion (sync) and inference (/match) call this, so a
    photo enrolled at rotation R is queried at rotation R later — cosine
    self-similarity for the same photo is preserved.
    """
    base = _decode(image_bytes)
    app = get_app(profile)
    best: tuple[float, int, object, int] | None = None  # (score, deg, face, n_faces)
    if profile == "sync":
        early_exit = settings.sync_rotation_early_exit_score_value
        mode = (settings.sync_rotation_mode_value or "fallback").lower()
        rotation_enabled = settings.sync_rotation_enabled_value
    else:
        early_exit = settings.rotation_early_exit_score
        mode = (settings.rotation_mode or "fallback").lower()
        rotation_enabled = settings.rotation_enabled

    # Resolve the effective rotation mode.
    if not rotation_enabled:
        mode = "off"  # kill-switch wins
    if mode not in ("off", "fallback", "always"):
        mode = "fallback"  # safe default for unknown values

    rotations = (0,) if mode == "off" else ROTATIONS

    for deg in rotations:
        rotated = _rotate(base, deg)
        faces = app.get(rotated)
        if not faces:
            continue  # nothing here; try next rotation (or give up if "off")

        face = _largest(faces)
        score = float(face.det_score)
        if best is None or score > best[0]:
            best = (score, deg, face, len(faces))

        if mode == "fallback":
            # 0° (or whichever first rotation hit) found a face — accept it
            # without spending cycles on the remaining rotations.
            break
        if mode == "always" and score >= early_exit:
            # Detector is confident; no need to keep iterating.
            break

    if best is None:
        if mode == "off":
            msg = "No face detected (rotation mode=off, only 0° tried)"
        elif mode == "fallback":
            msg = "No face detected at 0° or any fallback rotation (90/180/270)"
        else:
            msg = "No face detected at any of 0/90/180/270 rotations"
        raise NoFaceDetected(msg)

    score, rotation, face, count = best
    return EmbeddingResult(
        embedding=np.asarray(face.normed_embedding, dtype=np.float32),
        bbox=[int(v) for v in face.bbox],
        det_score=score,
        face_count=count,
        rotation=rotation,
    )


def _embed_worker_init() -> None:
    """ProcessPoolExecutor initializer — warms InsightFace once per subprocess.

    Without this, every submit() would lazily reload ~300 MB of model weights
    on first call inside that subprocess, defeating the whole point of pooling.
    """
    get_app("sync")


def embed_for_pool(image_bytes: bytes) -> EmbeddingResult:
    """Picklable entry point for ProcessPoolExecutor.submit()."""
    return embed(image_bytes, profile="sync")

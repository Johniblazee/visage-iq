FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --upgrade pip setuptools wheel

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Pre-fetch InsightFace model weights at build time so cold starts skip the ~300MB download.
RUN python -c "from insightface.app import FaceAnalysis; \
    app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider']); \
    app.prepare(ctx_id=-1, det_size=(640, 640))"

COPY backend/ ./backend/
COPY scripts/ ./scripts/

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]

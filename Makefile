# Face Match — developer shortcuts.
# Self-documenting: run `make` (or `make help`) to see every target.
#
# Windows users: run from Git Bash (it ships GNU make via MSYS) or
# install make globally with `choco install make`.

SHELL := /bin/bash

# .env is NOT included by Make — multi-line / quoted values (like GDRIVE_SA_JSON)
# break Make's parser. Instead:
#   * docker compose reads .env via `env_file: .env`
#   * the api / worker / scripts read .env via pydantic-settings
#   * shell-only targets (init-db, etc.) source .env at command time via DOTENV
DOTENV := set -a; [ -f .env ] && . ./.env; set +a;

DATABASE_URL ?= postgresql://postgres:pg@localhost:5432/postgres
REDIS_URL    ?= redis://localhost:6379/0
PORT_API     ?= 8000
PORT_UI      ?= 8501

VENV ?= .venv
PY    = $(VENV)/bin/python
PIP   = $(VENV)/bin/pip

.DEFAULT_GOAL := help
.PHONY: help install env api worker ui sync init-db \
        up down logs logs-api logs-worker logs-ui ps rebuild \
        compose-sync compose-shell psql redis-cli health check clean nuke

help:  ## Show this help
	@echo "Face Match — make targets"
	@echo ""
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# --- Setup -----------------------------------------------------------------

install:  ## Create virtualenv + install Python deps
	python -m venv $(VENV)
	$(PIP) install --upgrade pip setuptools wheel
	$(PIP) install -r requirements.txt
	@echo "Done. Activate with: source $(VENV)/Scripts/activate (Windows) or source $(VENV)/bin/activate (macOS/Linux)"

env:  ## Copy .env.example to .env if missing
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from .env.example."; \
		echo "Edit it and set:"; \
		echo "  GDRIVE_SA_JSON   — paste the full contents of your service-account JSON"; \
		echo "  GDRIVE_FOLDER_ID — the Drive folder id"; \
	else echo ".env already exists"; fi

# --- Local processes (no Docker) -------------------------------------------

api:  ## Run the FastAPI server with autoreload (port 8000)
	uvicorn backend.main:app --reload --host 0.0.0.0 --port $(PORT_API)

worker:  ## Run the RQ worker for the sync queue
	$(DOTENV) rq worker --url $${REDIS_URL:-$(REDIS_URL)} sync

ui:  ## Run the Streamlit UI (port 8501)
	API_BASE_URL=$${API_BASE_URL:-http://localhost:$(PORT_API)} \
		streamlit run frontend/streamlit_app.py \
			--server.address=0.0.0.0 --server.port=$(PORT_UI) \
			--browser.gatherUsageStats=false

sync:  ## Run a foreground Drive→DB sync (no worker required)
	python scripts/enroll.py

init-db:  ## Apply scripts/init_db.sql against $$DATABASE_URL (sources .env)
	$(DOTENV) psql "$${DATABASE_URL:-$(DATABASE_URL)}" -f scripts/init_db.sql

# --- Docker Compose --------------------------------------------------------

up:  ## docker compose up --build -d
	docker compose up --build -d

down:  ## docker compose down
	docker compose down

logs:  ## Tail logs for all compose services
	docker compose logs -f

logs-api:  ## Tail logs for the api container
	docker compose logs -f api

logs-worker:  ## Tail logs for the worker container
	docker compose logs -f worker

logs-ui:  ## Tail logs for the ui container
	docker compose logs -f ui

ps:  ## Show compose service status
	docker compose ps

rebuild:  ## Force-rebuild and recreate all compose services
	docker compose up --build --force-recreate -d

compose-sync:  ## Run a foreground sync inside the api container
	docker compose run --rm api python scripts/enroll.py

compose-shell:  ## Open a bash shell inside the api container
	docker compose exec api bash

# --- Database / Redis ------------------------------------------------------

psql:  ## Open psql against the compose db service
	docker compose exec db psql -U postgres

redis-cli:  ## Open redis-cli against the compose redis service
	docker compose exec redis redis-cli

# --- Health / Verify -------------------------------------------------------

health:  ## Hit the /health endpoint
	curl -sS http://localhost:$(PORT_API)/health | (jq . 2>/dev/null || cat)

check:  ## Byte-compile every Python module to catch syntax errors
	python -m py_compile backend/*.py frontend/*.py scripts/enroll.py
	@echo "Syntax OK"

# --- Cleanup ---------------------------------------------------------------

clean:  ## Remove __pycache__ and *.pyc
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete

nuke:  ## DESTRUCTIVE: docker compose down -v (drops db + redis volumes)
	@echo "About to drop ALL compose volumes (db data + redis data + insightface models)."
	@read -p "Type 'yes' to confirm: " ans && [ "$$ans" = "yes" ] && docker compose down -v

"""Run a Drive sync directly (foreground, no Redis worker required).

Useful for the initial bulk load or for ad-hoc CLI runs from outside the API.

Usage:
    python scripts/enroll.py [--no-prune]
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db import pool  # noqa: E402
from backend.sync import run_sync  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger("enroll")


def main() -> None:
    ap = argparse.ArgumentParser(description="Sync the configured Drive folder into the DB.")
    ap.add_argument("--no-prune", action="store_true", help="Do not delete rows for files removed from Drive")
    args = ap.parse_args()

    pool.open()
    try:
        stats = run_sync(prune=not args.no_prune)
    finally:
        pool.close()
    logger.info("done: %s", stats)


if __name__ == "__main__":
    main()

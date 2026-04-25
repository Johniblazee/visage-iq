import logging
from pathlib import Path

from psycopg_pool import ConnectionPool
from pgvector.psycopg import register_vector

from backend.config import settings

logger = logging.getLogger(__name__)

INIT_SQL_PATH = Path(__file__).resolve().parent.parent / "scripts" / "init_db.sql"


def _ensure_extension(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
    conn.commit()


def _configure(conn):
    _ensure_extension(conn)
    register_vector(conn)


pool = ConnectionPool(
    conninfo=settings.database_url,
    min_size=1,
    max_size=5,
    configure=_configure,
    open=False,
)


def bootstrap_schema() -> None:
    if not INIT_SQL_PATH.exists():
        logger.warning("init_db.sql not found at %s; skipping schema bootstrap", INIT_SQL_PATH)
        return
    sql = INIT_SQL_PATH.read_text(encoding="utf-8")
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        conn.commit()
    logger.info("schema bootstrap complete")

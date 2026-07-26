"""
core/history.py
Query history storage using SQLite (via Python's built-in sqlite3).
Persists every executed query with timing, result count, and metadata.
"""

import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from dataclasses import dataclass

from utils.logger import get_logger

log = get_logger(__name__)

DB_PATH = Path.home() / ".mongosandbox" / "history.db"


@dataclass
class HistoryEntry:
    id: int
    raw_query: str
    translated_query: str
    status: str              # "ok" | "error" | "empty"
    timing_ms: float
    docs_returned: int
    error_msg: str
    created_at: str          # ISO timestamp
    is_favorite: bool = False
    tags: str = ""           # comma-separated tags
    note: str = ""


class QueryHistory:
    """
    Thread-safe SQLite-backed query history.
    Auto-creates schema on first use.
    """

    _instance: Optional["QueryHistory"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._db_path = DB_PATH
        self._local = threading.local()
        self._init_db()

    @classmethod
    def instance(cls) -> "QueryHistory":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    # ── Internal ──────────────────────────────────────────────────────────

    def _conn(self) -> sqlite3.Connection:
        """Return a per-thread SQLite connection."""
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return self._local.conn

    def _init_db(self) -> None:
        conn = self._conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS history (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                raw_query       TEXT    NOT NULL,
                translated_query TEXT   DEFAULT '',
                status          TEXT    DEFAULT 'ok',
                timing_ms       REAL    DEFAULT 0,
                docs_returned   INTEGER DEFAULT 0,
                error_msg       TEXT    DEFAULT '',
                created_at      TEXT    NOT NULL,
                is_favorite     INTEGER DEFAULT 0,
                tags            TEXT    DEFAULT '',
                note            TEXT    DEFAULT ''
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC)"
        )
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(raw_query, content=history, content_rowid=id)"
        )
        conn.commit()

    # ── Public API ─────────────────────────────────────────────────────────

    def add(self, result) -> int:
        """
        Insert a QueryResult into history.
        Returns the new row id.
        """
        from core.executor import QueryResult
        r: QueryResult = result
        conn = self._conn()
        now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        cur = conn.execute(
            """INSERT INTO history
               (raw_query, translated_query, status, timing_ms, docs_returned, error_msg, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                r.raw_query,
                r.translated_query,
                r.status,
                round(r.timing_ms, 2),
                r.docs_returned,
                r.error,
                now,
            ),
        )
        row_id = cur.lastrowid
        conn.commit()
        # Update FTS
        try:
            conn.execute(
                "INSERT INTO history_fts(rowid, raw_query) VALUES (?, ?)",
                (row_id, r.raw_query),
            )
            conn.commit()
        except Exception:
            pass
        return row_id

    def get_recent(self, limit: int = 100, offset: int = 0) -> list[HistoryEntry]:
        """Return recent history entries, newest first."""
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM history ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [_row_to_entry(r) for r in rows]

    def search(self, query: str, limit: int = 50) -> list[HistoryEntry]:
        """Full-text search across query text."""
        conn = self._conn()
        try:
            rows = conn.execute(
                """SELECT h.* FROM history h
                   JOIN history_fts fts ON h.id = fts.rowid
                   WHERE fts.raw_query MATCH ?
                   ORDER BY h.created_at DESC LIMIT ?""",
                (query, limit),
            ).fetchall()
        except Exception:
            # FTS not available — fall back to LIKE
            rows = conn.execute(
                "SELECT * FROM history WHERE raw_query LIKE ? ORDER BY created_at DESC LIMIT ?",
                (f"%{query}%", limit),
            ).fetchall()
        return [_row_to_entry(r) for r in rows]

    def get_favorites(self) -> list[HistoryEntry]:
        """Return all favorited history entries."""
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM history WHERE is_favorite = 1 ORDER BY created_at DESC"
        ).fetchall()
        return [_row_to_entry(r) for r in rows]

    def set_favorite(self, entry_id: int, favorite: bool) -> None:
        conn = self._conn()
        conn.execute(
            "UPDATE history SET is_favorite = ? WHERE id = ?",
            (1 if favorite else 0, entry_id),
        )
        conn.commit()

    def delete(self, entry_id: int) -> None:
        conn = self._conn()
        conn.execute("DELETE FROM history WHERE id = ?", (entry_id,))
        conn.commit()

    def clear(self) -> None:
        conn = self._conn()
        conn.execute("DELETE FROM history")
        conn.commit()

    def count(self) -> int:
        conn = self._conn()
        return conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]


def _row_to_entry(row: sqlite3.Row) -> HistoryEntry:
    return HistoryEntry(
        id=row["id"],
        raw_query=row["raw_query"],
        translated_query=row["translated_query"] or "",
        status=row["status"],
        timing_ms=row["timing_ms"],
        docs_returned=row["docs_returned"],
        error_msg=row["error_msg"] or "",
        created_at=row["created_at"],
        is_favorite=bool(row["is_favorite"]),
        tags=row["tags"] or "",
        note=row["note"] or "",
    )


# Module-level singleton
query_history = QueryHistory.instance()

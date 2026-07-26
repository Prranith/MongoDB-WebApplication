"""
core/executor.py
Safe query execution engine.
Translates and runs MongoDB shell queries in a restricted sandbox.
All DB calls happen in a QThread to keep the UI non-blocking.
"""

import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from bson import ObjectId, json_util
from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot

from core.translator.translator import translator, TranslationResult
from core.database import db_manager
from utils.config import config
from utils.logger import get_logger

log = get_logger(__name__)

MAX_RESULTS = 10_000   # hard cap on documents returned


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class QueryResult:
    """Encapsulates the outcome of a query execution."""
    status: str                    # "ok" | "error" | "empty"
    data: Any = None               # list[dict] | dict | scalar | None
    error: str = ""
    traceback_str: str = ""
    raw_query: str = ""
    translated_query: str = ""
    translation_method: str = ""
    timing_ms: float = 0.0
    docs_returned: int = 0
    docs_scanned: int = 0
    index_used: str = ""
    truncated: bool = False        # True if result was capped at MAX_RESULTS
    timestamp: datetime = field(default_factory=datetime.utcnow)


# ── Worker signals ────────────────────────────────────────────────────────────

class _WorkerSignals(QObject):
    finished = Signal(object)    # QueryResult
    progress = Signal(str)       # progress message


# ── Runnable worker ───────────────────────────────────────────────────────────

class _QueryWorker(QRunnable):
    """
    Runs in QThreadPool — executes the translated query safely.
    Emits finished(QueryResult) on completion or error.
    """

    def __init__(self, raw_query: str, timeout_s: int = 30) -> None:
        super().__init__()
        self.raw_query = raw_query
        self.timeout_s = timeout_s
        self.signals = _WorkerSignals()
        self.setAutoDelete(True)

    @Slot()
    def run(self) -> None:
        result = _execute(self.raw_query, self.timeout_s)
        self.signals.finished.emit(result)


# ── Main executor ─────────────────────────────────────────────────────────────

class QueryExecutor(QObject):
    """
    High-level executor: translate → execute → return QueryResult.
    Runs queries in background thread pool; emits result_ready signal.
    """

    result_ready = Signal(object)    # QueryResult
    execution_started = Signal(str)  # raw query

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._pool = QThreadPool.globalInstance()
        self._pool.setMaxThreadCount(4)

    def execute_async(self, raw_query: str, timeout_s: int = 30) -> None:
        """Submit a query for async execution. Emits result_ready when done."""
        self.execution_started.emit(raw_query)
        worker = _QueryWorker(raw_query, timeout_s)
        worker.signals.finished.connect(self._on_finished)
        self._pool.start(worker)

    def execute_sync(self, raw_query: str, timeout_s: int = 30) -> QueryResult:
        """Execute synchronously (blocks — for testing only)."""
        return _execute(raw_query, timeout_s)

    @Slot(object)
    def _on_finished(self, result: QueryResult) -> None:
        self.result_ready.emit(result)


# ── Core execution function ───────────────────────────────────────────────────

def _execute(raw_query: str, timeout_s: int = 30) -> QueryResult:
    """
    Core execution:
    1. Translate raw shell query → Python code
    2. Eval in restricted sandbox
    3. Collect results + timing
    """
    if not raw_query.strip():
        return QueryResult(status="error", error="Empty query.", raw_query=raw_query)

    if not db_manager.is_connected():
        return QueryResult(
            status="error",
            error="Not connected to MongoDB. Use File → Connect to connect.",
            raw_query=raw_query,
        )

    # Step 1: Translate
    tr: TranslationResult = translator.translate(raw_query)
    if not tr.success:
        return QueryResult(
            status="error",
            error=f"Translation error: {tr.error}",
            raw_query=raw_query,
            translated_query=tr.translated,
            translation_method=tr.method,
        )

    # Step 2: Execute in sandbox
    def _ISODate(x: str) -> datetime:
        """Accept ISO date strings; strip trailing Z."""
        s = str(x).strip().strip('"').strip("'")
        if s.endswith("Z"):
            s = s[:-1]
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                continue
        raise ValueError(f"ISODate: cannot parse '{x}'")

    safe_locals: dict[str, Any] = {
        "db": db_manager.db,
        "ObjectId": ObjectId,
        "ISODate": _ISODate,
        "datetime": datetime,
        # JS compat aliases (already converted by translator but keep for safety)
        "True": True, "False": False, "None": None,
    }

    t_start = time.perf_counter()
    try:
        result_val = eval(tr.translated, {"__builtins__": {}}, safe_locals)  # noqa: S307
        elapsed_ms = (time.perf_counter() - t_start) * 1000

        return _build_result(
            result_val=result_val,
            raw_query=raw_query,
            translated_query=tr.translated,
            translation_method=tr.method,
            timing_ms=elapsed_ms,
        )

    except Exception as e:
        elapsed_ms = (time.perf_counter() - t_start) * 1000
        tb = traceback.format_exc()
        log.warning("Query execution error", error=str(e))
        return QueryResult(
            status="error",
            error=str(e),
            traceback_str=tb,
            raw_query=raw_query,
            translated_query=tr.translated,
            translation_method=tr.method,
            timing_ms=elapsed_ms,
        )


def _build_result(
    result_val: Any,
    raw_query: str,
    translated_query: str,
    translation_method: str,
    timing_ms: float,
) -> QueryResult:
    """Convert a raw eval result into a structured QueryResult."""
    base = dict(
        raw_query=raw_query,
        translated_query=translated_query,
        translation_method=translation_method,
        timing_ms=timing_ms,
    )

    # Cursor types (find, aggregate)
    if hasattr(result_val, "__iter__") and not isinstance(result_val, (str, bytes, dict)):
        try:
            docs = list(result_val)
        except Exception as e:
            return QueryResult(status="error", error=f"Cursor iteration error: {e}", **base)

        max_results = config.get("max_results", 10000)
        truncated = len(docs) > max_results
        if truncated:
            docs = docs[:max_results]

        if not docs:
            return QueryResult(status="empty", data=[], docs_returned=0, **base)
        return QueryResult(
            status="ok",
            data=docs,
            docs_returned=len(docs),
            truncated=truncated,
            **base,
        )

    # Single document
    if isinstance(result_val, dict):
        return QueryResult(status="ok", data=result_val, docs_returned=1, **base)

    # None
    if result_val is None:
        return QueryResult(status="empty", data=None, docs_returned=0, **base)

    # Scalar (count, distinct array, InsertResult, etc.)
    return QueryResult(status="ok", data=result_val, docs_returned=0, **base)


# Module-level singleton
executor = QueryExecutor()

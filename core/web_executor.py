"""
core/web_executor.py
Web-safe query executor — same logic as core/executor.py but without PySide6/Qt.
Used by the Flask/Vercel API to execute queries synchronously.
"""

import time
import traceback
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any

from bson import ObjectId, json_util

from core.translator.translator import translator, TranslationResult
from core.database import db_manager

MAX_RESULTS = 10_000


@dataclass
class QueryResult:
    """Encapsulates the outcome of a query execution."""
    status: str                    # "ok" | "error" | "empty"
    data: Any = None
    error: str = ""
    traceback_str: str = ""
    raw_query: str = ""
    translated_query: str = ""
    translation_method: str = ""
    timing_ms: float = 0.0
    docs_returned: int = 0
    truncated: bool = False

    def to_dict(self) -> dict:
        def _default(o):
            if isinstance(o, ObjectId):
                return str(o)
            if isinstance(o, datetime):
                return o.isoformat()
            if isinstance(o, bytes):
                return o.hex()
            return str(o)
        raw = asdict(self)
        # Serialize data through bson json_util for ObjectId / Date support
        raw["data"] = json.loads(json_util.dumps(raw["data"]))
        return raw


def execute(raw_query: str, max_results: int = 1000, db: Any = None) -> QueryResult:
    """
    Core synchronous execution (no Qt):
    1. Translate raw shell query → Python code
    2. Eval in restricted sandbox
    3. Collect results + timing
    """
    if not raw_query.strip():
        return QueryResult(status="error", error="Empty query.", raw_query=raw_query)

    if not db_manager.is_connected():
        return QueryResult(status="error", error="Database not connected.", raw_query=raw_query)

    # Translate
    tr: TranslationResult = translator.translate(raw_query)
    if not tr.success:
        return QueryResult(
            status="error",
            error=f"Translation error: {tr.error}",
            raw_query=raw_query,
            translated_query=tr.translated,
            translation_method=tr.method,
        )

    def _ISODate(x: str) -> datetime:
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
        "db": db if db is not None else db_manager.db,
        "ObjectId": ObjectId,
        "ISODate": _ISODate,
        "datetime": datetime,
        "True": True, "False": False, "None": None,
    }

    t_start = time.perf_counter()
    try:
        result_val = eval(tr.translated, {"__builtins__": {}}, safe_locals)  # noqa: S307
        elapsed_ms = (time.perf_counter() - t_start) * 1000
        return _build_result(result_val, raw_query, tr.translated, tr.method, elapsed_ms, max_results)
    except Exception as e:
        elapsed_ms = (time.perf_counter() - t_start) * 1000
        tb = traceback.format_exc()
        return QueryResult(
            status="error",
            error=str(e),
            traceback_str=tb,
            raw_query=raw_query,
            translated_query=tr.translated,
            translation_method=tr.method,
            timing_ms=elapsed_ms,
        )


def _build_result(result_val, raw_query, translated, method, timing_ms, max_results) -> QueryResult:
    base = dict(raw_query=raw_query, translated_query=translated,
                translation_method=method, timing_ms=timing_ms)

    if hasattr(result_val, "__iter__") and not isinstance(result_val, (str, bytes, dict)):
        try:
            docs = list(result_val)
        except Exception as e:
            return QueryResult(status="error", error=f"Cursor error: {e}", **base)
        truncated = len(docs) > max_results
        if truncated:
            docs = docs[:max_results]
        if not docs:
            return QueryResult(status="empty", data=[], docs_returned=0, **base)
        return QueryResult(status="ok", data=docs, docs_returned=len(docs), truncated=truncated, **base)

    if isinstance(result_val, dict):
        return QueryResult(status="ok", data=result_val, docs_returned=1, **base)
    if result_val is None:
        return QueryResult(status="empty", data=None, docs_returned=0, **base)
    return QueryResult(status="ok", data=result_val, docs_returned=0, **base)

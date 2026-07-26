"""
core/formatter.py
Result formatting utilities: BSON-aware JSON serialization,
tree-node construction for the result tree view, and
human-readable summary generation.
"""

import json
from datetime import datetime
from typing import Any

from bson import ObjectId, json_util


def bson_to_json(obj: Any, indent: int = 2) -> str:
    """Serialize a BSON-aware Python object to a JSON string."""
    return json_util.dumps(obj, indent=indent, ensure_ascii=False)


def result_to_display_json(data: Any, indent: int = 2) -> str:
    """
    Convert query result data to a display-ready JSON string.
    Handles ObjectIds, datetimes, and other BSON types.
    """
    if data is None:
        return "null"
    try:
        return json_util.dumps(data, indent=indent, ensure_ascii=False)
    except Exception:
        return str(data)


def build_tree_nodes(data: Any, key: str = "root") -> dict:
    """
    Build a recursive node dict suitable for populating a QTreeWidget.

    Node schema:
    {
        "key": str,
        "value": str,        # display string for leaf nodes
        "type": str,         # "object", "array", "string", "number", "boolean", "null", "date", "objectid"
        "children": [node],  # for object/array types
        "raw": any           # original Python value
    }
    """
    if isinstance(data, list):
        return {
            "key": key,
            "value": f"Array [{len(data)} items]",
            "type": "array",
            "raw": data,
            "children": [build_tree_nodes(item, str(i)) for i, item in enumerate(data)],
        }
    if isinstance(data, dict):
        return {
            "key": key,
            "value": f"Object {{{len(data)} fields}}",
            "type": "object",
            "raw": data,
            "children": [build_tree_nodes(v, k) for k, v in data.items()],
        }
    if isinstance(data, ObjectId):
        return {"key": key, "value": f'ObjectId("{data}")', "type": "objectid", "raw": data, "children": []}
    if isinstance(data, datetime):
        return {"key": key, "value": data.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", "type": "date", "raw": data, "children": []}
    if isinstance(data, bool):
        return {"key": key, "value": str(data).lower(), "type": "boolean", "raw": data, "children": []}
    if isinstance(data, (int, float)):
        return {"key": key, "value": str(data), "type": "number", "raw": data, "children": []}
    if isinstance(data, str):
        return {"key": key, "value": f'"{data}"', "type": "string", "raw": data, "children": []}
    if data is None:
        return {"key": key, "value": "null", "type": "null", "raw": None, "children": []}
    return {"key": key, "value": repr(data), "type": "unknown", "raw": data, "children": []}


def format_timing(ms: float) -> str:
    """Format milliseconds as a short human-readable string."""
    if ms < 1:
        return f"{ms * 1000:.0f}µs"
    if ms < 1000:
        return f"{ms:.1f}ms"
    return f"{ms / 1000:.2f}s"


def format_summary(result) -> str:
    """
    Build a one-line summary string for the console header.
    E.g. "✅ Accepted  ⏱ 12.3ms  📄 3 documents"
    """
    from core.executor import QueryResult
    r: QueryResult = result

    if r.status == "ok":
        icon = "✅"
        status = "Accepted"
    elif r.status == "empty":
        icon = "⚠️"
        status = "Empty result"
    else:
        icon = "❌"
        status = "Error"

    parts = [f"{icon} {status}"]
    if r.timing_ms:
        parts.append(f"⏱ {format_timing(r.timing_ms)}")
    if r.docs_returned:
        label = "document" if r.docs_returned == 1 else "documents"
        parts.append(f"📄 {r.docs_returned:,} {label}")
        if r.truncated:
            parts.append("(truncated)")
    return "  ".join(parts)

"""
utils/helpers.py
Miscellaneous utility functions used across the application.
"""

import re
import json
from datetime import datetime
from typing import Any


def clamp(value: float, minimum: float, maximum: float) -> float:
    """Clamp value between minimum and maximum."""
    return max(minimum, min(maximum, value))


def truncate(text: str, max_len: int = 80, suffix: str = "…") -> str:
    """Truncate text to max_len characters."""
    if len(text) <= max_len:
        return text
    return text[: max_len - len(suffix)] + suffix


def format_bytes(num_bytes: int) -> str:
    """Format byte count as human-readable string (e.g. '1.4 KB')."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PB"


def format_ms(ms: float) -> str:
    """Format milliseconds as human-readable string."""
    if ms < 1:
        return f"{ms * 1000:.0f}µs"
    if ms < 1000:
        return f"{ms:.1f}ms"
    return f"{ms / 1000:.2f}s"


def format_count(n: int) -> str:
    """Format integer with thousands separators."""
    return f"{n:,}"


def safe_json_loads(text: str) -> Any:
    """Try to parse JSON; return None on failure."""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def sanitize_uri(uri: str) -> str:
    """Remove password from a MongoDB URI for safe logging."""
    return re.sub(r"(://[^:]+:)[^@]+(@)", r"\1****\2", uri)


def now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def camel_to_title(name: str) -> str:
    """Convert camelCase or snake_case to Title Case."""
    name = re.sub(r"([A-Z])", r" \1", name)
    name = name.replace("_", " ")
    return name.strip().title()


def indent_json(obj: Any, indent: int = 2) -> str:
    """Pretty-print any object as JSON string."""
    try:
        return json.dumps(obj, indent=indent, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(obj)


def chunk_list(lst: list, size: int) -> list[list]:
    """Split list into chunks of at most `size` elements."""
    return [lst[i : i + size] for i in range(0, len(lst), size)]


# Alias used by some modules
format_timing = format_ms

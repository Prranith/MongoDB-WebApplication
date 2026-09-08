"""
services/shared/pagination.py
Pagination helpers: cursor-based (keyset) pagination + offset fallback caps.

This module standardizes pagination response shapes and provides utilities to
build cursor queries using "limit + after_id / after_created_at" cursors.

Existing endpoints are not changed by default. New pagination is applied
incrementally by calling these helpers.
"""

from __future__ import annotations

import base64
import json as _json
import typing as t

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "pagination")

# ---------------------------------------------------------------------------
# Cursor encoding/decoding
# ---------------------------------------------------------------------------

def encode_cursor(payload: t.Dict[str, t.Any]) -> str:
    """Encode a pagination cursor as a stable opaque string."""
    payload = {
        k: v for k, v in payload.items()
        if v is not None
    }
    raw = _json.dumps(payload, sort_keys=True, default=str)
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("utf-8")


def decode_cursor(cursor: str) -> t.Dict[str, t.Any]:
    """Decode an opaque pagination cursor into its components."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("utf-8")).decode("utf-8")
        return _json.loads(raw)
    except Exception as exc:
        raise ValueError("Invalid pagination cursor") from exc


# ---------------------------------------------------------------------------
# Cursor types
# ---------------------------------------------------------------------------

CursorField = t.Literal["id", "created_at", "updated_at", "seq"]


def build_cursor_query(
    *,
    limit: int,
    after_id: t.Optional[t.Any] = None,
    after_created_at: t.Optional[t.Any] = None,
    after_seq: t.Optional[t.Any] = None,
    sort_field: CursorField = "id",
) -> t.Dict[str, t.Any]:
    """Return a keyset pagination filter dict for a paginated query.

    This is a building block for repository methods; it does not execute queries.
    """

    filter_: t.Dict[str, t.Any] = {}
    if after_id is not None:
        filter_["id_gt" if sort_field == "id" else "_id_gt"] = after_id
    if after_created_at is not None:
        filter_["created_at_gt" if sort_field == "created_at" else "ts_gt"] = after_created_at
    if after_seq is not None:
        filter_["seq_gt" if sort_field == "seq" else "sequence_gt"] = after_seq

    return {
        "limit": limit,
        "filter": filter_,
        "sort": [(sort_field, 1)],
    }


# ---------------------------------------------------------------------------
# Pagination response shape
# ---------------------------------------------------------------------------

class PageMeta(t.NamedTuple):
    next_cursor: t.Optional[str]
    has_more: bool
    total_approx: t.Optional[int]


def paginate_result(
    rows: t.Sequence[t.Dict[str, t.Any]],
    *,
    limit: int,
    cursor_fields: t.Sequence[str] = ("id",),
    encode: bool = True,
) -> t.Tuple[t.List[t.Dict[str, t.Any]], PageMeta]:
    """Convert a fetched page of rows into a paginated result with cursor metadata.

    This assumes rows are already ordered by the cursor fields.
    """
    items = list(rows)
    has_more = len(items) > limit
    if has_more:
        items = items[:limit]

    next_cursor = None
    if items and has_more:
        last = items[-1]
        cursor_payload = {f: last.get(f) for f in cursor_fields if f in last}
        if cursor_payload:
            next_cursor = encode_cursor(cursor_payload) if encode else cursor_payload

    return items, PageMeta(
        next_cursor=next_cursor,
        has_more=has_more,
        total_approx=None,
    )


# ---------------------------------------------------------------------------
# Offset fallback with strict caps
# ---------------------------------------------------------------------------

MAX_OFFSET_PAGE_SIZE = 100
DEFAULT_OFFSET_PAGE_SIZE = 20


def sanitize_offset_pagination(
    *,
    page: int = 1,
    page_size: int = DEFAULT_OFFSET_PAGE_SIZE,
    max_page_size: int = MAX_OFFSET_PAGE_SIZE,
) -> t.Dict[str, int]:
    """Return sanitized pagination params for offset pagination."""
    page = max(1, int(page))
    page_size = max(1, min(int(page_size), max_page_size))
    skip = (page - 1) * page_size
    return {"page": page, "page_size": page_size, "skip": skip}


def offset_page_meta(
    total_count: int,
    *,
    page: int,
    page_size: int,
) -> PageMeta:
    has_more = (page * page_size) < total_count
    next_cursor = None
    if has_more:
        next_cursor = encode_cursor({"page": page + 1, "page_size": page_size})
    return PageMeta(
        next_cursor=next_cursor,
        has_more=has_more,
        total_approx=total_count,
    )

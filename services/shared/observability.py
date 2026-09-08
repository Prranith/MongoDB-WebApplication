"""
services/shared/observability.py
Lightweight correlation-id propagation helpers for the Flask blueprints.

Does not change any existing business logic. It only provides a small API
to extract, generate, and propagate X-Correlation-ID values and to attach
them to logs.
"""

from __future__ import annotations

import typing as t

from utils.logger import get_logger, set_correlation_id, clear_context, bind_component, get_correlation_id

if t.TYPE_CHECKING:
    from flask import Request, Response


def extract_correlation_id(request: t.Any) -> t.Optional[str]:
    """Extract X-Correlation-ID from a Flask request object (if present)."""
    if not request:
        return None
    return request.headers.get("X-Correlation-ID")


def next_correlation_id() -> str:
    """Generate a new correlation id (used when the gateway does not supply one)."""
    return set_correlation_id()


def current_correlation_id() -> t.Optional[str]:
    """Return the currently active correlation id for logging / message headers."""
    return get_correlation_id()


def attach_trace_id_to_headers(headers: t.Dict[str, str]) -> t.Dict[str, str]:
    """Return a copy of headers with an X-Correlation-ID propagated if missing."""
    out = dict(headers or {})
    if not out.get("X-Correlation-ID"):
        out["X-Correlation-ID"] = current_correlation_id() or ""
    return out

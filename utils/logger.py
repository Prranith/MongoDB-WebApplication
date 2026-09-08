"""
utils/logger.py
Structured JSON logging + correlation/trace id propagation.
All modules import get_logger from here.
"""

import logging
import sys
import uuid
import structlog
from pathlib import Path
from typing import Optional

# Module-level context so correlation ids survive across async workers / threads
_context = {
    "correlation_id": None,
    "component": None,
    "request_id": None,
}


def setup_logging(
    level: str = "INFO",
    log_file: Optional[Path] = None,
    json_logs: bool = False,
) -> None:
    """Configure structlog with console (and optional file) output.

    When json_logs=True, logs are emitted as structured JSON lines suitable
    for aggregation in production.
    """
    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]

    if json_logs:
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=True)

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.dev.ConsoleRenderer(colors=True) if not json_logs else structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(level.upper())
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
    )

    # Optional file handler
    if log_file:
        log_file = Path(log_file)
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        root = logging.getLogger()
        root.addHandler(file_handler)
        root.setLevel(logging.DEBUG)


def get_logger(name: str = __name__) -> structlog.BoundLogger:
    """Return a bound structlog logger for the given module name."""
    return structlog.get_logger(name)


def set_correlation_id(correlation_id: Optional[str] = None, *, request_id: Optional[str] = None) -> str:
    """Set or generate a correlation id for the current execution context.

    Returns the effective correlation id. This is safe to call per-request
    and should be invoked at the API gateway / blueprint entry layer.
    """
    cid = correlation_id or uuid.uuid4().hex
    _context["correlation_id"] = cid
    if request_id:
        _context["request_id"] = request_id
    return cid


def get_correlation_id() -> Optional[str]:
    """Return the current correlation id, if any."""
    return _context.get("correlation_id")


def clear_context() -> None:
    """Clear context after a request completes (optional cleanup)."""
    _context["correlation_id"] = None
    _context["request_id"] = None
    _context["component"] = None


def bind_component(logger: structlog.BoundLogger, component: str) -> structlog.BoundLogger:
    """Attach a stable component name for easier log filtering in production."""
    _context["component"] = component
    return logger.bind(component=component)
